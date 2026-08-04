import { validateManifest } from './upstream.mjs';
import {
  HARDWARE_CAPABILITY_ASSET,
  requiresHardwareCapabilityValidation,
} from './hardware-capabilities.mjs';
import { requiresImageIdentity } from './image-identity.mjs';

export const CURRENT_VALIDATION_SCHEMA = 8;
const REQUIRED_RELEASE_ASSETS = [
  'SHA256SUMS',
  'build-input-heads.json',
  'release-tag.txt',
  'resolved-sources.json',
  'validation-report.json',
];
const V2_RELEASE_ASSETS = ['filesystem-manifest.sha256', 'boot-components.json'];
const V6_RELEASE_ASSETS = ['uboot-build.json', 'u-boot-source.tar.gz', 'THIRD_PARTY_SOURCES.md'];
const V7_RELEASE_ASSETS = ['source-built-dtb.json', 'device-tree-source.dts'];
const V8_RELEASE_ASSETS = ['qemu-system-smoke.json', 'qemu-system-smoke.log'];
const RTL8189FS_RELEASE_ASSET = 'rtl8189fs-driver.json';
const ALLOWED_RELEASE_ASSETS = [
  ...REQUIRED_RELEASE_ASSETS,
  ...V2_RELEASE_ASSETS,
  ...V6_RELEASE_ASSETS,
  ...V7_RELEASE_ASSETS,
  ...V8_RELEASE_ASSETS,
  RTL8189FS_RELEASE_ASSET,
  HARDWARE_CAPABILITY_ASSET,
];
const OPTIONAL_DEVICE_EVIDENCE_ASSET = /^device-(?:validation-[0-9a-f]{16}\.(?:json|md)|serial-[0-9a-f]{16}\.log)$/;
const ANDROID_SCAN_SCOPES = ['rootfs', 'boot', 'initrd', 'bootConfig', 'dtb'];

function requiresRtl8189fsValidation(manifest) {
  const files = manifest.recipe?.files ?? {};
  const names = ['scripts/validate-rtl8189fs.mjs', 'src/rtl8189fs.mjs'];
  const present = names.filter((name) => Object.hasOwn(files, name));
  if (present.length !== 0 && present.length !== names.length) {
    throw new Error('RTL8189FS validation recipe is incomplete');
  }
  return present.length === names.length;
}

function valueOfFingerprint(value, label) {
  const fingerprint = typeof value === 'string' ? value : value?.fingerprint;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError(`${label} fingerprint must be a non-empty string`);
  }
  return fingerprint;
}

