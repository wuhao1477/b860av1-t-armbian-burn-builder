import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { canonicalStringify } from './canonical-json.mjs';
import { validatePublishedState } from './change-detection.mjs';
import { validateReleaseTag } from './release.mjs';

const REPOSITORY = 'wuhao1477/b860av1-t-armbian-builder';
const IDENTITY_PATH = './usr/lib/b860av1-t/image-identity.json';
const SHA256 = /^[0-9a-f]{64}$/;
const KERNEL_RELEASE = /^\d+\.\d+\.\d+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireBoundFile(bytes, expected, label) {
  if (!Buffer.isBuffer(bytes) || !SHA256.test(expected ?? '') || sha256(bytes) !== expected) {
    throw new Error(`${label} digest does not match validation report`);
  }
}

function requireMatchingText(value, bytes, label) {
  if (typeof value !== 'string' || !bytes.equals(Buffer.from(value, 'utf8'))) {
    throw new Error(`${label} content does not match verified bytes`);
  }
}

function requireMatchingJson(value, bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (canonicalStringify(value) !== canonicalStringify(parsed)) {
    throw new Error(`${label} content does not match verified bytes`);
  }
}

function releaseTagFromText(source, manifest) {
  if (typeof source !== 'string' || !/^[^\r\n]+\n?$/.test(source)) {
    throw new Error('release tag file must contain exactly one tag');
  }
  const tag = source.replace(/\n$/, '');
  const match = /^armbian-.+-build-([1-9][0-9]*)\.([1-9][0-9]*)$/.exec(tag);
  if (!match) throw new Error('release tag format is invalid');
  return validateReleaseTag(tag, manifest, match[1], match[2]);
}

function imageNameFromReport(report) {
  const image = typeof report.image === 'string' ? basename(report.image) : '';
  if (!/^Armbian_[A-Za-z0-9._+-]*amlogic_b860av1-t_[A-Za-z0-9._+-]+\.img\.gz$/.test(image)) {
    throw new Error('validation report image is not a B860 Armbian image');
  }
  return image;
}

function identityDigest(filesystemManifest) {
  if (typeof filesystemManifest !== 'string') throw new Error('filesystem manifest must be text');
  const matches = filesystemManifest.split(/\r?\n/).filter((line) => line.endsWith(`  ${IDENTITY_PATH}`));
  if (matches.length !== 1) throw new Error('image identity entry must be unique in filesystem manifest');
  const match = /^([0-9a-f]{64})  \.\/usr\/lib\/b860av1-t\/image-identity\.json$/.exec(matches[0]);
  if (!match) throw new Error('image identity entry is malformed');
  return match[1];
}

function kernelReleaseFromQemu(qemu, manifest, report) {
  if (!qemu || typeof qemu !== 'object' || Array.isArray(qemu)
    || qemu.schemaVersion !== 2 || qemu.status !== 'passed'
    || qemu.manifestFingerprint !== manifest.fingerprint
    || qemu.rawSha256 !== report.rawSha256
    || !KERNEL_RELEASE.test(qemu.kernelRelease ?? '')
    || !qemu.kernelRelease.startsWith(`${manifest.sources.kernel.version}-`)) {
    throw new Error('QEMU system evidence is malformed or not bound to the Release');
  }
  return qemu.kernelRelease;
}

export function buildReleaseMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('release metadata input must be an object');
  }
  const manifest = validatePublishedState(input.manifest, input.report);
  const report = input.report;
  if (manifest.board.profile !== 'b860av1-t' || report.checks.imageIdentity !== true) {
    throw new Error('Release is not an identity-bound B860 candidate');
  }
  requireBoundFile(
    input.filesystemManifestBytes,
    report.evidence.filesystemManifestSha256,
    'filesystem manifest',
  );
  requireMatchingText(input.filesystemManifest, input.filesystemManifestBytes, 'filesystem manifest');
  requireBoundFile(
    input.qemuSystemSmokeBytes,
    report.evidence.qemuSystemSmokeSha256,
    'QEMU system evidence',
  );
  requireMatchingJson(input.qemuSystemSmoke, input.qemuSystemSmokeBytes, 'QEMU system evidence');
  return {
    repository: REPOSITORY,
    tag: releaseTagFromText(input.releaseTag, manifest),
    image: imageNameFromReport(report),
    imageSha256: report.imageSha256,
    rawSha256: report.rawSha256,
    manifestFingerprint: manifest.fingerprint,
    kernelVersion: manifest.sources.kernel.version,
    kernelRelease: kernelReleaseFromQemu(input.qemuSystemSmoke, manifest, report),
    identitySha256: identityDigest(input.filesystemManifest),
  };
}
