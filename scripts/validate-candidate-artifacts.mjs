#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

import { canonicalStringify } from '../src/canonical-json.mjs';
import { expectedBuildInputs } from '../src/build-inputs.mjs';
import { CURRENT_VALIDATION_SCHEMA, validatePublishedState } from '../src/change-detection.mjs';
import {
  HARDWARE_CAPABILITY_ASSET,
  HARDWARE_CAPABILITY_RECIPE_PATH,
  validateHardwareCapabilityEvidence,
} from '../src/hardware-capabilities.mjs';
import { sourceTreeFingerprint } from '../src/source-tree.mjs';
import { validateUbootBuild } from '../src/uboot-build.mjs';
import {
  EXPECTED_RTL8189FS_ALIAS,
  EXPECTED_RTL8189FS_MODULE_PATH,
} from '../src/rtl8189fs.mjs';

const DTB_BUILD_EVIDENCE = 'source-built-dtb.json';
const DTB_SOURCE_EVIDENCE = 'device-tree-source.dts';
const QEMU_SMOKE_EVIDENCE = 'qemu-system-smoke.json';
const QEMU_CONSOLE_EVIDENCE = 'qemu-system-smoke.log';
const RTL8189FS_EVIDENCE = 'rtl8189fs-driver.json';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function sha256GzipPayload(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path).pipe(createGunzip())) hash.update(chunk);
  return hash.digest('hex');
}

function readChecksum(path, imageName) {
  const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error('SHA256SUMS must contain exactly one image entry');
  const match = lines[0].match(/^([0-9a-f]{64})  (.+)$/i);
  if (!match || match[2] !== imageName) throw new Error('SHA256SUMS is not bound to the candidate image');
  return match[1].toLowerCase();
}

function validateBootComponents(value) {
  if (value?.schemaVersion !== 2 || !Array.isArray(value.components)) {
    throw new Error('boot component evidence is malformed');
  }
  const roles = new Set();
  for (const component of value.components) {
    if (typeof component?.role !== 'string' || typeof component?.path !== 'string'
      || component.path.startsWith('/') || component.path.split('/').includes('..')
      || !Number.isInteger(component.size) || component.size <= 0
      || !/^[0-9a-f]{64}$/.test(component.sha256)) {
      throw new Error('boot component evidence is malformed');
    }
    roles.add(component.role);
  }
  for (const role of [
    'kernel',
    'initrd',
    'dtb',
    'uboot-overload',
    'boot-script-primary',
    'boot-script-installer',
    'boot-config',
  ]) {
    if (!roles.has(role)) throw new Error(`boot component evidence is missing ${role}`);
  }
  return value.components;
}

function validateDtbBuild(value, manifest) {
  const expected = manifest.board.dtbBuild;
  if (value?.schemaVersion !== 1 || !expected || value.source?.repository !== expected.repository
    || value.source?.path !== expected.sourcePath || value.source?.commit !== expected.commit
    || value.source?.url !== expected.rawSourceUrl || value.source?.sha256 !== expected.sourceSha256
    || value.source?.license !== expected.license || value.recipe?.compiler !== 'dtc'
    || value.recipe?.compatible !== 'amlogic,p212'
    || value.recipe?.sourceDateEpoch !== expected.sourceDateEpoch
    || value.recipe?.reproducibleFromSource !== true
    || value.recipe?.semanticChecks?.wifiCompatible !== 'realtek,rtl8189ftv'
    || value.recipe?.semanticChecks?.sdioMaxFrequencyHz !== 200000000
    || value.recipe?.semanticChecks?.resetGpioCell !== 0x4c
    || value.recipe?.semanticChecks?.cmaBytes !== 64 * 1024 * 1024
    || value.sourceEvidence?.name !== DTB_SOURCE_EVIDENCE
    || value.sourceEvidence?.sha256 !== expected.sourceSha256
    || value.artifact?.name !== manifest.board.dtb
    || !Number.isInteger(value.artifact?.size) || value.artifact.size <= 0
    || !/^[0-9a-f]{64}$/.test(value.artifact?.sha256 ?? '')) {
    throw new Error('source-built DTB evidence does not match manifest provenance');
  }
  return value;
}