function compareNumericVersions(current, previous) {
  if (typeof current !== 'string' || !/^\d+(?:\.\d+)*$/.test(current)
    || typeof previous !== 'string' || !/^\d+(?:\.\d+)*$/.test(previous)) {
    throw new Error('Debian stable version baseline is invalid');
  }
  const currentParts = current.split('.').map(Number);
  const previousParts = previous.split('.').map(Number);
  const length = Math.max(currentParts.length, previousParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (currentParts[index] ?? 0) - (previousParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function rejectSignedDebianRollback(current, previous) {
  if (current.schemaVersion < 3) {
    throw new Error('Debian stable manifest schema rollback is not allowed');
  }
  const currentDebian = current.sources.debian;
  const previousDebian = previous.sources.debian;
  if (compareNumericVersions(currentDebian.version, previousDebian.version) < 0) {
    throw new Error('Debian stable version rollback is not allowed');
  }
  if (Date.parse(currentDebian.date) < Date.parse(previousDebian.date)) {
    throw new Error('Debian stable date rollback is not allowed');
  }
  if (currentDebian.majorVersion === previousDebian.majorVersion
    && currentDebian.codename !== previousDebian.codename) {
    throw new Error('Debian stable codename cannot change within the same major version');
  }
}

function rejectSchema2MigrationRollback(current, previous) {
  const currentMajor = current.board.distributionVersion;
  const previousMajor = previous.board.distributionVersion;
  const majorComparison = compareNumericVersions(currentMajor, previousMajor);
  if (majorComparison < 0) {
    throw new Error('Debian stable major rollback is not allowed');
  }
  if (majorComparison === 0
    && current.board.distribution !== previous.board.distribution) {
    throw new Error('Debian stable codename cannot change within the same major version');
  }
}

function rejectDebianStableRollback(current, previous) {
  const currentIsManifest = current && typeof current === 'object' && !Array.isArray(current);
  const previousIsManifest = previous && typeof previous === 'object' && !Array.isArray(previous);
  if (!currentIsManifest || !previousIsManifest) return;
  if (previous.schemaVersion >= 3) rejectSignedDebianRollback(current, previous);
  else if (previous.schemaVersion === 2) rejectSchema2MigrationRollback(current, previous);
}

function rejectUpstreamVersionRollback(current, previous) {
  const currentIsManifest = current && typeof current === 'object' && !Array.isArray(current);
  const previousIsManifest = previous && typeof previous === 'object' && !Array.isArray(previous);
  if (!currentIsManifest || !previousIsManifest) return;
  const versions = [
    ['Armbian', current.sources?.base?.armbianVersion, previous.sources?.base?.armbianVersion],
    ['kernel', current.sources?.kernel?.version, previous.sources?.kernel?.version],
  ];
  for (const [label, currentVersion, previousVersion] of versions) {
    if (compareNumericVersions(currentVersion, previousVersion) < 0) {
      throw new Error(`${label} version rollback is not allowed`);
    }
  }
}

export function compareFingerprints(current, previous, force = false) {
  rejectUpstreamVersionRollback(current, previous);
  rejectDebianStableRollback(current, previous);
  if (force === true || force === 'true') return { changed: true, reason: 'forced' };
  const currentFingerprint = valueOfFingerprint(current, 'current');
  if (previous === null || previous === undefined) {
    return { changed: true, reason: 'no-previous-release' };
  }
  const previousFingerprint = valueOfFingerprint(previous, 'previous');
  if (currentFingerprint === previousFingerprint) return { changed: false, reason: 'unchanged' };
  return { changed: true, reason: 'fingerprint-changed' };
}

export function validatePublishedState(manifest, report) {
  const validated = validateManifest(manifest);
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('validation report must be an object');
  }
  const reportSchemaVersion = report.schemaVersion ?? 1;
  if ((validated.schemaVersion >= 5 && reportSchemaVersion !== CURRENT_VALIDATION_SCHEMA)
    || (validated.schemaVersion < 5 && reportSchemaVersion >= 7)) {
    throw new Error(
      validated.schemaVersion >= 5
        ? `manifest schema ${validated.schemaVersion} requires validation report schema ${CURRENT_VALIDATION_SCHEMA}`
        : `manifest schema ${validated.schemaVersion} cannot use validation report schema ${reportSchemaVersion}`,
    );
  }
  if (report.status !== 'container-valid / hardware-unverified') {
    throw new Error('validation report status is invalid');
  }
  const schemaVersion = report.schemaVersion ?? 1;
  if (![1, 2, 3, 4, 5, 6, 7, CURRENT_VALIDATION_SCHEMA].includes(schemaVersion)) {
    throw new Error('validation report schemaVersion is unsupported');
  }
  if (report.manifestFingerprint !== validated.fingerprint) {
    throw new Error('validation report fingerprint does not match manifest');
  }
  for (const field of ['imageSha256', 'rawSha256']) {
    if (typeof report[field] !== 'string' || !/^[0-9a-f]{64}$/.test(report[field])) {
      throw new Error(`validation report ${field} is invalid`);
    }
  }
  const checks = report.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    throw new Error('validation report checks are missing');
  }
  const rtl8189fsRequired = requiresRtl8189fsValidation(validated);
  const rtl8189fsReported = Object.hasOwn(checks, 'rtl8189fsDriver');
  const hardwareRequired = requiresHardwareCapabilityValidation(validated);
  const hardwareReported = Object.hasOwn(checks, 'hardwareCapabilities');
  const identityRequired = requiresImageIdentity(validated);
  const identityReported = Object.hasOwn(checks, 'imageIdentity');
  const requiredChecks = [
    'gzip',
    'partitionTable',
    'fatBoot',
    'ext4Rootfs',
    schemaVersion >= 5 ? 'debianStableRelease' : 'debianTrixie',
    'bootFiles',
    'kernelArchitecture',
    'dtbCompatible',
    'rootfsLabel',
    'userspaceSmoke',
    'packageState',
    'sshUnit',
    'imageFits8GB',
    'mbrBootstrapEmpty',
    'mbrReservedBytesEmpty',
    'partitionStartMatchesManifest',
    'persistentBootloaderAbsent',
    'bootloaderPayloadsExcluded',
    'legacyUbootPayloadsAbsent',
    ...(identityRequired || identityReported ? ['imageIdentity'] : []),
    ...(schemaVersion === 1
      ? ['androidUserspaceAbsent']
      : [
        'debianIdentity',
        'armbianIdentity',
        'knownAndroidMarkersAbsent',
        'initrdKnownAndroidMarkersAbsent',
        'bootConfigKnownAndroidMarkersAbsent',
        'dtbKnownAndroidMarkersAbsent',
        'filesystemManifestCreated',
        'bootComponentsRecorded',
        'ubootOverloadProvenance',
        ...(schemaVersion >= 6 ? ['sourceBuiltUbootOverload'] : []),
        ...(schemaVersion >= 7 ? ['sourceBuiltDeviceTree'] : []),
        ...(schemaVersion >= CURRENT_VALIDATION_SCHEMA ? ['qemuSystemBootSmoke'] : []),
        ...(rtl8189fsRequired || rtl8189fsReported ? ['rtl8189fsDriver'] : []),
        ...(hardwareRequired || hardwareReported ? ['hardwareCapabilities'] : []),
      ]),
  ];
  for (const check of requiredChecks) {
    if (checks[check] !== true) throw new Error(`validation check failed: ${check}`);
  }
  if (schemaVersion === 3) {
    for (const check of ['memoryLimitApplied', 'stockBootScriptReachable']) {
      if (checks[check] !== true) throw new Error(`validation check failed: ${check}`);
    }
  }
  if (schemaVersion >= 4) {
    const bootScriptChecks = [
      'memoryLimitApplied',
      'stockBootScriptStaticPathValid',
      'primaryBootScriptAndroidFallbackAbsent',
      schemaVersion >= 6
        ? 'installerBootScriptAndroidFallbackAbsent'
        : 'stockRecoveryFallbackPresent',
    ];
    for (const check of bootScriptChecks) {
      if (checks[check] !== true) throw new Error(`validation check failed: ${check}`);
    }
  }
  if (schemaVersion >= 2) {
    const evidence = report.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new Error('validation report evidence is missing');
    }
    if (evidence.filesystemManifest !== 'filesystem-manifest.sha256'
      || evidence.bootComponents !== 'boot-components.json') {
      throw new Error('validation report evidence names are invalid');
    }
    for (const field of ['filesystemManifestSha256', 'bootComponentsSha256']) {
      if (typeof evidence[field] !== 'string' || !/^[0-9a-f]{64}$/.test(evidence[field])) {
        throw new Error(`validation report ${field} is invalid`);
      }
    }
    if (schemaVersion >= 6) {
      if (evidence.ubootBuild !== 'uboot-build.json'
        || typeof evidence.ubootBuildSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(evidence.ubootBuildSha256)) {
        throw new Error('validation report U-Boot build evidence is invalid');
      }
      if (evidence.ubootSourceArchive !== 'u-boot-source.tar.gz'
        || typeof evidence.ubootSourceArchiveSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(evidence.ubootSourceArchiveSha256)) {
        throw new Error('validation report U-Boot source archive evidence is invalid');
      }
      if (evidence.thirdPartySources !== 'THIRD_PARTY_SOURCES.md'
        || typeof evidence.thirdPartySourcesSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(evidence.thirdPartySourcesSha256)) {
        throw new Error('validation report third-party source evidence is invalid');
      }
    }
    if (schemaVersion >= 7) {
      const dtb = evidence.sourceBuiltDeviceTree;
      if (!dtb || typeof dtb !== 'object' || Array.isArray(dtb)
        || dtb.build !== 'source-built-dtb.json'
        || dtb.source !== 'device-tree-source.dts'
        || !/^[0-9a-f]{64}$/.test(dtb.buildSha256 ?? '')
        || !/^[0-9a-f]{64}$/.test(dtb.sourceSha256 ?? '')
        || dtb.sourceSha256 !== validated.board.dtbBuild?.sourceSha256) {
        throw new Error('validation report source-built DTB evidence is invalid');
      }
    }
    if (schemaVersion >= CURRENT_VALIDATION_SCHEMA) {
      if (evidence.qemuSystemSmoke !== 'qemu-system-smoke.json'
        || evidence.qemuSystemConsole !== 'qemu-system-smoke.log'
        || !/^[0-9a-f]{64}$/.test(evidence.qemuSystemSmokeSha256 ?? '')
        || !/^[0-9a-f]{64}$/.test(evidence.qemuSystemConsoleSha256 ?? '')) {
        throw new Error('validation report QEMU system smoke evidence is invalid');
      }
    }
    if (rtl8189fsRequired || rtl8189fsReported) {
      if (evidence.rtl8189fsDriver !== RTL8189FS_RELEASE_ASSET
        || !/^[0-9a-f]{64}$/.test(evidence.rtl8189fsDriverSha256 ?? '')) {
        throw new Error('validation report RTL8189FS evidence is invalid');
      }
    }
    if (hardwareRequired || hardwareReported) {
      if (evidence.hardwareCapabilities !== HARDWARE_CAPABILITY_ASSET
        || !/^[0-9a-f]{64}$/.test(evidence.hardwareCapabilitiesSha256 ?? '')) {
        throw new Error('validation report hardware capability evidence is invalid');
      }
    }
  }
  if (schemaVersion >= 3) {
    const scan = report.androidScan;
    if (scan?.schemaVersion !== 1 || !scan.findings || typeof scan.findings !== 'object') {
      throw new Error('Android scan evidence is missing');
    }
    for (const scope of ANDROID_SCAN_SCOPES) {
      if (!Array.isArray(scan.findings[scope]) || scan.findings[scope].length !== 0) {
        throw new Error(`Android scan evidence is not clean: ${scope}`);
      }
    }
  }
  return validated;
}

