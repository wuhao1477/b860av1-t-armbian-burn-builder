import {
  CURRENT_VALIDATION_SCHEMA,
  validatePublishedState,
  validateReleaseAssets,
} from './change-detection.mjs';
import { validateReleaseTag } from './release.mjs';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireBuildNumbers(tag) {
  const match = /^armbian-.+-build-(\d+)\.(\d+)$/.exec(tag);
  if (!match) throw new Error('public release tag format is invalid');
  const numbers = match.slice(1).map(Number);
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('public release tag build numbers are invalid');
  }
  return numbers;
}

function requireCleanChecks(report) {
  for (const [name, value] of Object.entries(report.checks ?? {})) {
    if (value !== true) throw new Error(`public release verification check failed: ${name}`);
  }
}

function requireSourceBuiltManifest(manifest) {
  if (manifest.schemaVersion !== 5) {
    throw new Error('public release requires manifest schema 5');
  }
  if (manifest.board?.profile !== 'b860av1-t') {
    throw new Error('public release is not the B860AV1-T profile');
  }
  if (manifest.board?.hardwareStatus !== 'hardware-unverified') {
    throw new Error('public release hardware status is invalid');
  }
  if (manifest.board?.ubootOverloadBuild?.reproducibleFromSource !== true
    || manifest.board?.dtbBuild?.reproducibleFromSource !== true) {
    throw new Error('public release is not source-built');
  }
}

export function validatePublicRelease(input) {
  const value = requireObject(input, 'public release input');
  const manifest = requireObject(value.manifest, 'public release manifest');
  const report = requireObject(value.report, 'public release report');
  const release = requireObject(value.release, 'public release metadata');
  const tag = value.tag ?? release.tagName;
  if (typeof tag !== 'string' || tag.length === 0 || release.tagName !== tag) {
    throw new Error('public release tag is missing or does not match metadata');
  }
  requireSourceBuiltManifest(manifest);
  if (report.schemaVersion !== CURRENT_VALIDATION_SCHEMA) {
    throw new Error(`public release requires validation report schema ${CURRENT_VALIDATION_SCHEMA}`);
  }
  const [runNumber, runAttempt] = requireBuildNumbers(tag);

  const validated = validatePublishedState(manifest, report);
  requireCleanChecks(report);
  const image = validateReleaseAssets(report, release);
  if (!/^Armbian_[A-Za-z0-9._+-]*amlogic_b860av1-t_[A-Za-z0-9._+-]+\.img\.gz$/.test(image.name)) {
    throw new Error('public release image is not the B860 Armbian image');
  }
  validateReleaseTag(tag, validated, runNumber, runAttempt);
  return tag;
}
