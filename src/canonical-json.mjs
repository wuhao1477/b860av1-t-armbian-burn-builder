import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`undefined value at ${key}`);
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprint(value) {
  return sha256(canonicalStringify(value));
}