function releaseAssetMap(release, allowDraft = false) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('release metadata must be an object');
  }
  if ((!allowDraft && release.isDraft) || !release.isPrerelease || !Array.isArray(release.assets)) {
    throw new Error('release metadata is not a published prerelease');
  }
  const assets = new Map();
  for (const asset of release.assets) {
    if (assets.has(asset?.name)) throw new Error(`duplicate release asset: ${asset?.name}`);
    if (typeof asset?.name !== 'string' || (
      !ALLOWED_RELEASE_ASSETS.includes(asset.name)
      && !asset.name.endsWith('.img.gz')
      && !OPTIONAL_DEVICE_EVIDENCE_ASSET.test(asset.name)
    )) {
      throw new Error(`unexpected release asset: ${asset?.name}`);
    }
    assets.set(asset?.name, asset);
  }
  return assets;
}

function validateAsset(asset, name) {
  if (!asset || asset.state !== 'uploaded' || !Number.isInteger(asset.size) || asset.size <= 0) {
    throw new Error(`release asset is missing or incomplete: ${name}`);
  }
  const digest = typeof asset.digest === 'string'
    ? asset.digest.replace(/^sha256:/i, '').toLowerCase()
    : '';
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`release asset digest is invalid: ${name}`);
  return digest;
}

