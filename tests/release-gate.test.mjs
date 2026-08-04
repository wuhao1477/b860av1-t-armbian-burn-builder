import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateDraftReleaseForPublication } from '../src/change-detection.mjs';
import { releaseTagForManifest, validateReleaseTag } from '../src/release.mjs';

const manifest = JSON.parse(fs.readFileSync(
  new URL('./fixtures/valid-resolved-sources.json', import.meta.url),
  'utf8',
));

const checks = {
  gzip: true,
  partitionTable: true,
  fatBoot: true,
  ext4Rootfs: true,
  debianTrixie: true,
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

function asset(name, digest = 'c'.repeat(64)) {
  return { name, state: 'uploaded', size: 1024, digest: `sha256:${digest}` };
}

function releaseFixture(tag) {
  const report = {
    schemaVersion: 4,
    status: 'container-valid / hardware-unverified',
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    rawSha256: 'b'.repeat(64),
    manifestFingerprint: manifest.fingerprint,
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
  const release = {
    tagName: tag,
    isDraft: true,
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
  return { release, report };
}

function localAssetsFor(release) {
  return release.assets.map(({ name, size, digest }) => ({
    name,
    size,
    digest: digest.replace(/^sha256:/i, '').toLowerCase(),
  }));
}

test('schemaVersion 3 release tag exposes the full Debian stable version', () => {
  const pointReleaseManifest = structuredClone(manifest);
  pointReleaseManifest.sources.debian.version = '13.6';
  const tag = releaseTagForManifest(pointReleaseManifest, 18, 1);

  assert.equal(tag, 'armbian-26.08.0-debian-13.6-trixie-k5.10.260-build-18.1');
  assert.equal(validateReleaseTag(tag, pointReleaseManifest, 18, 1), tag);
});

test('current source-built release gate requires pure Armbian installer evidence', () => {
  const currentChecks = {
    ...checks,
    debianStableRelease: true,
    installerBootScriptAndroidFallbackAbsent: true,
    sourceBuiltUbootOverload: true,
  };
  delete currentChecks.debianTrixie;
  delete currentChecks.stockRecoveryFallbackPresent;
  const currentReport = {
    schemaVersion: 6,
    status: 'container-valid / hardware-unverified',
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'a'.repeat(64),
    rawSha256: 'b'.repeat(64),
    manifestFingerprint: manifest.fingerprint,
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
    checks: currentChecks,
    androidScan: {
      schemaVersion: 1,
      findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] },
    },
  };
  const tag = releaseTagForManifest(manifest, 18, 1);
  const release = {
    tagName: tag,
    isDraft: true,
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
  const localAssets = localAssetsFor(release);

  assert.equal(
    validateDraftReleaseForPublication(manifest, currentReport, release, tag, tag, localAssets).name,
    'Armbian_candidate.img.gz',
  );
  delete currentReport.checks.installerBootScriptAndroidFallbackAbsent;
  currentReport.checks.stockRecoveryFallbackPresent = true;
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, currentReport, release, tag, tag, localAssets),
    /installerBootScriptAndroidFallbackAbsent/,
  );
});

test('schemaVersion 1 release tag preserves the historical codename-only format', () => {
  const legacyManifest = structuredClone(manifest);
  legacyManifest.schemaVersion = 1;
  delete legacyManifest.board.distributionVersion;
  delete legacyManifest.sources.debian;

  assert.equal(
    releaseTagForManifest(legacyManifest, 8, 1),
    'armbian-26.08.0-debian-trixie-k5.10.260-build-8.1',
  );
});

test('schemaVersion 2 release tag preserves the Debian major version', () => {
  const tag = releaseTagForManifest(manifest, 8, 1);
  const legacyManifest = structuredClone(manifest);
  legacyManifest.schemaVersion = 2;
  delete legacyManifest.sources.debian;

  assert.equal(
    releaseTagForManifest(legacyManifest, 8, 1),
    'armbian-26.08.0-debian-13-trixie-k5.10.260-build-8.1',
  );
  assert.equal(validateReleaseTag(tag, manifest, 8, 1), tag);
  assert.throws(
    () => validateReleaseTag(tag.replace('debian-13', 'debian-12'), manifest, 8, 1),
    /does not match/i,
  );
});

test('draft release is revalidated from GitHub metadata before publication', () => {
  const tag = releaseTagForManifest(manifest, 8, 1);
  const { release, report } = releaseFixture(tag);
  const localAssets = localAssetsFor(release);

  assert.equal(
    validateDraftReleaseForPublication(manifest, report, release, tag, `${tag}\n`, localAssets).name,
    'Armbian_candidate.img.gz',
  );
  assert.throws(
    () => validateDraftReleaseForPublication(
      manifest,
      report,
      { ...release, tagName: 'wrong' },
      tag,
      tag,
      localAssets,
    ),
    /tag/i,
  );
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, report, release, tag, 'wrong\n', localAssets),
    /tag/i,
  );
  assert.throws(
    () => validateDraftReleaseForPublication(
      manifest,
      report,
      { ...release, assets: release.assets.filter(({ name }) => name !== 'SHA256SUMS') },
      tag,
      tag,
      localAssets,
    ),
    /missing or incomplete/i,
  );
  const wrongSize = structuredClone(release);
  wrongSize.assets.find(({ name }) => name === 'resolved-sources.json').size += 1;
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, report, wrongSize, tag, tag, localAssets),
    /size does not match/i,
  );
  const wrongDigest = structuredClone(release);
  wrongDigest.assets.find(({ name }) => name === 'build-input-heads.json').digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, report, wrongDigest, tag, tag, localAssets),
    /digest does not match/i,
  );
  const contaminated = structuredClone(report);
  contaminated.androidScan.findings.initrd.push('neutral.conf: androidboot marker');
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, contaminated, release, tag, tag, localAssets),
    /Android scan/i,
  );
  const invalidStaticPath = structuredClone(report);
  delete invalidStaticPath.checks.stockBootScriptStaticPathValid;
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, invalidStaticPath, release, tag, tag, localAssets),
    /stockBootScriptStaticPathValid/,
  );
  const primaryFallback = structuredClone(report);
  delete primaryFallback.checks.primaryBootScriptAndroidFallbackAbsent;
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, primaryFallback, release, tag, tag, localAssets),
    /primaryBootScriptAndroidFallbackAbsent/,
  );
  const recoveryFallback = structuredClone(report);
  delete recoveryFallback.checks.stockRecoveryFallbackPresent;
  assert.throws(
    () => validateDraftReleaseForPublication(manifest, recoveryFallback, release, tag, tag, localAssets),
    /stockRecoveryFallbackPresent/,
  );
});