function validateRtl8189fsEvidence(value, manifest) {
  const expectedReleasePrefix = `${manifest.sources.kernel.version}-`;
  const kernelReleasePattern = /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
  if (typeof value?.kernelRelease !== 'string'
    || !kernelReleasePattern.test(value.kernelRelease)
    || !value.kernelRelease.startsWith(expectedReleasePrefix)
    || value.modulePath !== EXPECTED_RTL8189FS_MODULE_PATH
    || value.moduleName !== '8189fs'
    || value.sdioAlias !== EXPECTED_RTL8189FS_ALIAS
    || typeof value.vermagic !== 'string'
    || !value.vermagic.startsWith(`${value.kernelRelease} `)
    || !/\baarch64\b/.test(value.vermagic)
    || typeof value.moduleFileType !== 'string'
    || !/ELF 64-bit LSB relocatable, ARM aarch64/i.test(value.moduleFileType)
    || !/^[0-9a-f]{64}$/i.test(value.moduleSha256 ?? '')
    || !/^[0-9a-f]{64}$/i.test(value.modulesAliasSha256 ?? '')
    || !/^[0-9a-f]{64}$/i.test(value.modulesDepSha256 ?? '')) {
    throw new Error('RTL8189FS evidence does not match the candidate kernel');
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateSourceArchive(path, expectedTreeSha256) {
  const members = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const member of members) {
    const normalized = member.replace(/^\.\//, '');
    if (member.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`U-Boot source archive contains an unsafe path: ${member}`);
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'uboot-source-'));
  try {
    execFileSync('tar', ['-xzf', path, '-C', directory]);
    if (sourceTreeFingerprint(directory) !== expectedTreeSha256) {
      throw new Error('U-Boot source archive tree digest does not match build evidence');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function isSafeRelativePath(value) {
  return typeof value === 'string' && /^[-A-Za-z0-9._/]+$/.test(value)
    && !value.startsWith('/') && !value.split('/').includes('..');
}

function matchesOneComponent(components, role, path, sha256) {
  return components.filter((component) => component.role === role
    && component.path === path && component.sha256 === sha256).length === 1;
}

async function validateQemuSystemEvidence(root, report, manifest, rawSha256, components) {
  const evidence = report.evidence;
  if (evidence.qemuSystemSmoke !== QEMU_SMOKE_EVIDENCE
    || evidence.qemuSystemConsole !== QEMU_CONSOLE_EVIDENCE) {
    throw new Error('QEMU system smoke evidence names are invalid');
  }
  const smokePath = join(root, QEMU_SMOKE_EVIDENCE);
  const consolePath = join(root, QEMU_CONSOLE_EVIDENCE);
  if (await sha256File(smokePath) !== evidence.qemuSystemSmokeSha256
    || await sha256File(consolePath) !== evidence.qemuSystemConsoleSha256) {
    throw new Error('QEMU system smoke evidence digest does not match validation report');
  }
  const smoke = readJson(smokePath);
  const expectedReleasePrefix = `${manifest.sources.kernel.version}-`;
  const kernelReleasePattern = /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
  const markerPattern = /^B860_QEMU_KERNEL_RELEASE_[0-9a-f]{32}$/;
  if (smoke.schemaVersion !== 2 || smoke.status !== 'passed' || smoke.machine !== 'virt'
    || smoke.cpu !== 'cortex-a53' || smoke.manifestFingerprint !== manifest.fingerprint
    || smoke.rawSha256 !== rawSha256 || smoke.rawSha256 !== report.rawSha256
    || smoke.consoleLog !== QEMU_CONSOLE_EVIDENCE
    || !isSafeRelativePath(smoke.kernelPath) || !isSafeRelativePath(smoke.initrdPath)
    || !/^[0-9a-f]{64}$/.test(smoke.kernelSourceSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(smoke.kernelSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(smoke.initrdSourceSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(smoke.initrdSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(smoke.consoleLogSha256 ?? '')
    || !kernelReleasePattern.test(smoke.kernelRelease ?? '')
    || !smoke.kernelRelease.startsWith(expectedReleasePrefix)
    || !markerPattern.test(smoke.kernelReleaseMarker ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(smoke.rootUuid ?? '')
    || typeof smoke.qemuVersion !== 'string' || smoke.qemuVersion.length === 0
    || smoke.consoleLogSha256 !== evidence.qemuSystemConsoleSha256) {
    throw new Error('QEMU system smoke evidence is malformed or unbound');
  }
  if (!matchesOneComponent(components, 'kernel', smoke.kernelPath, smoke.kernelSourceSha256)
    || !matchesOneComponent(components, 'initrd', smoke.initrdPath, smoke.initrdSourceSha256)) {
    throw new Error('QEMU system smoke inputs do not match active boot components');
  }
  const console = readFileSync(consolePath, 'utf8');
  const releasePattern = new RegExp(
    `^${escapeRegExp(smoke.kernelReleaseMarker)}_(${kernelReleasePattern.source.slice(1, -1)})\\r?$`,
    'gm',
  );
  const releaseMarkers = [...console.matchAll(releasePattern)];
  if (releaseMarkers.length !== 1 || releaseMarkers[0][1] !== smoke.kernelRelease) {
    throw new Error('QEMU kernel release marker is missing or invalid');
  }
  if (!/^B860_QEMU_SYSTEM_SMOKE_OK\r?$/m.test(console)) {
    throw new Error('QEMU system smoke success marker is missing');
  }
  return smoke.kernelRelease;
}

export async function validateCandidateArtifacts(directory, expectedFingerprint) {
  if (!/^[0-9a-f]{64}$/i.test(expectedFingerprint)) throw new Error('expected fingerprint is invalid');
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const images = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.img.gz'));
  if (images.length !== 1) throw new Error(`expected exactly one candidate image, found ${images.length}`);

  const imageName = images[0].name;
  if (!/^Armbian_[A-Za-z0-9._+-]+\.img\.gz$/.test(imageName)) {
    throw new Error('candidate does not use an Armbian image name');
  }
  const imagePath = join(root, imageName);
  const checksum = readChecksum(join(root, 'SHA256SUMS'), imageName);
  const manifest = readJson(join(root, 'resolved-sources.json'));
  const report = readJson(join(root, 'validation-report.json'));
  const validatedManifest = validatePublishedState(manifest, report);
  if ((validatedManifest.schemaVersion >= 5 && report.schemaVersion !== CURRENT_VALIDATION_SCHEMA)
    || (validatedManifest.schemaVersion < 5 && report.schemaVersion >= 7)
    || ![6, CURRENT_VALIDATION_SCHEMA].includes(report.schemaVersion)) {
    throw new Error(`candidate manifest and validation report schemas are mismatched; current report schema is ${CURRENT_VALIDATION_SCHEMA}`);
  }
  if (validatedManifest.fingerprint.toLowerCase() !== expectedFingerprint.toLowerCase()) {
    throw new Error('candidate manifest fingerprint does not match detector output');
  }
  const buildInputs = readJson(join(root, 'build-input-heads.json'));
  if (canonicalStringify(buildInputs) !== canonicalStringify(expectedBuildInputs(validatedManifest))) {
    throw new Error('build input heads do not match the candidate manifest');
  }
  const reportImage = typeof report.image === 'string' ? basename(report.image) : '';
  if (reportImage !== imageName) throw new Error('validation report is not bound to the candidate image');

  const imageSha256 = await sha256File(imagePath);
  if (imageSha256 !== report.imageSha256) throw new Error('candidate image digest does not match validation report');
  if (imageSha256 !== checksum) throw new Error('candidate image digest does not match SHA256SUMS');
  const rawSha256 = report.schemaVersion >= CURRENT_VALIDATION_SCHEMA
    ? await sha256GzipPayload(imagePath)
    : null;
  if (rawSha256 !== null && rawSha256 !== report.rawSha256) {
    throw new Error('candidate raw image digest does not match validation report');
  }
  const filesystemManifestPath = join(root, report.evidence.filesystemManifest);
  const filesystemManifestSha256 = await sha256File(filesystemManifestPath);
  if (filesystemManifestSha256 !== report.evidence.filesystemManifestSha256) {
    throw new Error('filesystem manifest digest does not match validation report');
  }
  const filesystemManifest = readFileSync(filesystemManifestPath, 'utf8');
  if (!/^[0-9a-f]{64}  \.\//m.test(filesystemManifest)) {
    throw new Error('filesystem manifest is malformed');
  }
  const bootComponentsPath = join(root, report.evidence.bootComponents);
  const bootComponentsSha256 = await sha256File(bootComponentsPath);
  if (bootComponentsSha256 !== report.evidence.bootComponentsSha256) {
    throw new Error('boot components digest does not match validation report');
  }
  const bootComponentEvidence = readJson(bootComponentsPath);
  const components = validateBootComponents(bootComponentEvidence);
  let qemuKernelRelease = null;
  if (report.schemaVersion >= CURRENT_VALIDATION_SCHEMA) {
    qemuKernelRelease = await validateQemuSystemEvidence(
      root,
      report,
      validatedManifest,
      rawSha256,
      components,
    );
  }
  let rtl8189fsEvidence = null;
  let rtl8189fsEvidenceSha256 = null;
  if (report.evidence.rtl8189fsDriver !== undefined) {
    if (report.evidence.rtl8189fsDriver !== RTL8189FS_EVIDENCE) {
      throw new Error('RTL8189FS evidence name is invalid');
    }
    const driverPath = join(root, RTL8189FS_EVIDENCE);
    rtl8189fsEvidenceSha256 = await sha256File(driverPath);
    if (rtl8189fsEvidenceSha256 !== report.evidence.rtl8189fsDriverSha256) {
      throw new Error('RTL8189FS evidence digest does not match validation report');
    }
    const driver = validateRtl8189fsEvidence(readJson(driverPath), validatedManifest);
    rtl8189fsEvidence = driver;
    if (qemuKernelRelease !== driver.kernelRelease) {
      throw new Error('RTL8189FS evidence does not match QEMU kernel release');
    }
    const filesystemEntries = [
      [driver.moduleSha256, `./usr/lib/modules/${driver.kernelRelease}/${driver.modulePath}`, 'module'],
      [driver.modulesAliasSha256, `./usr/lib/modules/${driver.kernelRelease}/modules.alias`, 'modules.alias'],
      [driver.modulesDepSha256, `./usr/lib/modules/${driver.kernelRelease}/modules.dep`, 'modules.dep'],
    ];
    for (const [sha256, filePath, label] of filesystemEntries) {
      const matches = filesystemManifest.split(/\r?\n/)
        .filter((line) => line.endsWith(`  ${filePath}`));
      if (matches.length !== 1 || matches[0] !== `${sha256.toLowerCase()}  ${filePath}`) {
        throw new Error(`RTL8189FS ${label} hash does not match filesystem manifest`);
      }
    }
  }
  if (report.schemaVersion >= 7) {
    const dtbEvidence = report.evidence.sourceBuiltDeviceTree;
    const dtbBuildPath = join(root, DTB_BUILD_EVIDENCE);
    if (await sha256File(dtbBuildPath) !== dtbEvidence.buildSha256) {
      throw new Error('source-built DTB evidence digest does not match validation report');
    }
    const dtbBuild = validateDtbBuild(readJson(dtbBuildPath), validatedManifest);
    const dtbSourcePath = join(root, DTB_SOURCE_EVIDENCE);
    const dtbSourceSha256 = await sha256File(dtbSourcePath);
    if (dtbSourceSha256 !== dtbEvidence.sourceSha256
      || dtbSourceSha256 !== validatedManifest.board.dtbBuild.sourceSha256) {
      throw new Error('device tree source digest does not match manifest provenance');
    }
    const deviceTrees = components.filter(({ role }) => role === 'dtb');
    if (deviceTrees.length !== 1
      || deviceTrees[0].path !== `dtb/amlogic/${validatedManifest.board.dtb}`
      || deviceTrees[0].sha256 !== dtbBuild.artifact.sha256
      || deviceTrees[0].size !== dtbBuild.artifact.size) {
      throw new Error('DTB component evidence does not match source build');
    }
  }
  if (report.evidence.hardwareCapabilities !== undefined) {
    if (report.evidence.hardwareCapabilities !== HARDWARE_CAPABILITY_ASSET) {
      throw new Error('hardware capability evidence name is invalid');
    }
    const hardwarePath = join(root, HARDWARE_CAPABILITY_ASSET);
    if (await sha256File(hardwarePath) !== report.evidence.hardwareCapabilitiesSha256) {
      throw new Error('hardware capability evidence digest does not match validation report');
    }
    const recipeUrl = new URL('../config/hardware-capabilities.json', import.meta.url);
    const recipeSource = readFileSync(recipeUrl);
    const recipeSha256 = createHash('sha256').update(recipeSource).digest('hex');
    if (validatedManifest.recipe.files[HARDWARE_CAPABILITY_RECIPE_PATH] !== recipeSha256) {
      throw new Error('hardware capability recipe digest does not match trusted validator');
    }
    validateHardwareCapabilityEvidence(readJson(hardwarePath), {
      recipe: JSON.parse(recipeSource),
      manifest: validatedManifest,
      filesystemManifest,
      bootComponents: bootComponentEvidence,
      rtl8189fsEvidence,
      rtl8189fsEvidenceSha256,
    });
  }
  const ubootBuildPath = join(root, report.evidence.ubootBuild);
  const ubootBuildSha256 = await sha256File(ubootBuildPath);
  if (ubootBuildSha256 !== report.evidence.ubootBuildSha256) {
    throw new Error('U-Boot build evidence digest does not match validation report');
  }
  const ubootBuild = validateUbootBuild(readJson(ubootBuildPath), validatedManifest);
  const sourceArchivePath = join(root, report.evidence.ubootSourceArchive);
  const sourceArchiveSha256 = await sha256File(sourceArchivePath);
  if (sourceArchiveSha256 !== report.evidence.ubootSourceArchiveSha256
    || sourceArchiveSha256 !== ubootBuild.sourceArchive.sha256) {
    throw new Error('U-Boot source archive digest does not match validation evidence');
  }
  if (statSync(sourceArchivePath).size !== ubootBuild.sourceArchive.size) {
    throw new Error('U-Boot source archive size does not match build evidence');
  }
  validateSourceArchive(sourceArchivePath, ubootBuild.sourceArchive.treeSha256);
  const thirdPartySourcesPath = join(root, report.evidence.thirdPartySources);
  if (await sha256File(thirdPartySourcesPath) !== report.evidence.thirdPartySourcesSha256) {
    throw new Error('third-party source document digest does not match validation report');
  }
  const expectedOverload = ubootBuild.artifact;
  const overloads = components.filter(({ role }) => role === 'uboot-overload');
  if (overloads.length !== 1 || basename(overloads[0].path) !== validatedManifest.board.ubootOverload
    || overloads[0].sha256 !== expectedOverload.sha256
    || overloads[0].size !== expectedOverload.size) {
    throw new Error('U-Boot overload evidence does not match manifest provenance');
  }
  const derived = components.filter(({ role }) => role === 'uboot-overload-derived');
  if (derived.length !== 1 || derived.some((entry) => basename(entry.path) !== 'u-boot.ext'
    || entry.sha256 !== expectedOverload.sha256
    || entry.size !== expectedOverload.size)) {
    throw new Error('derived U-Boot evidence does not match overload bytes');
  }
  const primaryScripts = components.filter(({ role }) => role === 'boot-script-primary');
  if (primaryScripts.length !== 1 || primaryScripts[0].path !== 's905_autoscript') {
    throw new Error('primary boot script evidence is missing or invalid');
  }
  const installerScripts = components.filter(({ role }) => role === 'boot-script-installer');
  if (installerScripts.length !== 1 || installerScripts[0].path !== 'aml_autoscript') {
    throw new Error('installer boot script evidence is missing or invalid');
  }
  return { imageName, imageSha256, manifest: validatedManifest, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , directory, expectedFingerprint] = process.argv;
  if (!directory || !expectedFingerprint) {
    process.stderr.write('usage: validate-candidate-artifacts.mjs out expected-fingerprint\n');
    process.exitCode = 2;
  } else {
    validateCandidateArtifacts(directory, expectedFingerprint)
      .then(({ imageName, imageSha256 }) => process.stdout.write(`${JSON.stringify({ imageName, imageSha256 })}\n`))
      .catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}
