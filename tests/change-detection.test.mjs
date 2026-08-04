import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import {
  compareFingerprints,
  validatePublishedState,
  validateReleaseAssets,
} from '../src/change-detection.mjs';
import { IMAGE_IDENTITY_RECIPE_MARKER } from '../src/image-identity.mjs';
import { buildManifest } from '../src/upstream.mjs';

const validManifest = JSON.parse(readFileSync(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'));
const fingerprintChanged = { changed: true, reason: 'fingerprint-changed' };

function debianManifest(options = {}) {
  const {
    codename = 'trixie', date = '2026-07-11T09:02:23.000Z', fingerprint = 'current', version = '13.6',
  } = options;
  const manifest = structuredClone(validManifest);
  const majorVersion = version.split('.')[0];
  Object.assign(manifest.board, { distribution: codename, distributionVersion: majorVersion });
  manifest.fingerprint = fingerprint;
  Object.assign(manifest.sources.debian, { codename, date, majorVersion, version });
  return manifest;
}

function schema2Manifest({ codename = 'trixie', fingerprint = 'previous', majorVersion = '13' } = {}) {
  const manifest = debianManifest({ codename, fingerprint, version: `${majorVersion}.0` });
  manifest.schemaVersion = 2;
  delete manifest.sources.debian;
  return manifest;
}

test('change detector builds when the previous release is missing', () => {
  assert.deepEqual(compareFingerprints('current', null, false), {
    changed: true,
    reason: 'no-previous-release',
  });
});

test('fingerprint detector skips an unchanged source set', () => {
  assert.deepEqual(compareFingerprints('same', 'same', false), {
    changed: false,
    reason: 'unchanged',
  });
});

test('change detector builds when fingerprints differ', () => {
  assert.deepEqual(compareFingerprints('current', 'previous', false), {
    changed: true,
    reason: 'fingerprint-changed',
  });
});

test('change detector honors force=true even when unchanged', () => {
  assert.deepEqual(compareFingerprints('same', 'same', true), {
    changed: true,
    reason: 'forced',
  });
});

test('change detector rejects an older Debian stable point version', () => {
  const previous = debianManifest({ fingerprint: 'previous', version: '13.10' });
  const current = debianManifest({ fingerprint: 'current', version: '13.9' });
  assert.throws(() => compareFingerprints(current, previous, false), /Debian stable.*version.*rollback/i);
});
test('change detector rejects an older Debian stable release date', () => {
  const previous = debianManifest({ date: '2026-07-11T09:02:23.000Z', fingerprint: 'previous' });
  const current = debianManifest({ date: '2026-07-10T09:02:23.000Z', fingerprint: 'current' });
  assert.throws(() => compareFingerprints(current, previous, false), /Debian stable.*date.*rollback/i);
});
test('force cannot bypass Debian stable rollback protection', () => {
  const previous = debianManifest({ fingerprint: 'same', version: '13.10' });
  const current = debianManifest({ fingerprint: 'same', version: '13.9' });
  assert.throws(() => compareFingerprints(current, previous, true), /Debian stable.*rollback/i);
});
test('change detector accepts a newer Debian point release', () => {
  const previous = debianManifest({ date: '2026-06-13T09:02:23.000Z', fingerprint: 'previous', version: '13.9' });
  const current = debianManifest({ fingerprint: 'current', version: '13.10' });
  assert.deepEqual(compareFingerprints(current, previous, false), fingerprintChanged);
});

test('change detector rejects a base image version rollback', () => {
  const previous = debianManifest({ fingerprint: 'previous' });
  previous.sources.base.armbianVersion = '26.08.0';
  const current = debianManifest({ fingerprint: 'current' });
  current.sources.base.armbianVersion = '26.07.0';
  assert.throws(() => compareFingerprints(current, previous, false), /Armbian.*rollback/i);
});

test('change detector rejects a kernel version rollback', () => {
  const previous = debianManifest({ fingerprint: 'previous' });
  previous.sources.kernel.version = '5.10.260';
  const current = debianManifest({ fingerprint: 'current' });
  current.sources.kernel.version = '5.10.259';
  assert.throws(() => compareFingerprints(current, previous, false), /kernel.*rollback/i);
});
test('change detector rejects a same-major Debian codename change', () => {
  const previous = debianManifest({ fingerprint: 'previous', version: '13.6' });
  const current = debianManifest({ codename: 'forky', fingerprint: 'current', version: '13.7' });
  assert.throws(() => compareFingerprints(current, previous, false), /Debian stable.*codename/i);
});
test('change detector accepts a newer Debian major and codename transition', () => {
  const previous = debianManifest({ fingerprint: 'previous', version: '13.6' });
  const current = debianManifest({
    codename: 'forky', date: '2027-08-01T09:02:23.000Z', fingerprint: 'current', version: '14.0',
  });
  assert.deepEqual(compareFingerprints(current, previous, false), fingerprintChanged);
});
test('schema 2 migration rejects Debian major rollback and same-major codename changes', () => {
  const previous = schema2Manifest();
  const older = debianManifest({ codename: 'bookworm', fingerprint: 'older', version: '12.12' });
  const renamed = debianManifest({ codename: 'forky', fingerprint: 'renamed', version: '13.6' });
  assert.throws(() => compareFingerprints(older, previous, false), /Debian stable.*major.*rollback/i);
  assert.throws(() => compareFingerprints(renamed, previous, false), /Debian stable.*codename/i);
});
test('schema 1 previous manifests retain fingerprint comparison compatibility', () => {
  const previous = schema2Manifest({ fingerprint: 'previous' });
  previous.schemaVersion = 1;
  delete previous.board.distributionVersion;
  const current = debianManifest({ fingerprint: 'current' });
  assert.deepEqual(compareFingerprints(current, previous, false), fingerprintChanged);
});
test('published state requires a matching successful validation report', () => {
  const report = {
    status: 'container-valid / hardware-unverified',
    image: 'out/candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    rawSha256: 'b'.repeat(64),
    manifestFingerprint: validManifest.fingerprint,
    checks: {
      gzip: true,
      partitionTable: true,
      fatBoot: true,
      ext4Rootfs: true,
      debianTrixie: true,
      bootFiles: true,
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
      androidUserspaceAbsent: true,
    },
  };

  assert.equal(validatePublishedState(validManifest, report), validManifest);
  assert.throws(
    () => validatePublishedState(validManifest, { ...report, manifestFingerprint: '0'.repeat(64) }),
    /fingerprint/i,
  );
  assert.throws(() => validatePublishedState(validManifest, null), /validation report/i);
  assert.throws(
    () => validatePublishedState(validManifest, { ...report, checks: { ...report.checks, packageState: false } }),
    /packageState/i,
  );
});

test('identity-marked manifests require the imageIdentity validation check', () => {
  const marked = buildManifest({
    ...structuredClone(validManifest),
    recipe: {
      ...structuredClone(validManifest.recipe),
      files: {
        ...structuredClone(validManifest.recipe.files),
        [IMAGE_IDENTITY_RECIPE_MARKER]: 'c'.repeat(64),
      },
    },
  });
  const report = {
    status: 'container-valid / hardware-unverified',
    image: 'out/candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    rawSha256: 'b'.repeat(64),
    manifestFingerprint: marked.fingerprint,
    checks: {
      gzip: true,
      partitionTable: true,
      fatBoot: true,
      ext4Rootfs: true,
      debianTrixie: true,
      bootFiles: true,
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
      androidUserspaceAbsent: true,
    },
  };

  assert.throws(() => validatePublishedState(marked, report), /imageIdentity/);
  report.checks.imageIdentity = true;
  assert.equal(validatePublishedState(marked, report), marked);
  const historical = structuredClone(report);
  historical.manifestFingerprint = validManifest.fingerprint;
  delete historical.checks.imageIdentity;
  assert.doesNotThrow(() => validatePublishedState(validManifest, historical));
});

test('schemaVersion 5 requires Debian stable validation while schemas 1-4 remain compatible', () => {
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
    stockRecoveryFallbackPresent: true,
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
  };
  const report = {
    schemaVersion: 5,
    status: 'container-valid / hardware-unverified',
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    rawSha256: 'b'.repeat(64),
    manifestFingerprint: validManifest.fingerprint,
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256',
      filesystemManifestSha256: 'd'.repeat(64),
      bootComponents: 'boot-components.json',
      bootComponentsSha256: 'e'.repeat(64),
    },
    checks,
    androidScan: {
      schemaVersion: 1,
      findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] },
    },
  };

  assert.equal(validatePublishedState(validManifest, report), validManifest);
  const mismatchedReport = structuredClone(report);
  delete mismatchedReport.checks.debianStableRelease;
  mismatchedReport.checks.debianTrixie = true;
  assert.throws(() => validatePublishedState(validManifest, mismatchedReport), /debianStableRelease/);

  for (const schemaVersion of [2, 3, 4]) {
    const legacyReport = structuredClone(report);
    legacyReport.schemaVersion = schemaVersion;
    delete legacyReport.checks.debianStableRelease;
    legacyReport.checks.debianTrixie = true;
    if (schemaVersion === 3) {
      delete legacyReport.checks.stockBootScriptStaticPathValid;
      delete legacyReport.checks.primaryBootScriptAndroidFallbackAbsent;
      delete legacyReport.checks.stockRecoveryFallbackPresent;
      legacyReport.checks.stockBootScriptReachable = true;
    }
    assert.equal(validatePublishedState(validManifest, legacyReport), validManifest);
  }
});

