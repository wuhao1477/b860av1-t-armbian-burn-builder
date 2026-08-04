export const IMAGE_IDENTITY_PATH = 'usr/lib/b860av1-t/image-identity.json';
export const IMAGE_IDENTITY_RECIPE_MARKER = 'scripts/write-image-identity.mjs';

const EXPECTED_KEYS = [
  'boardProfile',
  'identityPath',
  'kernelRelease',
  'kernelVersion',
  'manifestFingerprint',
  'schemaVersion',
];
const SHA256 = /^[0-9a-f]{64}$/;
const KERNEL_VERSION = /^\d+\.\d+\.\d+$/;
const KERNEL_RELEASE = /^\d+\.\d+\.\d+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExpectedKeys(value) {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_KEYS)) {
    throw new Error('image identity has unexpected keys');
  }
}

function requireExpectedValue(value, expected, key, label) {
  if (Object.hasOwn(expected, key) && value[key] !== expected[key]) {
    throw new Error(`image identity ${label} does not match expected value`);
  }
}

export function validateImageIdentity(value, expected = {}) {
  const identity = requireObject(value, 'image identity');
  const target = requireObject(expected, 'expected image identity');
  requireExpectedKeys(identity);
  if (identity.schemaVersion !== 1) throw new Error('image identity schema is invalid');
  if (identity.boardProfile !== 'b860av1-t') throw new Error('image identity board profile is invalid');
  if (identity.identityPath !== `/${IMAGE_IDENTITY_PATH}`) throw new Error('image identity path is invalid');
  if (!SHA256.test(identity.manifestFingerprint ?? '')) throw new Error('image identity manifest fingerprint is invalid');
  if (!KERNEL_VERSION.test(identity.kernelVersion ?? '')) throw new Error('image identity kernel version is invalid');
  if (!KERNEL_RELEASE.test(identity.kernelRelease ?? '')
    || !identity.kernelRelease.startsWith(`${identity.kernelVersion}-`)) {
    throw new Error('image identity kernel release is invalid');
  }
  for (const [key, label] of [
    ['manifestFingerprint', 'manifest fingerprint'],
    ['boardProfile', 'board profile'],
    ['kernelVersion', 'kernel version'],
    ['kernelRelease', 'kernel release'],
  ]) requireExpectedValue(identity, target, key, label);
  return identity;
}

export function buildImageIdentity(input) {
  const value = requireObject(input, 'image identity input');
  return validateImageIdentity({
    schemaVersion: 1,
    boardProfile: value.boardProfile,
    manifestFingerprint: value.manifestFingerprint,
    kernelVersion: value.kernelVersion,
    kernelRelease: value.kernelRelease,
    identityPath: `/${IMAGE_IDENTITY_PATH}`,
  });
}

export function requiresImageIdentity(manifest) {
  return Object.hasOwn(manifest?.recipe?.files ?? {}, IMAGE_IDENTITY_RECIPE_MARKER);
}
