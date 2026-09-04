import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildReleaseMetadata } from '../src/release-metadata.mjs';
import { IMAGE_IDENTITY_RECIPE_MARKER } from '../src/image-identity.mjs';
import { releaseTagForManifest } from '../src/release.mjs';
import { buildManifest } from '../src/upstream.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);
const cli = path.resolve('scripts/generate-release-metadata.mjs');
const board = JSON.parse(readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'));
const manifestFixture = JSON.parse(readFileSync(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'));

function fixture() {
  const manifest = buildManifest({
    ...structuredClone(manifestFixture),
    schemaVersion: 5,
    board: { ...board, distribution: 'trixie', distributionVersion: '13' },
    recipe: {
      ...structuredClone(manifestFixture.recipe),
      files: {
        ...structuredClone(manifestFixture.recipe.files),
        [IMAGE_IDENTITY_RECIPE_MARKER]: '9'.repeat(64),
      },
    },
  });
  const image = 'Armbian_26.08.0_amlogic_b860av1-t_trixie_5.10.260_server_2026.07.22.img.gz';
  const imageSha256 = 'a'.repeat(64);
  const rawSha256 = 'b'.repeat(64);
  const identitySha256 = 'c'.repeat(64);
  const kernelRelease = '5.10.260-ophub';
  const tag = releaseTagForManifest(manifest, 37, 1);
  const filesystemManifest = `${identitySha256}  ./usr/lib/b860av1-t/image-identity.json\n`;
  const qemuSystemSmoke = `${JSON.stringify({
    schemaVersion: 2,
    status: 'passed',
    manifestFingerprint: manifest.fingerprint,
    rawSha256,
    kernelRelease,
  }, null, 2)}\n`;
  const checks = Object.fromEntries([
    'gzip', 'partitionTable', 'fatBoot', 'ext4Rootfs', 'debianStableRelease',
    'bootFiles', 'kernelArchitecture', 'dtbCompatible', 'rootfsLabel', 'userspaceSmoke',
    'packageState', 'sshUnit', 'imageFits8GB', 'mbrBootstrapEmpty',
    'mbrReservedBytesEmpty', 'partitionStartMatchesManifest', 'persistentBootloaderAbsent',
    'bootloaderPayloadsExcluded', 'legacyUbootPayloadsAbsent', 'imageIdentity',
    'debianIdentity', 'armbianIdentity', 'knownAndroidMarkersAbsent',
    'initrdKnownAndroidMarkersAbsent', 'bootConfigKnownAndroidMarkersAbsent',
    'dtbKnownAndroidMarkersAbsent', 'filesystemManifestCreated', 'bootComponentsRecorded',
    'ubootOverloadProvenance', 'sourceBuiltUbootOverload', 'sourceBuiltDeviceTree',
    'qemuSystemBootSmoke', 'memoryLimitApplied', 'stockBootScriptStaticPathValid',
    'primaryBootScriptAndroidFallbackAbsent', 'installerBootScriptAndroidFallbackAbsent',
  ].map((name) => [name, true]));
  const report = {
    schemaVersion: 8,
    status: 'container-valid / hardware-unverified',
    image: `out/${image}`,
    imageSha256,
    rawSha256,
    manifestFingerprint: manifest.fingerprint,
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256',
      filesystemManifestSha256: sha256(filesystemManifest),
      bootComponents: 'boot-components.json',
      bootComponentsSha256: 'd'.repeat(64),
      ubootBuild: 'uboot-build.json',
      ubootBuildSha256: 'e'.repeat(64),
      ubootSourceArchive: 'u-boot-source.tar.gz',
      ubootSourceArchiveSha256: 'f'.repeat(64),
      thirdPartySources: 'THIRD_PARTY_SOURCES.md',
      thirdPartySourcesSha256: '1'.repeat(64),
      sourceBuiltDeviceTree: {
        build: 'source-built-dtb.json',
        buildSha256: '2'.repeat(64),
        source: 'device-tree-source.dts',
        sourceSha256: manifest.board.dtbBuild.sourceSha256,
      },
      qemuSystemSmoke: 'qemu-system-smoke.json',
      qemuSystemSmokeSha256: sha256(qemuSystemSmoke),
      qemuSystemConsole: 'qemu-system-smoke.log',
      qemuSystemConsoleSha256: '3'.repeat(64),
    },
    checks,
    androidScan: {
      schemaVersion: 1,
      findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] },
    },
  };
  return { manifest, report, filesystemManifest, qemuSystemSmoke, tag, image, imageSha256, rawSha256, identitySha256, kernelRelease };
}