test('published state rejects manifest and report schema mismatches', () => {
  const board = JSON.parse(readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'));
  const schema5Manifest = buildManifest({
    ...validManifest,
    schemaVersion: 5,
    board: { ...validManifest.board, dtb: board.dtb, dtbBuild: board.dtbBuild },
  });
  for (const schemaVersion of [6, 7]) {
    assert.throws(
      () => validatePublishedState(schema5Manifest, {
        schemaVersion,
        status: 'container-valid / hardware-unverified',
        manifestFingerprint: schema5Manifest.fingerprint,
      }),
      /manifest schema 5 requires validation report schema 8/,
    );
  }
  assert.throws(
    () => validatePublishedState(validManifest, {
      schemaVersion: 7,
      status: 'container-valid / hardware-unverified',
      manifestFingerprint: validManifest.fingerprint,
    }),
    /manifest schema 4 cannot use validation report schema 7/,
  );
});

test('published release assets must be complete and match the validated image', () => {
  const asset = (name, digest = 'c'.repeat(64)) => ({
    name,
    state: 'uploaded',
    size: 1024,
    digest: `sha256:${digest}`,
  });
  const report = { image: 'out/candidate.img.gz', imageSha256: 'a'.repeat(64) };
  const release = {
    isDraft: false,
    isPrerelease: true,
    assets: [
      asset('candidate.img.gz', 'a'.repeat(64)),
      asset('SHA256SUMS'),
      asset('build-input-heads.json'),
      asset('release-tag.txt'),
      asset('resolved-sources.json'),
      asset('validation-report.json'),
    ],
  };

  assert.equal(validateReleaseAssets(report, release).name, 'candidate.img.gz');
  assert.throws(
    () => validateReleaseAssets(report, { ...release, assets: release.assets.slice(1) }),
    /exactly one/i,
  );
  assert.throws(
    () => validateReleaseAssets({ ...report, imageSha256: '0'.repeat(64) }, release),
    /digest/i,
  );
  assert.throws(
    () => validateReleaseAssets(report, { ...release, assets: [...release.assets, asset('boot.img')] }),
    /unexpected release asset/i,
  );
});

test('schemaVersion 2 release binds validation evidence digests', () => {
  const asset = (name, digest = 'c'.repeat(64)) => ({
    name,
    state: 'uploaded',
    size: 1024,
    digest: `sha256:${digest}`,
  });
  const report = {
    schemaVersion: 2,
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256',
      filesystemManifestSha256: 'd'.repeat(64),
      bootComponents: 'boot-components.json',
      bootComponentsSha256: 'e'.repeat(64),
    },
  };
  const release = {
    isDraft: false,
    isPrerelease: true,
    assets: [
      asset('Armbian_candidate.img.gz', 'a'.repeat(64)),
      asset('SHA256SUMS'),
      asset('build-input-heads.json'),
      asset('release-tag.txt'),
      asset('resolved-sources.json'),
      asset('validation-report.json'),
      asset('filesystem-manifest.sha256', 'd'.repeat(64)),
      asset('boot-components.json', 'e'.repeat(64)),
    ],
  };

  assert.equal(validateReleaseAssets(report, release).name, 'Armbian_candidate.img.gz');
  const tampered = structuredClone(release);
  tampered.assets.find(({ name }) => name === 'boot-components.json').digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => validateReleaseAssets(report, tampered), /boot components evidence digest/i);
});

