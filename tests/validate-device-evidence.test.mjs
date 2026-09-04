import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateDeviceEvidenceAgainstRelease } from '../scripts/validate-device-evidence.mjs';
import { IMAGE_IDENTITY_RECIPE_MARKER } from '../src/image-identity.mjs';
import { releaseTagForManifest } from '../src/release.mjs';
import { buildManifest } from '../src/upstream.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const board = JSON.parse(readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'));
const manifestFixture = JSON.parse(readFileSync(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'));

function report() {
  const fingerprint = 'a'.repeat(64);
  const kernelRelease = '5.10.260-ophub';
  const log = `Linux version ${kernelRelease}\nWelcome to Armbian\nB860_DEVICE_READY 0123456789abcdef ${fingerprint} ${kernelRelease}\n`;
  return {
    schemaVersion: 1,
    status: 'passed',
    evidenceId: '0123456789abcdef',
    collectedAt: '2026-07-22T04:00:00Z',
    board: {
      profile: 'b860av1-t',
      declaredModel: 'ZXV10 B860AV1.1-T',
      observedModel: 'Amlogic Meson GXL P212 Development Board',
      compatible: ['amlogic,p212'],
    },
    release: {
      repository: 'wuhao1477/b860av1-t-armbian-burn-builder',
      tag: 'armbian-26.08.0-debian-13.6-trixie-k5.10.260-build-36.1',
      image: 'Armbian_26.08.0_amlogic_b860av1-t_trixie_5.10.260_server_2026.07.22.img.gz',
      imageSha256: 'c'.repeat(64), rawSha256: 'd'.repeat(64), manifestFingerprint: fingerprint,
    },
    identity: {
      path: '/usr/lib/b860av1-t/image-identity.json', sha256: 'e'.repeat(64),
      manifestFingerprint: fingerprint, kernelVersion: '5.10.260', kernelRelease,
    },
    collector: {
      repository: 'wuhao1477/b860av1-t-armbian-burn-builder', commit: 'f'.repeat(40),
      scriptPath: 'scripts/collect-device-evidence.sh', scriptSha256: '1'.repeat(64),
    },
    boot: {
      kernelRelease,
      components: [
        { role: 'kernel', path: 'zImage', sha256: '2'.repeat(64) },
        { role: 'initrd', path: 'uInitrd', sha256: '3'.repeat(64) },
        { role: 'dtb', path: 'dtb/amlogic/board.dtb', sha256: '4'.repeat(64) },
        { role: 'boot-config', path: 'uEnv.txt', sha256: '5'.repeat(64) },
      ],
    },
    serial: { asset: 'device-serial.log', sha256: sha256(log), bootFromPowerOn: true, linuxReady: true, androidMarkersAbsent: true },
    capabilities: {
      emmc: { passed: true, observations: { blockDevicePresent: true, rootSourceObserved: true, capacityBytes: 1, readOnlyProbeBytes: 1 } },
      ethernet: { passed: true, observations: { carrier: true, connectivity: true } },
      hdmi: { passed: true, observations: { connectorConnected: true, edidSha256: 'b'.repeat(64), linuxDisplayVisible: true } },
      infrared: { passed: true, observations: { inputDevicePresent: true, keyEventSeen: true, keyCode: 116 } },
      usb: { passed: true, observations: { hostPresent: true, hotplugSeen: true, vendorId: 'abcd', productId: '1234', readOnlyProbe: true } },
      wifi: { passed: true, observations: { driver: '8189fs', interfacePresent: true, associated: true, connectivity: true } },
    },
  };
}

async function writeAsset(directory, name, content, assets) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await writeFile(path.join(directory, name), body);
  assets.push({ name, state: 'uploaded', size: body.length, digest: `sha256:${sha256(body)}` });
  return sha256(body);
}

async function completeFixture(root) {
  const evidenceDir = path.join(root, 'evidence');
  const assetsDir = path.join(root, 'assets');
  await mkdir(evidenceDir); await mkdir(assetsDir);
  const manifest = buildManifest({
    ...structuredClone(manifestFixture),
    schemaVersion: 5,
    board: { ...board, distribution: 'trixie', distributionVersion: '13' },
    recipe: {
      ...structuredClone(manifestFixture.recipe),
      files: { ...structuredClone(manifestFixture.recipe.files), [IMAGE_IDENTITY_RECIPE_MARKER]: '9'.repeat(64) },
    },
  });
  const tag = releaseTagForManifest(manifest, 36, 1);
  const image = 'Armbian_26.08.0_amlogic_b860av1-t_trixie_5.10.260_server_2026.07.22.img.gz';
  const imageSha = 'c'.repeat(64); const rawSha = 'd'.repeat(64); const identitySha = 'e'.repeat(64);
  const components = `${JSON.stringify({ schemaVersion: 2, components: [
    { role: 'kernel', path: 'zImage', size: 1, sha256: '2'.repeat(64) },
    { role: 'initrd', path: 'uInitrd', size: 1, sha256: '3'.repeat(64) },
    { role: 'dtb', path: 'dtb/amlogic/board.dtb', size: 1, sha256: '4'.repeat(64) },
    { role: 'boot-config', path: 'uEnv.txt', size: 1, sha256: '5'.repeat(64) },
  ] })}\n`;
  const filesystem = `${identitySha}  ./usr/lib/b860av1-t/image-identity.json\n`;
  const staticBodies = {
    'filesystem-manifest.sha256': filesystem,
    'boot-components.json': components,
    'uboot-build.json': '{}\n',
    'u-boot-source.tar.gz': 'fixture-source\n',
    'THIRD_PARTY_SOURCES.md': '# Sources\n',
    'source-built-dtb.json': '{}\n',
    'device-tree-source.dts': readFileSync(new URL('./fixtures/source-built-b860av11t.dts', import.meta.url)),
    'qemu-system-smoke.json': '{}\n',
    'qemu-system-smoke.log': 'B860_QEMU_SYSTEM_SMOKE_OK\n',
  };
  const bodySha = Object.fromEntries(Object.entries(staticBodies).map(([name, body]) => [name, sha256(body)]));
  const checks = Object.fromEntries([
    'gzip', 'partitionTable', 'fatBoot', 'ext4Rootfs', 'debianStableRelease', 'bootFiles',
    'kernelArchitecture', 'dtbCompatible', 'rootfsLabel', 'userspaceSmoke', 'packageState',
    'sshUnit', 'imageFits8GB', 'mbrBootstrapEmpty', 'mbrReservedBytesEmpty',
    'partitionStartMatchesManifest', 'persistentBootloaderAbsent', 'bootloaderPayloadsExcluded',
    'legacyUbootPayloadsAbsent', 'imageIdentity', 'debianIdentity', 'armbianIdentity',
    'knownAndroidMarkersAbsent', 'initrdKnownAndroidMarkersAbsent',
    'bootConfigKnownAndroidMarkersAbsent', 'dtbKnownAndroidMarkersAbsent',
    'filesystemManifestCreated', 'bootComponentsRecorded', 'ubootOverloadProvenance',
    'sourceBuiltUbootOverload', 'sourceBuiltDeviceTree', 'qemuSystemBootSmoke',
    'memoryLimitApplied', 'stockBootScriptStaticPathValid',
    'primaryBootScriptAndroidFallbackAbsent', 'installerBootScriptAndroidFallbackAbsent',
  ].map((name) => [name, true]));
  const releaseReport = {
    schemaVersion: 8,
    status: 'container-valid / hardware-unverified',
    image: `out/${image}`,
    imageSha256: imageSha,
    rawSha256: rawSha,
    manifestFingerprint: manifest.fingerprint,
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256', filesystemManifestSha256: bodySha['filesystem-manifest.sha256'],
      bootComponents: 'boot-components.json', bootComponentsSha256: bodySha['boot-components.json'],
      ubootBuild: 'uboot-build.json', ubootBuildSha256: bodySha['uboot-build.json'],
      ubootSourceArchive: 'u-boot-source.tar.gz', ubootSourceArchiveSha256: bodySha['u-boot-source.tar.gz'],
      thirdPartySources: 'THIRD_PARTY_SOURCES.md', thirdPartySourcesSha256: bodySha['THIRD_PARTY_SOURCES.md'],
      sourceBuiltDeviceTree: {
        build: 'source-built-dtb.json', buildSha256: bodySha['source-built-dtb.json'],
        source: 'device-tree-source.dts', sourceSha256: manifest.board.dtbBuild.sourceSha256,
      },
      qemuSystemSmoke: 'qemu-system-smoke.json', qemuSystemSmokeSha256: bodySha['qemu-system-smoke.json'],
      qemuSystemConsole: 'qemu-system-smoke.log', qemuSystemConsoleSha256: bodySha['qemu-system-smoke.log'],
    },
    checks,
    androidScan: { schemaVersion: 1, findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] } },
  };
  const serial = `Linux version 5.10.260-ophub\nWelcome to Armbian\nB860_DEVICE_READY 0123456789abcdef ${manifest.fingerprint} 5.10.260-ophub\n`;
  const collectorCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const collectorSource = execFileSync('git', ['show', `${collectorCommit}:scripts/collect-device-evidence.sh`]);
  const evidence = report();
  evidence.release = { repository: 'wuhao1477/b860av1-t-armbian-burn-builder', tag, image, imageSha256: imageSha, rawSha256: rawSha, manifestFingerprint: manifest.fingerprint };
  evidence.identity = { path: '/usr/lib/b860av1-t/image-identity.json', sha256: identitySha, manifestFingerprint: manifest.fingerprint, kernelVersion: '5.10.260', kernelRelease: '5.10.260-ophub' };
  evidence.collector = { repository: 'wuhao1477/b860av1-t-armbian-burn-builder', commit: collectorCommit, scriptPath: 'scripts/collect-device-evidence.sh', scriptSha256: sha256(collectorSource) };
  evidence.serial.sha256 = sha256(serial);
  await writeFile(path.join(evidenceDir, 'device-validation.json'), `${JSON.stringify(evidence)}\n`);
  await writeFile(path.join(evidenceDir, 'device-serial.log'), serial);
  const assets = [{ name: image, state: 'uploaded', size: 1024, digest: `sha256:${imageSha}` }];
  await writeAsset(assetsDir, 'SHA256SUMS', `${imageSha}  ${image}\n`, assets);
  await writeAsset(assetsDir, 'build-input-heads.json', '{}\n', assets);
  await writeAsset(assetsDir, 'release-tag.txt', `${tag}\n`, assets);
  await writeAsset(assetsDir, 'resolved-sources.json', `${JSON.stringify(manifest)}\n`, assets);
  await writeAsset(assetsDir, 'validation-report.json', `${JSON.stringify(releaseReport)}\n`, assets);
  for (const [name, body] of Object.entries(staticBodies)) await writeAsset(assetsDir, name, body, assets);
  await writeFile(path.join(assetsDir, 'release.json'), `${JSON.stringify({ tagName: tag, isDraft: false, isPrerelease: true, assets })}\n`);
  return { evidenceDir, assetsDir, evidence, manifest };
}

