import { createHash } from 'node:crypto';

const officialStableUrl = 'https://deb.debian.org/debian/dists/stable/InRelease';
const fields = [
  'Architectures',
  'Codename',
  'Components',
  'Date',
  'Label',
  'Origin',
  'Suite',
  'Version',
];
const recordKeys = ['codename', 'date', 'digest', 'majorVersion', 'sourceUrl', 'suite', 'version'];
const rfc2822Date = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} UTC$/;
const fullFingerprint = /^[0-9a-f]{40}$/i;

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Debian stable metadata must be an object');
  }
  return value;
}

function requireHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('source URL is required');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('source URL must be a valid HTTPS URL');
  }
  if (value !== officialStableUrl) {
    throw new Error('source URL must be the official HTTPS Debian stable URL');
  }
  return value;
}

function requireHeaderToken(headers, field, token) {
  const value = headers.get(field);
  if (typeof value !== 'string' || !value.split(/[ \t]+/).includes(token)) {
    throw new Error(`InRelease ${field} must include ${token}`);
  }
}

function releaseContent(value) {
  let bytes;
  if (typeof value === 'string') bytes = Buffer.from(value, 'utf8');
  else if (value instanceof Uint8Array) bytes = Buffer.from(value);
  else throw new TypeError('InRelease content must be a string or byte array');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('InRelease content must be valid UTF-8');
  }
  return { bytes, text };
}

function requireVersion(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)*$/.test(value)) {
    throw new Error('Debian version must be numeric');
  }
  return value;
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !rfc2822Date.test(value)) {
    throw new Error('Debian release date is invalid');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toUTCString() !== value.replace(/UTC$/, 'GMT')) {
    throw new Error('Debian release date is invalid');
  }
  return date.toISOString();
}

function requireNormalizedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error('Debian release date is invalid');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error('Debian release date is invalid');
  }
  return value;
}

function releaseHeaders(text) {
  if (typeof text !== 'string') throw new TypeError('InRelease text must be a string');
  const envelope = text.match(/^-----BEGIN PGP SIGNED MESSAGE-----\r?\n(?:Hash: [A-Za-z0-9-]+\r?\n)+\r?\n/);
  if (!envelope) throw new Error('InRelease clear-signed envelope is invalid');
  const signature = /\r?\n-----BEGIN PGP SIGNATURE-----\r?\n/.exec(text.slice(envelope[0].length));
  if (!signature || !text.includes('-----END PGP SIGNATURE-----', envelope[0].length)) {
    throw new Error('InRelease signature block is missing');
  }
  const body = text.slice(envelope[0].length, envelope[0].length + signature.index);
  const result = new Map();
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z-]*):[ \t]*(.*?)$/);
    if (!match || !fields.includes(match[1])) continue;
    if (result.has(match[1])) throw new Error(`InRelease has duplicate ${match[1]} headers`);
    result.set(match[1], match[2]);
  }
  return result;
}

export function validateDebianStable(value) {
  const stable = requireObject(value);
  const keys = Object.keys(stable).sort();
  if (keys.length !== recordKeys.length || keys.some((key, index) => key !== recordKeys[index])) {
    throw new Error('Debian stable metadata has an invalid shape');
  }
  if (stable.suite !== 'stable') throw new Error('Debian suite must be stable');
  const version = requireVersion(stable.version);
  if (stable.majorVersion !== version.split('.')[0]) throw new Error('Debian major version is invalid');
  if (typeof stable.codename !== 'string' || !/^[a-z]+$/.test(stable.codename)) {
    throw new Error('Debian codename must be lowercase');
  }
  requireNormalizedDate(stable.date);
  requireHttpsUrl(stable.sourceUrl);
  if (typeof stable.digest !== 'string' || !/^[0-9a-f]{64}$/.test(stable.digest)) {
    throw new Error('Debian release digest is invalid');
  }
  return stable;
}

export function requireGpgvValidSignature(status) {
  if (typeof status !== 'string') throw new TypeError('gpgv status must be a string');
  const signatures = [];
  for (const line of status.split(/\r?\n/)) {
    const parts = line.trim().split(/[ \t]+/);
    if (parts[0] !== '[GNUPG:]' || parts[1] !== 'VALIDSIG' || parts.length !== 12) continue;
    const signingFingerprint = parts[2];
    const primaryFingerprint = parts[11];
    if (!fullFingerprint.test(signingFingerprint) || !fullFingerprint.test(primaryFingerprint)) continue;
    signatures.push({ primaryFingerprint, signingFingerprint });
  }
  if (signatures.length === 0) {
    throw new Error('gpgv status contains no trusted valid signature with full fingerprints');
  }
  return signatures;
}

export function parseDebianInRelease(content, sourceUrl) {
  const { bytes, text } = releaseContent(content);
  const headers = releaseHeaders(text);
  if (headers.get('Origin') !== 'Debian') throw new Error('InRelease Origin must be Debian');
  if (headers.get('Label') !== 'Debian') throw new Error('InRelease Label must be Debian');
  if (headers.get('Suite') !== 'stable') throw new Error('InRelease Suite must be stable');
  requireHeaderToken(headers, 'Architectures', 'arm64');
  requireHeaderToken(headers, 'Components', 'main');
  const version = requireVersion(headers.get('Version'));
  const stable = {
    codename: headers.get('Codename'),
    date: normalizeDate(headers.get('Date')),
    digest: createHash('sha256').update(bytes).digest('hex'),
    majorVersion: version.split('.')[0],
    sourceUrl,
    suite: headers.get('Suite'),
    version,
  };
  return validateDebianStable(stable);
}
