import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { expectedBuildInputs } from '../src/build-inputs.mjs';
import { sourceTreeFingerprint } from '../src/source-tree.mjs';
import { buildManifest } from '../src/upstream.mjs';
import { validatePublishedState } from '../src/change-detection.mjs';
import {
  HARDWARE_CAPABILITY_RECIPE_PATH,
  evaluateHardwareCapabilities,
} from '../src/hardware-capabilities.mjs';
import {
  EXPECTED_RTL8189FS_ALIAS,
  EXPECTED_RTL8189FS_MODULE_PATH,
} from '../src/rtl8189fs.mjs';

const manifestFixture = new URL('./fixtures/valid-resolved-sources.json', import.meta.url);
const validatorModule = new URL('../scripts/validate-candidate-artifacts.mjs', import.meta.url);

const checks = {
  gzip: true,
  partitionTable: true,
  fatBoot: true,
  ext4Rootfs: true,
  debianStableRelease: true,
  debianIdentity: true,
  armbianIdentity: true,
  bootFiles: true,
  memoryLimitApplied: true,
  stockBootScriptStaticPathValid: true,
  primaryBootScriptAndroidFallbackAbsent: true,
  installerBootScriptAndroidFallbackAbsent: true,
  kernelArchitecture: true,
  dtbCompatible: true,
  rootfsLabel: true,
  userspaceSmoke: true,
  packageState: true,
  sshUnit: true,
  imageFits8GB: true,
  mbrBootstrapEmpty: true,
  mbrReservedBytesEmpty: true,
  partitionStartMatchesManifest: true,
  persistentBootloaderAbsent: true,
  bootloaderPayloadsExcluded: true,
  legacyUbootPayloadsAbsent: true,
  knownAndroidMarkersAbsent: true,
  initrdKnownAndroidMarkersAbsent: true,
  bootConfigKnownAndroidMarkersAbsent: true,
  dtbKnownAndroidMarkersAbsent: true,
  filesystemManifestCreated: true,
  bootComponentsRecorded: true,
  ubootOverloadProvenance: true,
  sourceBuiltUbootOverload: true,
};