function validateExpectedAssets(releaseAssets, expectedAssets) {
  if (!Array.isArray(expectedAssets)) throw new Error('local release asset metadata is required');
  const expected = new Map();
  for (const asset of expectedAssets) {
    if (typeof asset?.name !== 'string' || expected.has(asset.name)) {
      throw new Error(`local release asset metadata is invalid: ${asset?.name}`);
    }
    expected.set(asset.name, asset);
  }
  for (const [name, releaseAsset] of releaseAssets) {
    const localAsset = expected.get(name);
    if (!localAsset) throw new Error(`local release asset metadata is missing: ${name}`);
    if (releaseAsset.size !== localAsset.size) {
      throw new Error(`release asset size does not match local file: ${name}`);
    }
    const localDigest = typeof localAsset.digest === 'string'
      ? localAsset.digest.replace(/^sha256:/i, '').toLowerCase()
      : '';
    if (!/^[0-9a-f]{64}$/.test(localDigest)) {
      throw new Error(`local release asset digest is invalid: ${name}`);
    }
    if (validateAsset(releaseAsset, name) !== localDigest) {
      throw new Error(`release asset digest does not match local file: ${name}`);
    }
  }
  if (expected.size !== releaseAssets.size) {
    throw new Error('local release asset metadata contains unexpected assets');
  }
}

