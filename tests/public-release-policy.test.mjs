import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildManifest } from '../src/upstream.mjs';
import { releaseTagForManifest } from '../src/release.mjs';
import { validatePublicRelease } from '../src/public-release-policy.mjs';

const board = JSON.parse(fs.readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'));
const baseFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'),
);

function currentManifest() {
  return buildManifest({
    ...structuredClone(baseFixture),
    schemaVersion: 5,
    board: structuredClone({ ...board, distribution: 'trixie', distributionVersion: '13' }),
    recipe: {
      ...structuredClone(baseFixture.recipe),
      files: {
        ...structuredClone(baseFixture.recipe.files),
        'config/hardware-capabilities.json': 'c'.repeat(64),
        'scripts/validate-rtl8189fs.mjs': 'a'.repeat(64),
        'src/rtl8189fs.mjs': 'b'.repeat(64),
      },
    },
  });
}

function checks() {
  return {
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
    sourceBuiltDeviceTree: true,
    qemuSystemBootSmoke: true,
    rtl8189fsDriver: true,
    hardwareCapabilities: true,
  };
}

function asset(name, digest) {
  return { name, state: 'uploaded', size: 1024, digest: `sha256:${digest}` };
}

function currentRelease() {
  const manifest = currentManifest();
  const imageName = 'Armbian_26.08.0_amlogic_b860av1-t_trixie_5.10.260_server_2026.07.20.img.gz';
  const tag = releaseTagForManifest(manifest, 42, 1);
  const report = {
    schemaVersion: 8,
    status: 'container-valid / hardware-unverified',
    image: `out/${imageName}`,
    imageSha256: 'a'.repeat(64),
    rawSha256: 'b'.repeat(64),
    manifestFingerprint: manifest.fingerprint,
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256',
      filesystemManifestSha256: 'c'.repeat(64),
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
      qemuSystemSmokeSha256: '9'.repeat(64),
      qemuSystemConsole: 'qemu-system-smoke.log',
      qemuSystemConsoleSha256: '8'.repeat(64),
      rtl8189fsDriver: 'rtl8189fs-driver.json',
      rtl8189fsDriverSha256: '0'.repeat(64),
      hardwareCapabilities: 'hardware-capabilities.json',
      hardwareCapabilitiesSha256: '6'.repeat(64),
    },
    checks: checks(),
    androidScan: {
      schemaVersion: 1,
      findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] },
    },
  };
  const release = {
    tagName: tag,
    isDraft: false,
    isPrerelease: true,
    assets: [
      asset(imageName, 'a'.repeat(64)),
      asset('SHA256SUMS', '3'.repeat(64)),
      asset('build-input-heads.json', '4'.repeat(64)),
      asset('release-tag.txt', '5'.repeat(64)),
      asset('resolved-sources.json', '6'.repeat(64)),
      asset('validation-report.json', '7'.repeat(64)),
      asset('filesystem-manifest.sha256', 'c'.repeat(64)),
      asset('boot-components.json', 'd'.repeat(64)),
      asset('uboot-build.json', 'e'.repeat(64)),
      asset('u-boot-source.tar.gz', 'f'.repeat(64)),
      asset('THIRD_PARTY_SOURCES.md', '1'.repeat(64)),
      asset('source-built-dtb.json', '2'.repeat(64)),
      asset('device-tree-source.dts', manifest.board.dtbBuild.sourceSha256),
      asset('qemu-system-smoke.json', '9'.repeat(64)),
      asset('qemu-system-smoke.log', '8'.repeat(64)),
      asset('rtl8189fs-driver.json', '0'.repeat(64)),
      asset('hardware-capabilities.json', '6'.repeat(64)),
    ],
  };
  return { manifest, report, release, tag };
}

test('accepts a published schema 5/8 source-built Armbian release', () => {
  const fixture = currentRelease();
  assert.equal(validatePublicRelease(fixture), fixture.tag);
});

test('rejects a schema 8 release without complete QEMU system evidence assets', () => {
  const fixture = currentRelease();
  fixture.release.assets = fixture.release.assets.filter((entry) => entry.name !== 'qemu-system-smoke.json');

  assert.throws(() => validatePublicRelease(fixture), /qemu-system-smoke\.json/i);
});

test('rejects the current recipe without RTL8189FS evidence', () => {
  const fixture = currentRelease();
  fixture.release.assets = fixture.release.assets.filter(
    (entry) => entry.name !== 'rtl8189fs-driver.json',
  );
  assert.throws(() => validatePublicRelease(fixture), /rtl8189fs-driver\.json/i);
});

test('rejects the current recipe without hardware capability evidence', () => {
  const fixture = currentRelease();
  fixture.release.assets = fixture.release.assets.filter(
    (entry) => entry.name !== 'hardware-capabilities.json',
  );
  assert.throws(() => validatePublicRelease(fixture), /hardware-capabilities\.json/i);
});

test('rejects a public release with a historical schema', () => {
  const fixture = currentRelease();
  fixture.manifest.schemaVersion = 4;
  assert.throws(() => validatePublicRelease(fixture), /schema 5/i);
});

test('rejects a draft or non-prerelease release', () => {
  const fixture = currentRelease();
  assert.throws(
    () => validatePublicRelease({ ...fixture, release: { ...fixture.release, isDraft: true } }),
    /published prerelease/i,
  );
  assert.throws(
    () => validatePublicRelease({ ...fixture, release: { ...fixture.release, isPrerelease: false } }),
    /published prerelease/i,
  );
});

test('rejects a non-Armbian image name or malformed build tag', () => {
  const fixture = currentRelease();
  fixture.release.assets[0].name = 'linux.img.gz';
  assert.throws(() => validatePublicRelease(fixture), /Armbian image/i);

  const fresh = currentRelease();
  assert.throws(
    () => validatePublicRelease({ ...fresh, tag: 'wrong-tag', release: { ...fresh.release, tagName: 'wrong-tag' } }),
    /tag/i,
  );
});

test('rejects Android findings even when the server asset list is complete', () => {
  const fixture = currentRelease();
  fixture.report.androidScan.findings.boot.push('uEnv.txt: Android boot marker');
  assert.throws(() => validatePublicRelease(fixture), /Android scan/i);
});

test('accepts only uniquely named optional device evidence assets', () => {
  const fixture = currentRelease();
  fixture.release.assets.push(
    asset('device-validation-0123456789abcdef.json', 'a'.repeat(64)),
    asset('device-serial-0123456789abcdef.log', 'b'.repeat(64)),
    asset('device-validation-0123456789abcdef.md', 'c'.repeat(64)),
  );
  assert.equal(validatePublicRelease(fixture), fixture.tag);

  const invalid = currentRelease();
  invalid.release.assets.push(asset('device-validation-latest.json', 'a'.repeat(64)));
  assert.throws(() => validatePublicRelease(invalid), /unexpected release asset/i);
});