test('schemaVersion 6 release requires source-built U-Boot evidence', () => {
  const asset = (name, digest = 'c'.repeat(64)) => ({
    name,
    state: 'uploaded',
    size: 1024,
    digest: `sha256:${digest}`,
  });
  const report = {
    schemaVersion: 6,
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256',
      filesystemManifestSha256: 'd'.repeat(64),
      bootComponents: 'boot-components.json',
      bootComponentsSha256: 'e'.repeat(64),
      ubootBuild: 'uboot-build.json',
      ubootBuildSha256: 'f'.repeat(64),
      ubootSourceArchive: 'u-boot-source.tar.gz',
      ubootSourceArchiveSha256: '7'.repeat(64),
      thirdPartySources: 'THIRD_PARTY_SOURCES.md',
      thirdPartySourcesSha256: '8'.repeat(64),
    },
  };
  const release = {
    isDraft: false,
    isPrerelease: true,
    assets: [
      asset('Armbian_candidate.img.gz', 'a'.repeat(64)),
      asset('SHA256SUMS'),
      asset('build-input-heads.json'),
      asset('release-tag.txt'),
      asset('resolved-sources.json'),
      asset('validation-report.json'),
      asset('filesystem-manifest.sha256', 'd'.repeat(64)),
      asset('boot-components.json', 'e'.repeat(64)),
      asset('uboot-build.json', 'f'.repeat(64)),
      asset('u-boot-source.tar.gz', '7'.repeat(64)),
      asset('THIRD_PARTY_SOURCES.md', '8'.repeat(64)),
    ],
  };

  assert.equal(validateReleaseAssets(report, release).name, 'Armbian_candidate.img.gz');
  const missing = structuredClone(release);
  missing.assets = missing.assets.filter(({ name }) => name !== 'uboot-build.json');
  assert.throws(() => validateReleaseAssets(report, missing), /uboot-build\.json/i);
  const tampered = structuredClone(release);
  tampered.assets.find(({ name }) => name === 'uboot-build.json').digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateReleaseAssets(report, tampered), /U-Boot build evidence digest/i);
  const missingSource = structuredClone(release);
  missingSource.assets = missingSource.assets.filter(({ name }) => name !== 'u-boot-source.tar.gz');
  assert.throws(() => validateReleaseAssets(report, missingSource), /u-boot-source\.tar\.gz/i);
  const missingSourceDocument = structuredClone(release);
  missingSourceDocument.assets = missingSourceDocument.assets.filter(({ name }) => name !== 'THIRD_PARTY_SOURCES.md');
  assert.throws(() => validateReleaseAssets(report, missingSourceDocument), /THIRD_PARTY_SOURCES\.md/i);
});