export function validateReleaseAssets(report, release, options = {}) {
  const assets = releaseAssetMap(release, options.allowDraft === true);
  const schemaVersion = report?.schemaVersion ?? 1;
  const requiredAssets = schemaVersion >= 2
    ? [...REQUIRED_RELEASE_ASSETS, ...V2_RELEASE_ASSETS]
    : REQUIRED_RELEASE_ASSETS;
  if (schemaVersion >= 6) requiredAssets.push(...V6_RELEASE_ASSETS);
  if (schemaVersion >= 7) requiredAssets.push(...V7_RELEASE_ASSETS);
  if (schemaVersion >= CURRENT_VALIDATION_SCHEMA) requiredAssets.push(...V8_RELEASE_ASSETS);
  if (report.evidence?.rtl8189fsDriver === RTL8189FS_RELEASE_ASSET) {
    requiredAssets.push(RTL8189FS_RELEASE_ASSET);
  }
  if (report.evidence?.hardwareCapabilities === HARDWARE_CAPABILITY_ASSET) {
    requiredAssets.push(HARDWARE_CAPABILITY_ASSET);
  }
  for (const name of requiredAssets) validateAsset(assets.get(name), name);
  if (schemaVersion >= 2) {
    const filesystemDigest = validateAsset(assets.get('filesystem-manifest.sha256'), 'filesystem-manifest.sha256');
    const componentsDigest = validateAsset(assets.get('boot-components.json'), 'boot-components.json');
    if (filesystemDigest !== report.evidence?.filesystemManifestSha256) {
      throw new Error('filesystem manifest evidence digest does not match report');
    }
    if (componentsDigest !== report.evidence?.bootComponentsSha256) {
      throw new Error('boot components evidence digest does not match report');
    }
    if (schemaVersion >= 6) {
      const ubootBuildDigest = validateAsset(assets.get('uboot-build.json'), 'uboot-build.json');
      if (ubootBuildDigest !== report.evidence?.ubootBuildSha256) {
        throw new Error('U-Boot build evidence digest does not match report');
      }
      const sourceArchiveDigest = validateAsset(assets.get('u-boot-source.tar.gz'), 'u-boot-source.tar.gz');
      if (sourceArchiveDigest !== report.evidence?.ubootSourceArchiveSha256) {
        throw new Error('U-Boot source archive evidence digest does not match report');
      }
      const sourceDocumentDigest = validateAsset(assets.get('THIRD_PARTY_SOURCES.md'), 'THIRD_PARTY_SOURCES.md');
      if (sourceDocumentDigest !== report.evidence?.thirdPartySourcesSha256) {
        throw new Error('third-party source evidence digest does not match report');
      }
    }
    if (schemaVersion >= 7) {
      const dtbBuildDigest = validateAsset(assets.get('source-built-dtb.json'), 'source-built-dtb.json');
      if (dtbBuildDigest !== report.evidence?.sourceBuiltDeviceTree?.buildSha256) {
        throw new Error('source-built DTB evidence digest does not match report');
      }
      const dtbSourceDigest = validateAsset(assets.get('device-tree-source.dts'), 'device-tree-source.dts');
      if (dtbSourceDigest !== report.evidence?.sourceBuiltDeviceTree?.sourceSha256) {
        throw new Error('device tree source evidence digest does not match report');
      }
    }
    if (schemaVersion >= CURRENT_VALIDATION_SCHEMA) {
      const qemuSmokeDigest = validateAsset(assets.get('qemu-system-smoke.json'), 'qemu-system-smoke.json');
      if (qemuSmokeDigest !== report.evidence?.qemuSystemSmokeSha256) {
        throw new Error('QEMU system smoke evidence digest does not match report');
      }
      const qemuConsoleDigest = validateAsset(assets.get('qemu-system-smoke.log'), 'qemu-system-smoke.log');
      if (qemuConsoleDigest !== report.evidence?.qemuSystemConsoleSha256) {
        throw new Error('QEMU system console evidence digest does not match report');
      }
    }
    if (report.evidence?.rtl8189fsDriver === RTL8189FS_RELEASE_ASSET) {
      const driverDigest = validateAsset(assets.get(RTL8189FS_RELEASE_ASSET), RTL8189FS_RELEASE_ASSET);
      if (driverDigest !== report.evidence.rtl8189fsDriverSha256) {
        throw new Error('RTL8189FS evidence digest does not match report');
      }
    }
    if (report.evidence?.hardwareCapabilities === HARDWARE_CAPABILITY_ASSET) {
      const hardwareDigest = validateAsset(assets.get(HARDWARE_CAPABILITY_ASSET), HARDWARE_CAPABILITY_ASSET);
      if (hardwareDigest !== report.evidence.hardwareCapabilitiesSha256) {
        throw new Error('hardware capability evidence digest does not match report');
      }
    }
  }
  const images = [...assets.values()].filter((asset) => asset?.name?.endsWith('.img.gz'));
  if (images.length !== 1) throw new Error('release must contain exactly one .img.gz asset');
  if (schemaVersion >= 2 && !images[0].name.startsWith('Armbian_')) {
    throw new Error('release image name is not an Armbian image name');
  }
  const imageDigest = validateAsset(images[0], images[0].name);
  const reportImageName = typeof report?.image === 'string' ? report.image.split('/').at(-1) : '';
  if (reportImageName !== images[0].name) throw new Error('release image name does not match report');
  if (report.imageSha256 !== imageDigest) throw new Error('release image digest does not match report');
  if (options.expectedAssets !== undefined) validateExpectedAssets(assets, options.expectedAssets);
  return images[0];
}

export function validateDraftReleaseForPublication(
  manifest,
  report,
  release,
  expectedTag,
  releaseTagText,
  localAssets,
) {
  validatePublishedState(manifest, report);
  if (release?.isDraft !== true) throw new Error('release must remain a draft during final validation');
  if (typeof expectedTag !== 'string' || release?.tagName !== expectedTag) {
    throw new Error('GitHub release tag does not match the expected tag');
  }
  if (typeof releaseTagText !== 'string' || releaseTagText.trim() !== expectedTag) {
    throw new Error('release-tag.txt does not match the expected tag');
  }
  return validateReleaseAssets(report, release, { allowDraft: true, expectedAssets: localAssets });
}
