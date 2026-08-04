#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseSerialLog, safeEvidenceRelativePath, validateDeviceEvidence } from '../src/device-evidence.mjs';
import { validatePublicRelease } from '../src/public-release-policy.mjs';

const REQUIRED_ASSETS = [
  'SHA256SUMS', 'build-input-heads.json', 'release-tag.txt', 'resolved-sources.json',
  'validation-report.json', 'filesystem-manifest.sha256', 'boot-components.json',
];
const IDENTITY_PATH = '/usr/lib/b860av1-t/image-identity.json';
const REPOSITORY = 'wuhao1477/b860av1-t-armbian-builder';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assetDigest(release, name) {
  const matches = (release.assets ?? []).filter((asset) => asset?.name === name);
  if (matches.length !== 1) throw new Error(`Release asset ${name} is missing or duplicated`);
  const digest = String(matches[0].digest ?? '').replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Release asset ${name} digest is invalid`);
  return digest;
}

function verifyLocalAsset(root, release, name) {
  const file = join(root, name);
  const content = readFileSync(file);
  if (sha256(content) !== assetDigest(release, name)) throw new Error(`local Release asset ${name} digest does not match GitHub`);
  return content;
}

function verifyEvidenceDirectory(directory) {
  const entries = readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify(['device-serial.log', 'device-validation.json'])) {
    throw new Error('evidence directory must contain exactly one JSON and one serial-log pair');
  }
  return {
    value: readJson(join(directory, 'device-validation.json')),
    serialLog: readFileSync(join(directory, 'device-serial.log'), 'utf8'),
  };
}

function verifyImageBinding(evidence, report, release, checksums) {
  const imageName = basename(report.image ?? '');
  if (imageName !== evidence.release.image || report.imageSha256 !== evidence.release.imageSha256
    || report.rawSha256 !== evidence.release.rawSha256) {
    throw new Error('evidence image binding does not match validation report');
  }
  if (assetDigest(release, imageName) !== evidence.release.imageSha256) {
    throw new Error('evidence image digest does not match Release asset metadata');
  }
  const lines = checksums.trimEnd().split(/\r?\n/).filter(Boolean);
  const matches = lines.filter((line) => line === `${evidence.release.imageSha256}  ${imageName}`);
  if (lines.length !== 1 || matches.length !== 1) throw new Error('SHA256SUMS is not bound to the evidence image');
}

function verifyIdentity(evidence, manifest, filesystemManifest) {
  if (evidence.release.manifestFingerprint !== manifest.fingerprint
    || evidence.identity.manifestFingerprint !== manifest.fingerprint
    || evidence.identity.kernelVersion !== manifest.sources?.kernel?.version) {
    throw new Error('image identity does not match the published manifest');
  }
  const expectedLine = `${evidence.identity.sha256}  .${IDENTITY_PATH}`;
  const matches = filesystemManifest.split(/\r?\n/).filter((line) => line === expectedLine);
  if (matches.length !== 1) throw new Error('image identity digest is not unique in filesystem manifest');
}

function verifyBootComponents(evidence, published) {
  if (published?.schemaVersion !== 2 || !Array.isArray(published.components)) throw new Error('published boot components are malformed');
  for (const component of evidence.boot.components) {
    if (!safeEvidenceRelativePath(component.path)) throw new Error('evidence boot component path is unsafe');
    const matches = published.components.filter((candidate) => candidate.role === component.role
      && candidate.path === component.path && candidate.sha256 === component.sha256);
    if (matches.length !== 1) throw new Error(`boot component ${component.role} is not bound to the Release`);
  }
}

function verifyCollector(repoRoot, collector) {
  if (collector.repository !== REPOSITORY) throw new Error('collector repository is invalid');
  try {
    execFileSync('git', ['-C', repoRoot, 'cat-file', '-e', `${collector.commit}^{commit}`]);
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', collector.commit, 'HEAD']);
  } catch (error) {
    throw new Error('collector commit is not an ancestor of the trusted checkout', { cause: error });
  }
  let source;
  try {
    source = execFileSync('git', ['-C', repoRoot, 'show', `${collector.commit}:${collector.scriptPath}`]);
  } catch (error) {
    throw new Error('collector script blob cannot be read from the recorded commit', { cause: error });
  }
  if (sha256(source) !== collector.scriptSha256) throw new Error('collector script digest does not match the recorded Git blob');
}

function buildSummary(evidence, report) {
  return {
    schemaVersion: 1,
    status: 'operator-attested / one-device',
    tag: evidence.release.tag,
    image: evidence.release.image,
    imageSha256: evidence.release.imageSha256,
    manifestFingerprint: evidence.release.manifestFingerprint,
    kernelRelease: evidence.identity.kernelRelease,
    evidenceId: evidence.evidenceId,
    collectedAt: evidence.collectedAt,
    staticReportStatus: report.status,
    trustLimitation: 'Operator-supplied evidence for one physical device; not cryptographic remote hardware attestation.',
  };
}

export async function validateDeviceEvidenceAgainstRelease(
  evidenceDirectory,
  releaseAssetsDirectory,
  repoRoot,
  summaryOutput,
) {
  const evidenceRoot = resolve(evidenceDirectory);
  const assetsRoot = resolve(releaseAssetsDirectory);
  const checkoutRoot = resolve(repoRoot);
  const local = verifyEvidenceDirectory(evidenceRoot);
  const release = readJson(join(assetsRoot, 'release.json'));
  const manifest = readJson(join(assetsRoot, 'resolved-sources.json'));
  const report = readJson(join(assetsRoot, 'validation-report.json'));
  const tag = validatePublicRelease({ manifest, report, release, tag: release.tagName });
  if (local.value.release.repository !== REPOSITORY || local.value.release.tag !== tag) throw new Error('evidence Release tag is not authoritative');
  validateDeviceEvidence(local.value, { serialLog: local.serialLog });
  for (const asset of REQUIRED_ASSETS) verifyLocalAsset(assetsRoot, release, asset);
  verifyImageBinding(local.value, report, release, readFileSync(join(assetsRoot, 'SHA256SUMS'), 'utf8'));
  verifyIdentity(local.value, manifest, readFileSync(join(assetsRoot, 'filesystem-manifest.sha256'), 'utf8'));
  verifyBootComponents(local.value, readJson(join(assetsRoot, 'boot-components.json')));
  verifyCollector(checkoutRoot, local.value.collector);
  parseSerialLog(local.serialLog, {
    evidenceId: local.value.evidenceId,
    manifestFingerprint: local.value.release.manifestFingerprint,
    kernelRelease: local.value.identity.kernelRelease,
  });
  const summary = buildSummary(local.value, report);
  const result = { evidence: local.value, manifest, report, release, summary };
  if (summaryOutput) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(summaryOutput), `${JSON.stringify(summary, null, 2)}\n`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [evidenceDirectory, releaseAssetsDirectory, repoRoot, summaryOutput] = process.argv.slice(2);
  if (!evidenceDirectory || !releaseAssetsDirectory || !repoRoot || !summaryOutput) {
    process.stderr.write('usage: validate-device-evidence.mjs evidence-dir release-assets-dir repo-root summary.json\n');
    process.exitCode = 2;
  } else {
    validateDeviceEvidenceAgainstRelease(evidenceDirectory, releaseAssetsDirectory, repoRoot, summaryOutput)
      .then((result) => process.stdout.write(`${JSON.stringify(result.summary)}\n`))
      .catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}