test('rejects an evidence directory when Release assets are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'b860-release-validation-'));
  try {
    const evidenceDir = path.join(root, 'evidence');
    const assetsDir = path.join(root, 'assets');
    await mkdir(evidenceDir);
    await mkdir(assetsDir);
    const value = report();
    await writeFile(path.join(evidenceDir, 'device-validation.json'), `${JSON.stringify(value)}\n`);
    await writeFile(path.join(evidenceDir, 'device-serial.log'), `Linux version ${value.identity.kernelRelease}\nWelcome to Armbian\nB860_DEVICE_READY ${value.evidenceId} ${value.release.manifestFingerprint} ${value.identity.kernelRelease}\n`);
    await assert.rejects(
      validateDeviceEvidenceAgainstRelease(evidenceDir, assetsDir, process.cwd()),
      /release|asset|manifest/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('binds one complete device report to an immutable published Release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'b860-release-validation-'));
  try {
    const fixture = await completeFixture(root);
    const result = await validateDeviceEvidenceAgainstRelease(fixture.evidenceDir, fixture.assetsDir, process.cwd());
    assert.equal(result.summary.status, 'operator-attested / one-device');
    assert.equal(result.summary.evidenceId, fixture.evidence.evidenceId);
    assert.equal(result.report.status, 'container-valid / hardware-unverified');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