test('schemaVersion 8 release requires source-built DTB and QEMU evidence assets', () => {
  const asset = (name, digest = 'c'.repeat(64)) => ({
    name,
    state: 'uploaded',
    size: 1024,
    digest: `sha256:${digest}`,
  });
  const report = {
    schemaVersion: 8,
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    evidence: {
      filesystemManifestSha256: 'd'.repeat(64),
      bootComponentsSha256: 'e'.repeat(64),
      ubootBuildSha256: 'f'.repeat(64),
      ubootSourceArchiveSha256: '7'.repeat(64),
      thirdPartySourcesSha256: '8'.repeat(64),
      sourceBuiltDeviceTree: {
        buildSha256: '9'.repeat(64),
        sourceSha256: '6'.repeat(64),
      },
      qemuSystemSmokeSha256: '5'.repeat(64),
      qemuSystemConsoleSha256: '4'.repeat(64),
      qemuSystemSmoke: 'qemu-system-smoke.json',
      qemuSystemConsole: 'qemu-system-smoke.log',
    },
  };
  const release = {
    isDraft: false,
    isPrerelease: true,
    assets: [
      asset('Armbian_candidate.img.gz', 'a'.repeat(64)),
      asset('SHA256SUMS'),
      asset('build-input-heads.json'),
      asset('release-tag.txt'),
      asset('resolved-sources.json'),
      asset('validation-report.json'),
      asset('filesystem-manifest.sha256', 'd'.repeat(64)),
      asset('boot-components.json', 'e'.repeat(64)),
      asset('uboot-build.json', 'f'.repeat(64)),
      asset('u-boot-source.tar.gz', '7'.repeat(64)),
      asset('THIRD_PARTY_SOURCES.md', '8'.repeat(64)),
      asset('source-built-dtb.json', '9'.repeat(64)),
      asset('device-tree-source.dts', '6'.repeat(64)),
      asset('qemu-system-smoke.json', '5'.repeat(64)),
      asset('qemu-system-smoke.log', '4'.repeat(64)),
    ],
  };

  assert.equal(validateReleaseAssets(report, release).name, 'Armbian_candidate.img.gz');
  for (const name of [
    'source-built-dtb.json',
    'device-tree-source.dts',
    'qemu-system-smoke.json',
    'qemu-system-smoke.log',
  ]) {
    const missing = structuredClone(release);
    missing.assets = missing.assets.filter((entry) => entry.name !== name);
    assert.throws(() => validateReleaseAssets(report, missing), new RegExp(name.replace('.', '\\.')));
  }
  const tampered = structuredClone(release);
  tampered.assets.find(({ name }) => name === 'source-built-dtb.json').digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateReleaseAssets(report, tampered), /source-built DTB evidence digest/i);
  const tamperedQemu = structuredClone(release);
  tamperedQemu.assets.find(({ name }) => name === 'qemu-system-smoke.log').digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateReleaseAssets(report, tamperedQemu), /QEMU system console evidence digest/i);
});

test('schemaVersion 6 requires a pure Armbian installer script check', () => {
  const report = {
    schemaVersion: 6,
    status: 'container-valid / hardware-unverified',
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    rawSha256: 'b'.repeat(64),
    manifestFingerprint: validManifest.fingerprint,
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256',
      filesystemManifestSha256: 'd'.repeat(64),
      bootComponents: 'boot-components.json',
      bootComponentsSha256: 'e'.repeat(64),
      ubootBuild: 'uboot-build.json',
      ubootBuildSha256: 'f'.repeat(64),
      ubootSourceArchive: 'u-boot-source.tar.gz',
      ubootSourceArchiveSha256: '7'.repeat(64),
      thirdPartySources: 'THIRD_PARTY_SOURCES.md',
      thirdPartySourcesSha256: '8'.repeat(64),
    },
    checks: {
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
    },
    androidScan: {
      schemaVersion: 1,
      findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] },
    },
  };

  assert.equal(validatePublishedState(validManifest, report), validManifest);
  delete report.checks.installerBootScriptAndroidFallbackAbsent;
  report.checks.stockRecoveryFallbackPresent = true;
  assert.throws(() => validatePublishedState(validManifest, report), /installerBootScriptAndroidFallbackAbsent/);
});