function createCandidate(t, { schema8 = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-candidate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let manifest = JSON.parse(fs.readFileSync(manifestFixture, 'utf8'));
  const hardwareRecipe = schema8
    ? JSON.parse(fs.readFileSync(new URL('../config/hardware-capabilities.json', import.meta.url), 'utf8'))
    : null;
  const hardwareRecipeSha256 = schema8
    ? createHash('sha256').update(fs.readFileSync(new URL('../config/hardware-capabilities.json', import.meta.url))).digest('hex')
    : null;
  if (schema8) {
    const board = JSON.parse(fs.readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'));
    manifest = buildManifest({
      ...manifest,
      schemaVersion: 5,
      board: { ...manifest.board, dtb: board.dtb, dtbBuild: board.dtbBuild },
      recipe: {
        ...manifest.recipe,
        files: {
          ...manifest.recipe.files,
          [HARDWARE_CAPABILITY_RECIPE_PATH]: hardwareRecipeSha256,
          'scripts/validate-rtl8189fs.mjs': 'a'.repeat(64),
          'src/rtl8189fs.mjs': 'b'.repeat(64),
        },
      },
    });
  }
  const imageName = 'Armbian_test.img.gz';
  const image = path.join(directory, imageName);
  const contents = Buffer.from('validated candidate image');
  const imageBytes = schema8 ? gzipSync(contents, { mtime: 0 }) : contents;
  const digest = createHash('sha256').update(imageBytes).digest('hex');
  const rawDigest = createHash('sha256').update(contents).digest('hex');
  const configRelative = 'usr/src/linux-headers-5.10.260-ophub/include/config/auto.conf';
  const configBody = schema8
    ? `${Object.entries(Object.assign({}, ...Object.values(hardwareRecipe.capabilities).map((capability) => capability.kernelConfig)))
      .map(([key, value]) => `${key}=${value}`).join('\n')}\n`
    : null;
  const configSha256 = schema8 ? createHash('sha256').update(configBody).digest('hex') : null;
  const filesystemManifest = schema8
    ? `${'1'.repeat(64)}  ./etc/os-release\n${configSha256}  ./${configRelative}\n${'2'.repeat(64)}  ./usr/lib/modules/5.10.260-ophub/${EXPECTED_RTL8189FS_MODULE_PATH}\n${'3'.repeat(64)}  ./usr/lib/modules/5.10.260-ophub/modules.alias\n${'4'.repeat(64)}  ./usr/lib/modules/5.10.260-ophub/modules.dep\n`
    : `${'1'.repeat(64)}  ./etc/os-release\n`;
  const thirdPartySources = '# Third-party source availability\n';
  const dtbSource = schema8
    ? fs.readFileSync(new URL('./fixtures/source-built-b860av11t.dts', import.meta.url))
    : null;
  const overloadSha256 = '5'.repeat(64);
  const overloadSize = 646455;
  const sourceDirectory = path.join(directory, 'source-tree');
  const sourceArchivePath = path.join(directory, 'u-boot-source.tar.gz');
  fs.mkdirSync(sourceDirectory);
  fs.writeFileSync(path.join(sourceDirectory, 'README'), 'patched source\n');
  execFileSync('tar', ['-czf', sourceArchivePath, '-C', sourceDirectory, '.']);
  const sourceArchive = fs.readFileSync(sourceArchivePath);
  const sourceArchiveDigest = createHash('sha256').update(sourceArchive).digest('hex');
  const ubootBuild = `${JSON.stringify({
    schemaVersion: 1,
    source: {
      repository: manifest.sources.ubootSource.repository,
      ref: manifest.sources.ubootSource.ref,
      commit: manifest.sources.ubootSource.commit,
    },
    recipe: {
      patch: manifest.board.ubootOverloadBuild.patch,
      patchSha256: manifest.board.ubootOverloadBuild.patchSha256,
      defconfig: manifest.board.ubootOverloadBuild.defconfig,
      output: manifest.board.ubootOverloadBuild.output,
      crossCompile: manifest.board.ubootOverloadBuild.crossCompile,
      sourceDateEpoch: manifest.board.ubootOverloadBuild.sourceDateEpoch,
    },
    artifact: { name: manifest.board.ubootOverload, size: overloadSize, sha256: overloadSha256 },
    sourceArchive: {
      name: 'u-boot-source.tar.gz',
      size: sourceArchive.length,
      sha256: sourceArchiveDigest,
      treeSha256: sourceTreeFingerprint(sourceDirectory),
    },
    environment: { arch: 'arm', configSha256: '9'.repeat(64), compiler: 'test compiler' },
  })}\n`;
  const dtbBuild = schema8 ? `${JSON.stringify({
    schemaVersion: 1,
    source: {
      repository: manifest.board.dtbBuild.repository,
      path: manifest.board.dtbBuild.sourcePath,
      commit: manifest.board.dtbBuild.commit,
      url: manifest.board.dtbBuild.rawSourceUrl,
      sha256: manifest.board.dtbBuild.sourceSha256,
      license: manifest.board.dtbBuild.license,
    },
    recipe: {
      compiler: 'dtc',
      compatible: 'amlogic,p212',
      sourceDateEpoch: 0,
      reproducibleFromSource: true,
      semanticChecks: {
        wifiCompatible: 'realtek,rtl8189ftv',
        sdioMaxFrequencyHz: 200000000,
        resetGpioCell: 0x4c,
        cmaBytes: 64 * 1024 * 1024,
      },
    },
    sourceEvidence: {
      name: 'device-tree-source.dts',
      sha256: manifest.board.dtbBuild.sourceSha256,
    },
    artifact: { name: manifest.board.dtb, size: 1, sha256: '4'.repeat(64) },
  })}\n` : null;
  const bootComponents = `${JSON.stringify({
    schemaVersion: 2,
    components: [
      { role: 'kernel', path: 'zImage', size: 1, sha256: '2'.repeat(64) },
      { role: 'initrd', path: 'uInitrd', size: 1, sha256: '3'.repeat(64) },
      { role: 'dtb', path: `dtb/amlogic/${manifest.board.dtb}`, size: 1, sha256: '4'.repeat(64) },
      {
        role: 'uboot-overload',
        path: manifest.board.ubootOverload,
        size: overloadSize,
        sha256: overloadSha256,
      },
      {
        role: 'uboot-overload-derived',
        path: 'u-boot.ext',
        size: overloadSize,
        sha256: overloadSha256,
      },
      { role: 'boot-script-primary', path: 's905_autoscript', size: 1, sha256: '7'.repeat(64) },
      { role: 'boot-script-installer', path: 'aml_autoscript', size: 1, sha256: '8'.repeat(64) },
      { role: 'boot-config', path: 'uEnv.txt', size: 1, sha256: '6'.repeat(64) },
    ],
  })}\n`;
  const filesystemManifestDigest = createHash('sha256').update(filesystemManifest).digest('hex');
  const thirdPartySourcesDigest = createHash('sha256').update(thirdPartySources).digest('hex');
  const bootComponentsDigest = createHash('sha256').update(bootComponents).digest('hex');
  const ubootBuildDigest = createHash('sha256').update(ubootBuild).digest('hex');
  const dtbBuildDigest = schema8 ? createHash('sha256').update(dtbBuild).digest('hex') : null;
  const qemuConsole = 'Booting Linux\nB860_QEMU_SYSTEM_SMOKE_OK\n';
  const kernelReleaseMarker = 'B860_QEMU_KERNEL_RELEASE_0123456789abcdef0123456789abcdef';
  const qemuConsoleWithRelease = schema8
    ? `Booting Linux\n${kernelReleaseMarker}_5.10.260-ophub\nB860_QEMU_SYSTEM_SMOKE_OK\n`
    : qemuConsole;
  const qemuConsoleDigest = createHash('sha256').update(qemuConsoleWithRelease).digest('hex');
  const qemuSmoke = `${JSON.stringify({
    schemaVersion: 2,
    status: 'passed',
    machine: 'virt',
    cpu: 'cortex-a53',
    manifestFingerprint: manifest.fingerprint,
    rawSha256: rawDigest,
    kernelPath: 'zImage',
    kernelSourceSha256: '2'.repeat(64),
    kernelSha256: '2'.repeat(64),
    initrdPath: 'uInitrd',
    initrdSourceSha256: '3'.repeat(64),
    initrdSha256: '3'.repeat(64),
    ...(schema8 ? {
      kernelRelease: '5.10.260-ophub',
      kernelReleaseMarker,
    } : {}),
    rootUuid: '12345678-1234-1234-1234-123456789abc',
    qemuVersion: 'QEMU emulator version 9.2.0',
    consoleLog: 'qemu-system-smoke.log',
    consoleLogSha256: qemuConsoleDigest,
  })}\n`;
  const qemuSmokeDigest = createHash('sha256').update(qemuSmoke).digest('hex');
  const rtl8189fsEvidence = schema8 ? `${JSON.stringify({
    kernelRelease: '5.10.260-ophub',
    modulePath: EXPECTED_RTL8189FS_MODULE_PATH,
    moduleName: '8189fs',
    sdioAlias: EXPECTED_RTL8189FS_ALIAS,
    vermagic: '5.10.260-ophub SMP preempt mod_unload aarch64',
    moduleFileType: 'ELF 64-bit LSB relocatable, ARM aarch64, version 1 (SYSV)',
    moduleSha256: '2'.repeat(64),
    modulesAliasSha256: '3'.repeat(64),
    modulesDepSha256: '4'.repeat(64),
  })}\n` : null;
  const rtl8189fsEvidenceDigest = rtl8189fsEvidence
    ? createHash('sha256').update(rtl8189fsEvidence).digest('hex')
    : null;
  const hardwareCapabilities = schema8 ? `${JSON.stringify({
    schemaVersion: 1,
    status: 'passed',
    recipe: { path: HARDWARE_CAPABILITY_RECIPE_PATH, sha256: hardwareRecipeSha256 },
    kernel: {
      release: '5.10.260-ophub',
      config: { path: configRelative, sha256: configSha256 },
    },
    deviceTree: {
      path: `dtb/amlogic/${manifest.board.dtb}`,
      sha256: '4'.repeat(64),
    },
    wifiDriver: { path: 'rtl8189fs-driver.json', sha256: rtl8189fsEvidenceDigest },
    capabilities: evaluateHardwareCapabilities(
      hardwareRecipe,
      configBody,
      (check) => {
        if (check.type === 'present') return true;
        if (check.type === 'string-list') return [check.expected];
        if (check.type === 'hex-cell') {
          const cells = Array.from({ length: check.index + 1 }, () => '0');
          cells[check.index] = check.expected;
          return cells;
        }
        return check.expected;
      },
    ),
  })}\n` : null;
  const hardwareCapabilitiesDigest = hardwareCapabilities
    ? createHash('sha256').update(hardwareCapabilities).digest('hex')
    : null;
  fs.writeFileSync(image, imageBytes);
  fs.writeFileSync(path.join(directory, 'resolved-sources.json'), `${JSON.stringify(manifest)}\n`);
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${digest}  ${imageName}\n`);
  fs.writeFileSync(path.join(directory, 'filesystem-manifest.sha256'), filesystemManifest);
  fs.writeFileSync(path.join(directory, 'THIRD_PARTY_SOURCES.md'), thirdPartySources);
  fs.writeFileSync(path.join(directory, 'boot-components.json'), bootComponents);
  fs.writeFileSync(path.join(directory, 'uboot-build.json'), ubootBuild);
  if (schema8) {
    fs.writeFileSync(path.join(directory, 'source-built-dtb.json'), dtbBuild);
    fs.writeFileSync(path.join(directory, 'device-tree-source.dts'), dtbSource);
    fs.writeFileSync(path.join(directory, 'qemu-system-smoke.json'), qemuSmoke);
    fs.writeFileSync(path.join(directory, 'qemu-system-smoke.log'), qemuConsoleWithRelease);
    fs.writeFileSync(path.join(directory, 'rtl8189fs-driver.json'), rtl8189fsEvidence);
    fs.writeFileSync(path.join(directory, 'hardware-capabilities.json'), hardwareCapabilities);
  }
  fs.writeFileSync(
    path.join(directory, 'build-input-heads.json'),
    `${JSON.stringify(expectedBuildInputs(manifest))}\n`,
  );
  const evidence = {
    filesystemManifest: 'filesystem-manifest.sha256',
    filesystemManifestSha256: filesystemManifestDigest,
    bootComponents: 'boot-components.json',
    bootComponentsSha256: bootComponentsDigest,
    ubootBuild: 'uboot-build.json',
    ubootBuildSha256: ubootBuildDigest,
    ubootSourceArchive: 'u-boot-source.tar.gz',
    ubootSourceArchiveSha256: sourceArchiveDigest,
    thirdPartySources: 'THIRD_PARTY_SOURCES.md',
    thirdPartySourcesSha256: thirdPartySourcesDigest,
    ...(schema8 ? {
      sourceBuiltDeviceTree: {
        build: 'source-built-dtb.json',
        buildSha256: dtbBuildDigest,
        source: 'device-tree-source.dts',
        sourceSha256: manifest.board.dtbBuild.sourceSha256,
      },
      qemuSystemSmoke: 'qemu-system-smoke.json',
      qemuSystemSmokeSha256: qemuSmokeDigest,
      qemuSystemConsole: 'qemu-system-smoke.log',
      qemuSystemConsoleSha256: qemuConsoleDigest,
      rtl8189fsDriver: 'rtl8189fs-driver.json',
      rtl8189fsDriverSha256: rtl8189fsEvidenceDigest,
      hardwareCapabilities: 'hardware-capabilities.json',
      hardwareCapabilitiesSha256: hardwareCapabilitiesDigest,
    } : {}),
  };
  fs.writeFileSync(path.join(directory, 'validation-report.json'), `${JSON.stringify({
    schemaVersion: schema8 ? 8 : 6,
    status: 'container-valid / hardware-unverified',
    image: `out/${imageName}`,
    imageSha256: digest,
    rawSha256: rawDigest,
    manifestFingerprint: manifest.fingerprint,
    evidence,
    checks: {
      ...checks,
      ...(schema8 ? {
        sourceBuiltDeviceTree: true,
        qemuSystemBootSmoke: true,
        rtl8189fsDriver: true,
        hardwareCapabilities: true,
      } : {}),
    },
    androidScan: {
      schemaVersion: 1,
      findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] },
    },
  })}\n`);
  return { directory, digest, imageName, manifest };
}

test('candidate validator binds manifest, report, checksum, and image bytes', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);

  const result = await validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint);

  assert.equal(result.imageName, fixture.imageName);
  assert.equal(result.imageSha256, fixture.digest);
  assert.equal(result.manifest.fingerprint, fixture.manifest.fingerprint);
});

test('candidate validator accepts complete schema 8 source-built DTB evidence', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);

  const result = await validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint);

  assert.equal(result.report.schemaVersion, 8);
  assert.equal(result.manifest.schemaVersion, 5);
});

test('candidate validator requires both QEMU system evidence files', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.rmSync(path.join(fixture.directory, 'qemu-system-smoke.json'));

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /qemu-system-smoke\.json|ENOENT/i,
  );
});

test('candidate validator requires RTL8189FS driver evidence for the current recipe', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.rmSync(path.join(fixture.directory, 'rtl8189fs-driver.json'));

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /rtl8189fs-driver\.json|ENOENT/i,
  );
});

test('candidate validator requires hardware capability evidence for the marked recipe', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.rmSync(path.join(fixture.directory, 'hardware-capabilities.json'));

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /hardware-capabilities\.json|ENOENT/i,
  );
});

test('candidate validator rejects a hardware config digest not bound to the rootfs manifest', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const evidencePath = path.join(fixture.directory, 'hardware-capabilities.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.kernel.config.sha256 = '0'.repeat(64);
  const body = `${JSON.stringify(evidence)}\n`;
  fs.writeFileSync(evidencePath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.hardwareCapabilitiesSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /kernel config.*filesystem manifest/i,
  );
});

test('candidate validator rejects a hardware DTB digest not bound to active boot components', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const evidencePath = path.join(fixture.directory, 'hardware-capabilities.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.deviceTree.sha256 = '0'.repeat(64);
  const body = `${JSON.stringify(evidence)}\n`;
  fs.writeFileSync(evidencePath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.hardwareCapabilitiesSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /device tree.*boot components/i,
  );
});

test('candidate validator binds RTL8189FS evidence to the selected kernel', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const evidencePath = path.join(fixture.directory, 'rtl8189fs-driver.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.kernelRelease = '5.10.259-ophub';
  const body = `${JSON.stringify(evidence)}\n`;
  fs.writeFileSync(evidencePath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.rtl8189fsDriverSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /RTL8189FS evidence does not match .*kernel/i,
  );
});

test('candidate validator requires an unforgeable QEMU kernel release marker', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const consolePath = path.join(fixture.directory, 'qemu-system-smoke.log');
  const smokePath = path.join(fixture.directory, 'qemu-system-smoke.json');
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const smoke = JSON.parse(fs.readFileSync(smokePath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const consoleBody = 'Booting Linux\n# printf \'B860_QEMU_KERNEL_RELEASE_0123456789abcdef0123456789abcdef_%s\\n\' "$(uname -r)"\nB860_QEMU_SYSTEM_SMOKE_OK\n';
  const consoleDigest = createHash('sha256').update(consoleBody).digest('hex');
  fs.writeFileSync(consolePath, consoleBody);
  smoke.consoleLogSha256 = consoleDigest;
  const smokeBody = `${JSON.stringify(smoke)}\n`;
  fs.writeFileSync(smokePath, smokeBody);
  report.evidence.qemuSystemConsoleSha256 = consoleDigest;
  report.evidence.qemuSystemSmokeSha256 = createHash('sha256').update(smokeBody).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /QEMU kernel release marker is missing or invalid/i,
  );
});

test('candidate validator rejects a QEMU and module release mismatch', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const smokePath = path.join(fixture.directory, 'qemu-system-smoke.json');
  const consolePath = path.join(fixture.directory, 'qemu-system-smoke.log');
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const smoke = JSON.parse(fs.readFileSync(smokePath, 'utf8'));
  smoke.kernelRelease = '5.10.260-other';
  const consoleBody = `Booting Linux\n${smoke.kernelReleaseMarker}_5.10.260-other\nB860_QEMU_SYSTEM_SMOKE_OK\n`;
  const consoleDigest = createHash('sha256').update(consoleBody).digest('hex');
  fs.writeFileSync(consolePath, consoleBody);
  smoke.consoleLogSha256 = consoleDigest;
  const smokeBody = `${JSON.stringify(smoke)}\n`;
  fs.writeFileSync(smokePath, smokeBody);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.qemuSystemConsoleSha256 = consoleDigest;
  report.evidence.qemuSystemSmokeSha256 = createHash('sha256').update(smokeBody).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /RTL8189FS evidence does not match QEMU kernel/i,
  );
});

test('candidate validator binds all RTL8189FS file hashes to unique filesystem entries', async (t) => {
  const { validateCandidateArtifacts } = await import(validatorModule);
  const cases = [
    ['moduleSha256', 'module'],
    ['modulesAliasSha256', 'modules.alias'],
    ['modulesDepSha256', 'modules.dep'],
  ];
  for (const [field, label] of cases) {
    await t.test(label, async (subtest) => {
      const fixture = createCandidate(subtest, { schema8: true });
      const evidencePath = path.join(fixture.directory, 'rtl8189fs-driver.json');
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      evidence[field] = 'f'.repeat(64);
      const evidenceBody = `${JSON.stringify(evidence)}\n`;
      fs.writeFileSync(evidencePath, evidenceBody);
      const reportPath = path.join(fixture.directory, 'validation-report.json');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      report.evidence.rtl8189fsDriverSha256 = createHash('sha256').update(evidenceBody).digest('hex');
      fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

      await assert.rejects(
        validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
        new RegExp(`RTL8189FS ${label.replace('.', '\\.')} hash does not match filesystem manifest`, 'i'),
      );
    });
  }
});

test('candidate validator rejects duplicate RTL8189FS filesystem paths', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const manifestPath = path.join(fixture.directory, 'filesystem-manifest.sha256');
  const duplicate = `${'3'.repeat(64)}  ./usr/lib/modules/5.10.260-ophub/modules.alias\n`;
  const manifestBody = `${fs.readFileSync(manifestPath, 'utf8')}${duplicate}`;
  fs.writeFileSync(manifestPath, manifestBody);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.filesystemManifestSha256 = createHash('sha256').update(manifestBody).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /RTL8189FS modules\.alias hash does not match filesystem manifest/i,
  );
});

test('candidate validator requires the QEMU success marker on its own line', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const consolePath = path.join(fixture.directory, 'qemu-system-smoke.log');
  const smokePath = path.join(fixture.directory, 'qemu-system-smoke.json');
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const smoke = JSON.parse(fs.readFileSync(smokePath, 'utf8'));
  const consoleBody = `Booting Linux\n${smoke.kernelReleaseMarker}_${smoke.kernelRelease}\nprefix B860_QEMU_SYSTEM_SMOKE_OK suffix\n`;
  const consoleDigest = createHash('sha256').update(consoleBody).digest('hex');
  fs.writeFileSync(consolePath, consoleBody);
  smoke.consoleLogSha256 = consoleDigest;
  const smokeBody = `${JSON.stringify(smoke)}\n`;
  fs.writeFileSync(smokePath, smokeBody);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.qemuSystemConsoleSha256 = consoleDigest;
  report.evidence.qemuSystemSmokeSha256 = createHash('sha256').update(smokeBody).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /QEMU system smoke success marker is missing/i,
  );
});

test('candidate validator binds QEMU evidence to the decompressed raw image', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const smokePath = path.join(fixture.directory, 'qemu-system-smoke.json');
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const smoke = JSON.parse(fs.readFileSync(smokePath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  smoke.rawSha256 = 'b'.repeat(64);
  report.rawSha256 = smoke.rawSha256;
  const smokeBody = `${JSON.stringify(smoke)}\n`;
  fs.writeFileSync(smokePath, smokeBody);
  report.evidence.qemuSystemSmokeSha256 = createHash('sha256').update(smokeBody).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /raw image digest does not match validation report/i,
  );
});

test('candidate validator binds QEMU inputs to boot component evidence', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const smokePath = path.join(fixture.directory, 'qemu-system-smoke.json');
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const smoke = JSON.parse(fs.readFileSync(smokePath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  smoke.initrdPath = 'initrd.img';
  const smokeBody = `${JSON.stringify(smoke)}\n`;
  fs.writeFileSync(smokePath, smokeBody);
  report.evidence.qemuSystemSmokeSha256 = createHash('sha256').update(smokeBody).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /QEMU system smoke inputs do not match active boot components/i,
  );
});

test('candidate validator rejects schema 5 manifest paired with report schema 6', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.schemaVersion = 6;
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /manifest schema 5 requires validation report schema 8/,
  );
});

test('published state rejects schema 8 DTB evidence with an unbound source digest', (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const report = JSON.parse(fs.readFileSync(path.join(fixture.directory, 'validation-report.json'), 'utf8'));
  report.evidence.sourceBuiltDeviceTree.sourceSha256 = '0'.repeat(64);

  assert.throws(
    () => validatePublishedState(fixture.manifest, report),
    /source-built DTB evidence is invalid/,
  );
});

test('candidate validator rejects a schema 4 manifest paired with report schema 8', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.schemaVersion = 8;
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /manifest schema 4 cannot use validation report schema 8/,
  );
});

test('candidate validator rejects missing source-built DTB evidence', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.rmSync(path.join(fixture.directory, 'source-built-dtb.json'));

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /source-built-dtb\.json|ENOENT/,
  );
});

test('candidate validator rejects tampered source-built DTB evidence', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const buildPath = path.join(fixture.directory, 'source-built-dtb.json');
  const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
  build.source.commit = '0'.repeat(40);
  const body = `${JSON.stringify(build)}\n`;
  fs.writeFileSync(buildPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.sourceBuiltDeviceTree.buildSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /source-built DTB evidence does not match manifest provenance/,
  );
});

test('candidate validator rejects missing device tree source evidence', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.rmSync(path.join(fixture.directory, 'device-tree-source.dts'));

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /device-tree-source\.dts|ENOENT/,
  );
});

test('candidate validator rejects missing schema 8 DTB component evidence', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const componentsPath = path.join(fixture.directory, 'boot-components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components.components = components.components.filter(({ role }) => role !== 'dtb');
  const body = `${JSON.stringify(components)}\n`;
  fs.writeFileSync(componentsPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.bootComponentsSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /boot component evidence is missing dtb/,
  );
});

test('candidate validator rejects a schema 8 DTB component at a misplaced path', async (t) => {
  const fixture = createCandidate(t, { schema8: true });
  const { validateCandidateArtifacts } = await import(validatorModule);
  const componentsPath = path.join(fixture.directory, 'boot-components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components.components.find(({ role }) => role === 'dtb').path = 'backup/meson-gxl-s905x-p212-b860av11t.dtb';
  const body = `${JSON.stringify(components)}\n`;
  fs.writeFileSync(componentsPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.bootComponentsSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /DTB component evidence does not match source build/,
  );
});

test('candidate validator rejects a checksum for a different image name', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.writeFileSync(path.join(fixture.directory, 'SHA256SUMS'), `${fixture.digest}  other.img.gz\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /SHA256SUMS is not bound to the candidate image/,
  );
});

