import { fingerprint as hashCanonical } from './canonical-json.mjs';
import { imageSizeLimit } from './board-limits.mjs';
import { validateDebianStable } from './debian-release.mjs';

function matcher(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern === 'string') return new RegExp(pattern);
  throw new TypeError('pattern must be a RegExp or string');
}

function matches(pattern, value) {
  const expression = matcher(pattern);
  expression.lastIndex = 0;
  return expression.test(value);
}

function releaseTime(release) {
  const value = release.published_at ?? release.created_at;
  const time = Date.parse(value ?? '');
  return Number.isNaN(time) ? -Infinity : time;
}

export function publishedMatchingReleases(releases, pattern) {
  if (!Array.isArray(releases)) throw new TypeError('releases must be an array');
  const candidates = releases.filter((release) => (
    release && !release.draft && !release.prerelease &&
    typeof release.tag_name === 'string' && matches(pattern, release.tag_name)
  ));
  if (candidates.length === 0) throw new Error('no matching release');
  return [...candidates].sort((a, b) => (
    releaseTime(b) - releaseTime(a) || b.tag_name.localeCompare(a.tag_name)
  ));
}

export function selectLatestRelease(releases, pattern) {
  return publishedMatchingReleases(releases, pattern)[0];
}

export function normalizeDigest(value) {
  if (typeof value !== 'string') throw new Error('asset is missing a digest');
  const digest = value.replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid sha256 digest: ${value}`);
  return digest;
}

function versionParts(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'number') return [value];
  if (typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value)) {
    return value.split('.').map(Number);
  }
  throw new Error(`invalid asset version: ${value}`);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function projectAsset(asset) {
  if (!asset || typeof asset.name !== 'string') throw new Error('asset is malformed');
  const url = asset.browser_download_url ?? asset.url;
  if (typeof url !== 'string' || url.length === 0) throw new Error(`asset ${asset.name} has no URL`);
  if (!Number.isInteger(asset.size) || asset.size < 0) throw new Error(`asset ${asset.name} has no valid size`);
  return {
    name: asset.name,
    url,
    digest: normalizeDigest(asset.digest),
    size: asset.size,
  };
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireHex(value, length, label) {
  const text = requireText(value, label).toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function validateAsset(source, label) {
  const asset = requireObject(source, label);
  requireText(asset.name, `${label}.name`);
  requireText(asset.url, `${label}.url`);
  requireHex(asset.digest, 64, `${label}.digest`);
  if (!Number.isInteger(asset.size) || asset.size < 0) throw new Error(`${label}.size is invalid`);
}

export function selectLatestAsset(assets, pattern, versionExtractor) {
  if (!Array.isArray(assets)) throw new TypeError('assets must be an array');
  const candidates = assets.filter((asset) => asset && typeof asset.name === 'string' && matches(pattern, asset.name));
  if (candidates.length === 0) throw new Error('no matching asset');
  if (!versionExtractor) {
    if (candidates.length !== 1) throw new Error(`multiple assets match (${candidates.length} assets)`);
    return projectAsset(candidates[0]);
  }
  const versioned = candidates.map((asset) => ({ asset, version: versionExtractor(asset.name, asset) }));
  const selected = versioned.reduce((best, current) => (
    best === null || compareVersions(current.version, best.version) > 0 ? current : best
  ), null);
  const duplicates = versioned.filter(({ version }) => compareVersions(version, selected.version) === 0);
  if (duplicates.length !== 1) throw new Error(`multiple assets match highest version (${duplicates.length} assets)`);
  return projectAsset(selected.asset);
}

export function selectLatestReleaseAsset(releases, releasePattern, assetPattern, versionExtractor) {
  const candidates = [];
  for (const release of publishedMatchingReleases(releases, releasePattern)) {
    if (!Array.isArray(release.assets)) throw new Error(`release ${release.tag_name} has no assets`);
    for (const asset of release.assets) {
      if (asset && typeof asset.name === 'string' && matches(assetPattern, asset.name)) {
        candidates.push({ asset, release, version: versionExtractor(asset.name, asset) });
      }
    }
  }
  if (candidates.length === 0) throw new Error('no matching asset across releases');
  const selected = candidates.reduce((best, current) => (
    best === null || compareVersions(current.version, best.version) > 0 ? current : best
  ), null);
  const duplicates = candidates.filter(({ version }) => compareVersions(version, selected.version) === 0);
  if (duplicates.length !== 1) throw new Error(`multiple assets match highest version (${duplicates.length} assets)`);
  return { asset: projectAsset(selected.asset), release: selected.release };
}

export function buildManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('manifest input must be an object');
  const { fingerprint: ignored, ...rest } = input;
  const payload = { schemaVersion: rest.schemaVersion ?? 1, ...rest };
  return { ...payload, fingerprint: hashCanonical(payload) };
}

export function validateManifest(value) {
  const manifest = requireObject(value, 'manifest');
  if (![1, 2, 3, 4, 5].includes(manifest.schemaVersion)) throw new Error('manifest schemaVersion is unsupported');
  const claimed = requireHex(manifest.fingerprint, 64, 'manifest fingerprint');
  const { fingerprint: ignored, ...payload } = manifest;
  if (hashCanonical(payload) !== claimed) throw new Error('manifest fingerprint does not match canonical payload');

  const board = requireObject(manifest.board, 'manifest.board');
  for (const key of ['model', 'profile', 'architecture', 'distribution', 'dtb', 'ubootOverload']) {
    requireText(board[key], `manifest.board.${key}`);
  }
  if (!Number.isInteger(board.bootloaderGapMiB)) throw new Error('manifest.board.bootloaderGapMiB is invalid');
  if (manifest.schemaVersion >= 2 && manifest.schemaVersion <= 3) {
    requireText(board.mainlineBootloader, 'manifest.board.mainlineBootloader');
    requireText(board.distributionVersion, 'manifest.board.distributionVersion');
    requireHex(board.ubootOverloadSha256, 64, 'manifest.board.ubootOverloadSha256');
    if (!Number.isInteger(board.ubootOverloadSize) || board.ubootOverloadSize <= 0) {
      throw new Error('manifest.board.ubootOverloadSize is invalid');
    }
    const provenance = requireObject(board.ubootOverloadProvenance, 'manifest.board.ubootOverloadProvenance');
    for (const key of ['originRepository', 'originRelease', 'originAsset', 'originUploader', 'originUrl', 'sourceCommit']) {
      requireText(provenance[key], `manifest.board.ubootOverloadProvenance.${key}`);
    }
    requireHex(provenance.sourceCommit, 40, 'manifest.board.ubootOverloadProvenance.sourceCommit');
    requireHex(provenance.ophubGitBlob, 40, 'manifest.board.ubootOverloadProvenance.ophubGitBlob');
    if (provenance.unpublishedDirtyDelta !== true || provenance.reproducibleFromSource !== false) {
      throw new Error('manifest.board.ubootOverloadProvenance.reproducibleFromSource must be false');
    }
  }
  if (manifest.schemaVersion >= 4) {
    requireText(board.distributionVersion, 'manifest.board.distributionVersion');
    imageSizeLimit(board);
    const build = requireObject(board.ubootOverloadBuild, 'manifest.board.ubootOverloadBuild');
    for (const key of ['patch', 'defconfig', 'output', 'crossCompile', 'instructionsUrl', 'patchSourceUrl']) {
      requireText(build[key], `manifest.board.ubootOverloadBuild.${key}`);
    }
    requireHex(build.patchSha256, 64, 'manifest.board.ubootOverloadBuild.patchSha256');
    if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.patch$/.test(build.patch)) {
      throw new Error('manifest.board.ubootOverloadBuild.patch is invalid');
    }
    if (!Number.isSafeInteger(build.sourceDateEpoch) || build.sourceDateEpoch < 0) {
      throw new Error('manifest.board.ubootOverloadBuild.sourceDateEpoch is invalid');
    }
    if (build.reproducibleFromSource !== true) {
      throw new Error('manifest.board.ubootOverloadBuild.reproducibleFromSource must be true');
    }
  }
  if (manifest.schemaVersion === 5) {
    const build = requireObject(board.dtbBuild, 'manifest.board.dtbBuild');
    for (const key of ['repository', 'sourcePath', 'commit', 'rawSourceUrl', 'license', 'output']) {
      requireText(build[key], `manifest.board.dtbBuild.${key}`);
    }
    requireHex(build.commit, 40, 'manifest.board.dtbBuild.commit');
    requireHex(build.sourceSha256, 64, 'manifest.board.dtbBuild.sourceSha256');
    const requiredDtbBuild = {
      repository: 'S-9527/meson-gxl-s905x-p212',
      sourcePath: 'repair/meson-gxl-s905x-p212.dts',
      commit: '624b3e57e27fd39476b3d6528e8a61867559d8c8',
      rawSourceUrl: 'https://raw.githubusercontent.com/S-9527/meson-gxl-s905x-p212/624b3e57e27fd39476b3d6528e8a61867559d8c8/repair/meson-gxl-s905x-p212.dts',
      sourceSha256: 'b52b6c6deea1d6b626d052042708f54eca65c9b7ffda56dfe8ca5fa0907cee7d',
      license: 'MIT',
      output: 'meson-gxl-s905x-p212-b860av11t.dtb',
    };
    if (Object.entries(requiredDtbBuild).some(([key, expected]) => build[key] !== expected)) {
      throw new Error('manifest.board.dtbBuild DTB source metadata does not match the project recipe');
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(build.repository)
      || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]+\.dts$/.test(build.sourcePath)) {
      throw new Error('manifest.board.dtbBuild source location is invalid');
    }
    const expectedUrl = `https://raw.githubusercontent.com/${build.repository}/${build.commit}/${build.sourcePath}`;
    if (build.rawSourceUrl !== expectedUrl) {
      throw new Error('manifest.board.dtbBuild.rawSourceUrl is not pinned to its metadata');
    }
    if (build.output !== board.dtb
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.dtb$/.test(build.output)) {
      throw new Error('manifest.board.dtbBuild output metadata is invalid');
    }
    if (!Number.isSafeInteger(build.sourceDateEpoch) || build.sourceDateEpoch < 0) {
      throw new Error('manifest.board.dtbBuild.sourceDateEpoch is invalid');
    }
    if (build.reproducibleFromSource !== true) {
      throw new Error('manifest.board.dtbBuild.reproducibleFromSource must be true');
    }
  }

  const sources = requireObject(manifest.sources, 'manifest.sources');
  validateAsset(sources.base, 'manifest.sources.base');
  validateAsset(sources.kernel, 'manifest.sources.kernel');
  requireText(sources.base.armbianVersion, 'manifest.sources.base.armbianVersion');
  requireText(sources.kernel.version, 'manifest.sources.kernel.version');
  const legacySourceKeys = manifest.schemaVersion <= 3
    ? ['builder', 'uboot', 'firmware']
    : ['builder'];
  for (const key of legacySourceKeys) {
    const source = requireObject(sources[key], `manifest.sources.${key}`);
    requireText(source.repository, `manifest.sources.${key}.repository`);
    requireHex(source.commit, 40, `manifest.sources.${key}.commit`);
  }
  if (manifest.schemaVersion >= 4) {
    if ('uboot' in sources || 'firmware' in sources) {
      throw new Error('source-built manifest must not include binary bundle repositories');
    }
    const source = requireObject(sources.ubootSource, 'manifest.sources.ubootSource');
    requireText(source.repository, 'manifest.sources.ubootSource.repository');
    requireText(source.ref, 'manifest.sources.ubootSource.ref');
    requireHex(source.commit, 40, 'manifest.sources.ubootSource.commit');
  }
  if (manifest.schemaVersion >= 3) {
    const debian = validateDebianStable(sources.debian);
    if (board.distribution !== debian.codename || board.distributionVersion !== debian.majorVersion) {
      throw new Error('manifest board distribution does not match Debian stable metadata');
    }
  }

  const recipe = requireObject(manifest.recipe, 'manifest.recipe');
  const files = Object.entries(requireObject(recipe.files, 'manifest.recipe.files'));
  if (recipe.schemaVersion !== 1 || files.length === 0) throw new Error('manifest recipe is invalid');
  for (const [path, digest] of files) requireHex(digest, 64, `manifest.recipe.files.${path}`);
  return manifest;
}