function metadataInput(input) {
  return {
    manifest: input.manifest,
    report: input.report,
    filesystemManifest: input.filesystemManifest,
    filesystemManifestBytes: Buffer.from(input.filesystemManifest),
    releaseTag: `${input.tag}\n`,
    qemuSystemSmoke: JSON.parse(input.qemuSystemSmoke),
    qemuSystemSmokeBytes: Buffer.from(input.qemuSystemSmoke),
  };
}

test('derives collector metadata from bound Release evidence', () => {
  const input = fixture();
  assert.deepEqual(buildReleaseMetadata(metadataInput(input)), {
    repository: 'wuhao1477/b860av1-t-armbian-burn-builder',
    tag: input.tag,
    image: input.image,
    imageSha256: input.imageSha256,
    rawSha256: input.rawSha256,
    manifestFingerprint: input.manifest.fingerprint,
    kernelVersion: '5.10.260',
    kernelRelease: input.kernelRelease,
    identitySha256: input.identitySha256,
  });
});

test('rejects a release tag that does not match the manifest versions', () => {
  const input = fixture();
  assert.throws(
    () => buildReleaseMetadata({
      ...metadataInput(input),
      releaseTag: 'armbian-99.0.0-debian-13.0-trixie-k5.10.260-build-37.1\n',
    }),
    /release tag does not match manifest/i,
  );
});

test('rejects a filesystem manifest whose digest differs from the report', () => {
  const input = fixture();
  input.report.evidence.filesystemManifestSha256 = '0'.repeat(64);
  assert.throws(() => buildReleaseMetadata(metadataInput(input)), /filesystem manifest digest/i);
});

test('rejects parsed filesystem content that differs from the verified bytes', () => {
  const input = fixture();
  const parsedContent = input.filesystemManifest.replace(input.identitySha256, '4'.repeat(64));
  assert.throws(
    () => buildReleaseMetadata({ ...metadataInput(input), filesystemManifest: parsedContent }),
    /filesystem manifest content does not match verified bytes/i,
  );
});

test('rejects missing and duplicate image identity entries', () => {
  const missing = fixture();
  missing.filesystemManifest = `${'5'.repeat(64)}  ./etc/os-release\n`;
  missing.report.evidence.filesystemManifestSha256 = sha256(missing.filesystemManifest);
  assert.throws(() => buildReleaseMetadata(metadataInput(missing)), /image identity entry must be unique/i);

  const duplicate = fixture();
  duplicate.filesystemManifest += duplicate.filesystemManifest;
  duplicate.report.evidence.filesystemManifestSha256 = sha256(duplicate.filesystemManifest);
  assert.throws(() => buildReleaseMetadata(metadataInput(duplicate)), /image identity entry must be unique/i);
});

test('rejects QEMU evidence that is not bound to the raw image', () => {
  const input = fixture();
  const qemu = JSON.parse(input.qemuSystemSmoke);
  qemu.rawSha256 = '6'.repeat(64);
  input.qemuSystemSmoke = `${JSON.stringify(qemu, null, 2)}\n`;
  input.report.evidence.qemuSystemSmokeSha256 = sha256(input.qemuSystemSmoke);
  assert.throws(() => buildReleaseMetadata(metadataInput(input)), /QEMU system evidence/i);
});

test('rejects parsed QEMU content that differs from the verified bytes', () => {
  const input = fixture();
  const parsed = { ...JSON.parse(input.qemuSystemSmoke), kernelRelease: '5.10.260-other' };
  assert.throws(
    () => buildReleaseMetadata({ ...metadataInput(input), qemuSystemSmoke: parsed }),
    /QEMU system evidence content does not match verified bytes/i,
  );
});

test('writes deterministic collector metadata from a Release assets directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'b860-release-metadata-'));
  try {
    const assets = path.join(root, 'assets');
    const output = path.join(root, 'generated', 'release-metadata.json');
    const input = fixture();
    await mkdir(assets);
    await Promise.all([
      writeFile(path.join(assets, 'resolved-sources.json'), `${JSON.stringify(input.manifest)}\n`),
      writeFile(path.join(assets, 'validation-report.json'), `${JSON.stringify(input.report)}\n`),
      writeFile(path.join(assets, 'filesystem-manifest.sha256'), input.filesystemManifest),
      writeFile(path.join(assets, 'release-tag.txt'), `${input.tag}\n`),
      writeFile(path.join(assets, 'qemu-system-smoke.json'), input.qemuSystemSmoke),
    ]);

    await execFileAsync(process.execPath, [cli, '--assets', assets, '--output', output]);

    const generated = await readFile(output, 'utf8');
    assert.equal(generated, `${JSON.stringify(buildReleaseMetadata(metadataInput(input)), null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