test('candidate validator rejects a report for a different image name', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.image = 'out/other.img.gz';
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /validation report is not bound to the candidate image/,
  );
});

test('candidate validator rejects build input heads that differ from the manifest', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const headsPath = path.join(fixture.directory, 'build-input-heads.json');
  const heads = JSON.parse(fs.readFileSync(headsPath, 'utf8'));
  heads.builder.commit = 'f'.repeat(40);
  fs.writeFileSync(headsPath, `${JSON.stringify(heads)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /build input heads do not match the candidate manifest/,
  );
});

test('candidate validator rejects a non-Armbian image name', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const renamed = 'linux-test.img.gz';
  fs.renameSync(path.join(fixture.directory, fixture.imageName), path.join(fixture.directory, renamed));
  fs.writeFileSync(path.join(fixture.directory, 'SHA256SUMS'), `${fixture.digest}  ${renamed}\n`);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.image = `out/${renamed}`;
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /Armbian image name/i,
  );
});

test('candidate validator rejects modified validation evidence', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.appendFileSync(path.join(fixture.directory, 'filesystem-manifest.sha256'), 'tampered\n');

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /filesystem manifest digest/i,
  );
});

test('candidate validator binds the third-party source document', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  fs.appendFileSync(path.join(fixture.directory, 'THIRD_PARTY_SOURCES.md'), 'tampered\n');

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /third-party source/i,
  );
});

test('candidate validator binds U-Boot build evidence to the source manifest', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const buildPath = path.join(fixture.directory, 'uboot-build.json');
  const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
  build.source.commit = '0'.repeat(40);
  const body = `${JSON.stringify(build)}\n`;
  fs.writeFileSync(buildPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.ubootBuildSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /U-Boot source commit/i,
  );
});

test('candidate validator binds the source archive contents to its tree digest', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const buildPath = path.join(fixture.directory, 'uboot-build.json');
  const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
  build.sourceArchive.treeSha256 = 'f'.repeat(64);
  const body = `${JSON.stringify(build)}\n`;
  fs.writeFileSync(buildPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.ubootBuildSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /source archive tree digest/i,
  );
});

test('candidate validator binds U-Boot component evidence to manifest provenance', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const componentsPath = path.join(fixture.directory, 'boot-components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  const uboot = components.components.find(({ role }) => role === 'uboot-overload');
  uboot.sha256 = 'f'.repeat(64);
  const body = `${JSON.stringify(components)}\n`;
  fs.writeFileSync(componentsPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.bootComponentsSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /U-Boot overload evidence/i,
  );
});

test('candidate validator binds derived U-Boot evidence to the overload bytes', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const componentsPath = path.join(fixture.directory, 'boot-components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components.components.find(({ role }) => role === 'uboot-overload-derived').sha256 = 'f'.repeat(64);
  const body = `${JSON.stringify(components)}\n`;
  fs.writeFileSync(componentsPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.bootComponentsSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /derived U-Boot evidence/i,
  );
});

test('candidate validator requires primary boot script evidence', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const componentsPath = path.join(fixture.directory, 'boot-components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components.components = components.components.filter(({ role }) => role !== 'boot-script-primary');
  const body = `${JSON.stringify(components)}\n`;
  fs.writeFileSync(componentsPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.bootComponentsSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /boot-script-primary/i,
  );
});

test('candidate validator rejects a nested primary boot script path', async (t) => {
  const fixture = createCandidate(t);
  const { validateCandidateArtifacts } = await import(validatorModule);
  const componentsPath = path.join(fixture.directory, 'boot-components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components.components.find(({ role }) => role === 'boot-script-primary').path = 'nested/s905_autoscript';
  const body = `${JSON.stringify(components)}\n`;
  fs.writeFileSync(componentsPath, body);
  const reportPath = path.join(fixture.directory, 'validation-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.evidence.bootComponentsSha256 = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

  await assert.rejects(
    validateCandidateArtifacts(fixture.directory, fixture.manifest.fingerprint),
    /primary boot script evidence/i,
  );
});
