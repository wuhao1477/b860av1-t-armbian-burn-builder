#!/usr/bin/env node

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import board from '../config/board.json' with { type: 'json' };
import sourceConfig from '../config/sources.json' with { type: 'json' };
import { canonicalStringify, sha256 } from '../src/canonical-json.mjs';
import { compareFingerprints } from '../src/change-detection.mjs';
import { validateDebianStable } from '../src/debian-release.mjs';
import {
  buildManifest,
  publishedMatchingReleases,
  selectLatestAsset,
  selectLatestReleaseAsset,
  validateManifest,
} from '../src/upstream.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiAttempts = 5;
const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const recipeFiles = [
  'THIRD_PARTY_SOURCES.md',
  '.github/workflows/device-evidence-pr.yml',
  '.github/workflows/verify-device.yml',
  '.github/workflows/weekly-build.yml',
  'config/aml-autoscript.cmd',
  'config/b860av1-t-model.conf',
  'config/board.json',
  'config/hardware-capabilities.json',
  'config/s905-autoscript.cmd',
  'config/sources.json',
  'docs/device-validation.md',
  'evidence/.gitkeep',
  'package.json',
  'patches/u-boot/README.md',
  'patches/u-boot/u-boot-s905x-s912.patch',
  'scripts/audit-public-releases.sh',
  'scripts/build-raw-image.sh',
  'scripts/build-board-dtb.sh',
  'scripts/build-uboot-overload.sh',
  'scripts/collect-device-evidence.sh',
  'scripts/disable-binary-dependency-downloads.mjs',
  'scripts/extract-uboot-script-payload.mjs',
  'scripts/generate-release-metadata.mjs',
  'scripts/hash-source-tree.mjs',
  'scripts/install-board-profile.mjs',
  'scripts/patch-boot-config.mjs',
  'scripts/qemu-system-smoke.sh',
  'scripts/render-device-evidence.mjs',
  'scripts/render-device-validation-summary.mjs',
  'scripts/scan-mounted-image.mjs',
  'scripts/render-release-notes.mjs',
  'scripts/resolve-debian-stable.mjs',
  'scripts/resolve-sources.mjs',
  'scripts/sanitize-raw-image.mjs',
  'scripts/validate-candidate-artifacts.mjs',
  'scripts/validate-boot-script.mjs',
  'scripts/validate-dtb-compatible.mjs',
  'scripts/validate-device-evidence.mjs',
  'scripts/validate-hardware-capabilities.mjs',
  'scripts/validate-raw-image.sh',
  'scripts/validate-rtl8189fs.mjs',
  'scripts/validate-uboot-build.mjs',
  'scripts/verify-debian-stable.sh',
  'scripts/write-build-input-heads.mjs',
  'scripts/write-image-identity.mjs',
  'src/canonical-json.mjs',
  'src/board-limits.mjs',
  'src/build-inputs.mjs',
  'src/boot-config.mjs',
  'src/change-detection.mjs',
  'src/debian-release.mjs',
  'src/device-evidence.mjs',
  'src/hardware-capabilities.mjs',
  'src/image-identity.mjs',
  'src/public-release-policy.mjs',
  'src/release-metadata.mjs',
  'src/repository-policy.mjs',
  'src/release.mjs',
  'src/rtl8189fs.mjs',
  'src/source-tree.mjs',
  'src/uboot-script-payload.mjs',
  'src/uboot-build.mjs',
  'src/upstream.mjs',
];

function args(argv) {
  const result = { debianStable: null, force: false, output: 'resolved-sources.json', previous: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') result.output = argv[++index];
    else if (argv[index] === '--previous') result.previous = argv[++index];
    else if (argv[index] === '--debian-stable') result.debianStable = argv[++index];
    else if (argv[index] === '--force') result.force = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return result;
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 10_000);
  return Math.min(1_000 * (2 ** (attempt - 1)), 8_000);
}

export async function fetchJson(url) {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 1; attempt <= apiAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      if (attempt === apiAttempts) {
        throw new Error(`GitHub API request failed for ${url}: ${error.message}`, { cause: error });
      }
      await wait(retryDelay(null, attempt));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      if (retryableStatuses.has(response.status) && attempt < apiAttempts) {
        await wait(retryDelay(response, attempt));
        continue;
      }
      throw new Error(`GitHub API ${response.status} for ${url}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`GitHub API returned malformed JSON for ${url}: ${error.message}`);
    }
  }
  throw new Error(`GitHub API retries exhausted for ${url}`);
}

async function fetchPages(url, label) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = url.includes('?') ? '&' : '?';
    const pageItems = await fetchJson(`${url}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(pageItems)) throw new Error(`${label} page ${page} is malformed`);
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
}

async function fetchReleaseAssets(release) {
  if (typeof release.assets_url !== 'string' || release.assets_url.length === 0) {
    if (!Array.isArray(release.assets)) throw new Error(`release ${release.tag_name} has no assets`);
    return release.assets;
  }
  return fetchPages(release.assets_url, `release ${release.tag_name} assets`);
}

async function resolveCommit(source) {
  const commit = await fetchJson(apiUrl(`/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`));
  if (typeof commit.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
    throw new Error(`${source.repository} ${source.ref} response has no valid SHA`);
  }
  return {
    commit: commit.sha.toLowerCase(),
    ref: source.ref,
    repository: source.repository,
    url: commit.html_url ?? `https://github.com/${source.repository}/commit/${commit.sha}`,
  };
}

function apiUrl(path) {
  const base = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  return `${base}${path}`;
}

function baseAssetVersion(name) {
  const match = name.match(/^Armbian_(\d+\.\d+\.\d+)-trunk_.*_(\d+\.\d+\.\d+)\.img\.gz$/);
  if (!match) throw new Error(`cannot parse base asset version from ${name}`);
  return [...match[1].split('.'), ...match[2].split('.')].map(Number);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basePatterns(codename) {
  const escaped = escapeRegex(codename);
  return {
    asset: new RegExp(`^Armbian_\\d+\\.\\d+\\.\\d+-trunk_${escaped}_arm64_\\d+\\.\\d+\\.\\d+\\.img\\.gz$`),
    release: new RegExp(`^Armbian_${escaped}_arm64_server_`),
  };
}

async function readDebianStable(path) {
  if (!path) throw new Error('--debian-stable is required');
  try {
    return validateDebianStable(JSON.parse(await readFile(resolve(path), 'utf8')));
  } catch (error) {
    throw new Error(`cannot read Debian stable metadata ${path}: ${error.message}`);
  }
}

async function resolveRecipe() {
  const entries = await Promise.all(recipeFiles.map(async (path) => (
    [path, sha256(await readFile(resolve(projectRoot, path)))]
  )));
  return { schemaVersion: 1, files: Object.fromEntries(entries) };
}

async function readPrevious(path) {
  if (!path) return null;
  try {
    return validateManifest(JSON.parse(await readFile(resolve(path), 'utf8')));
  } catch (error) {
    throw new Error(`cannot read previous manifest ${path}: ${error.message}`);
  }
}

async function resolveManifest(debian) {
  const patterns = basePatterns(debian.codename);
  const baseReleases = await fetchPages(
    apiUrl(`/repos/${sourceConfig.base.repository}/releases`),
    `${sourceConfig.base.repository} releases`,
  );
  const matchingReleases = publishedMatchingReleases(baseReleases, patterns.release);
  const releasesWithAssets = await Promise.all(matchingReleases.map(async (release) => ({
    ...release,
    assets: await fetchReleaseAssets(release),
  })));
  const selectedBase = selectLatestReleaseAsset(
    releasesWithAssets,
    patterns.release,
    patterns.asset,
    baseAssetVersion,
  );
  const { asset: base, release: baseRelease } = selectedBase;
  const armbianVersion = base.name.match(/^Armbian_(\d+\.\d+\.\d+)-trunk_/)?.[1];
  if (!armbianVersion) throw new Error(`cannot parse Armbian version from ${base.name}`);

  const kernelRelease = await fetchJson(apiUrl(`/repos/${sourceConfig.kernel.repository}/releases/tags/${encodeURIComponent(sourceConfig.kernel.releaseTag)}`));
  const kernel = selectLatestAsset(
    await fetchReleaseAssets(kernelRelease),
    sourceConfig.kernel.assetPattern,
    (name) => name.match(/^(5\.10\.[0-9]+)\.tar\.gz$/)?.[1],
  );
  const kernelVersion = kernel.name.match(/^(5\.10\.[0-9]+)\.tar\.gz$/)?.[1];
  if (!kernelVersion) throw new Error(`cannot parse kernel version from ${kernel.name}`);
  const builder = await resolveCommit(sourceConfig.builder);
  const ubootSource = await resolveCommit(sourceConfig.ubootSource);

  return buildManifest({
    schemaVersion: sourceConfig.schemaVersion,
    board: {
      ...board,
      distribution: debian.codename,
      distributionVersion: debian.majorVersion,
    },
    recipe: await resolveRecipe(),
    sources: {
      base: {
        ...base,
        armbianVersion,
        release: baseRelease.tag_name,
        repository: sourceConfig.base.repository,
      },
      kernel: {
        ...kernel,
        version: kernelVersion,
        release: sourceConfig.kernel.releaseTag,
        repository: sourceConfig.kernel.repository,
      },
      builder,
      ubootSource,
      debian,
    },
  });
}

async function writeGitHubOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  await appendFile(process.env.GITHUB_OUTPUT, body, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const options = args(argv);
  const manifest = await resolveManifest(await readDebianStable(options.debianStable));
  const previous = await readPrevious(options.previous || process.env.PREVIOUS_MANIFEST_PATH);
  const decision = compareFingerprints(manifest, previous, options.force || process.env.FORCE === 'true');
  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${canonicalStringify(manifest)}\n`, 'utf8');
  await writeGitHubOutput({
    changed: String(decision.changed),
    reason: decision.reason,
    fingerprint: manifest.fingerprint,
    manifest_path: outputPath,
  });
  process.stdout.write(`${canonicalStringify(manifest)}\n`);
  return { manifest, decision, outputPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
