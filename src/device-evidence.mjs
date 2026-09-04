import { createHash } from 'node:crypto';

export const DEVICE_EVIDENCE_SCHEMA = 1;
export const CAPABILITIES = ['emmc', 'ethernet', 'hdmi', 'infrared', 'usb', 'wifi'];
export const MAX_DEVICE_LOG_BYTES = 2 * 1024 * 1024;

const REPOSITORY = 'wuhao1477/b860av1-t-armbian-burn-builder';
const EVIDENCE_ID = /^[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KERNEL_VERSION = /^\d+\.\d+\.\d+$/;
const KERNEL_RELEASE = /^\d+\.\d+\.\d+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
const TOP_LEVEL_KEYS = [
  'board', 'boot', 'capabilities', 'collectedAt', 'collector', 'evidenceId',
  'identity', 'release', 'schemaVersion', 'serial', 'status',
];
const REQUIRED_CAPABILITY_FIELDS = {
  emmc: ['blockDevicePresent', 'rootSourceObserved', 'capacityBytes', 'readOnlyProbeBytes'],
  ethernet: ['carrier', 'connectivity'],
  hdmi: ['connectorConnected', 'edidSha256', 'linuxDisplayVisible'],
  infrared: ['inputDevicePresent', 'keyEventSeen', 'keyCode'],
  usb: ['hostPresent', 'hotplugSeen', 'vendorId', 'productId', 'readOnlyProbe'],
  wifi: ['driver', 'interfacePresent', 'associated', 'connectivity'],
};

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const target = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(target)) throw new Error(`${label} has unexpected keys`);
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function digest(value, label) {
  if (!SHA256.test(value ?? '')) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function kernelRelease(value, version, label) {
  if (!KERNEL_RELEASE.test(value ?? '') || !value.startsWith(`${version}-`)) {
    throw new Error(`${label} is invalid`);
  }
}

function validateTimestamp(value) {
  text(value, 'collectedAt');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) throw new Error('collectedAt must be a UTC RFC 3339 timestamp');
}

function hasSensitiveText(value) {
  return /(?:^|[\s=])(?:token|password|passwd|secret|api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/i.test(value)
    || /(?:^|[\s=])(?:ssid|network(?:name)?|cid|serial(?:number)?|usb[_-]?serial|uuid)\s*[:=]\s*[^\s,;]+/i.test(value)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value)
    || /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(value)
    || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(value)
    || /(?<![A-Za-z0-9])[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}(?![A-Za-z0-9])/i.test(value);
}

function assertNoSensitiveStrings(value, path = 'evidence') {
  if (typeof value === 'string') {
    if (hasSensitiveText(value)) throw new Error(`${path} contains sensitive text; redact it first`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveStrings(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => assertNoSensitiveStrings(entry, `${path}.${key}`));
  }
}

function normalizeLog(source) {
  if (typeof source !== 'string') throw new TypeError('serial log must be text');
  if (Buffer.byteLength(source, 'utf8') > MAX_DEVICE_LOG_BYTES) throw new Error('serial log exceeds 2 MiB size limit');
  for (const character of source) {
    const code = character.codePointAt(0);
    if ((code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0x7f) {
      throw new Error('serial log contains a control character');
    }
  }
  const normalized = source.replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_DEVICE_LOG_BYTES) throw new Error('serial log exceeds 2 MiB size limit');
  return normalized;
}

function replaceKeyValue(source, expression) {
  return source.replace(expression, (full, key) => `${key}[REDACTED]`);
}

export function redactSensitiveText(source) {
  let result = normalizeLog(source);
  result = result.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED]');
  result = result.replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, '[REDACTED]');
  result = result.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED]');
  result = result.replace(/(?<![A-Za-z0-9])[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}(?![A-Za-z0-9])/gi, '[REDACTED]');
  result = replaceKeyValue(result, /((?:ssid|network(?:name)?|cid|e?mmc[_-]?cid|serial(?:number)?|usb[_-]?serial)\s*[:=]\s*)[^\s,;]+/gi);
  result = replaceKeyValue(result, /((?:token|password|passwd|secret|api[_-]?key|authorization|bearer)\s*[:=]\s*)[^\s,;]+/gi);
  return result;
}

function challengePattern() {
  return /^B860_DEVICE_READY ([0-9a-f]{16}) ([0-9a-f]{64}) ([0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*)$/;
}

function postHandoffAndroid(line) {
  return /\b(?:boot_android|storeboot|start_emmc_autoscript)\b/i.test(line)
    || /(?:android(?:boot|_init| init)|(?:mount|fs_mgr).*\b(?:system|vendor|product|odm|recovery)\.img\b|\b(?:init|recovery)\.rc\b)/i.test(line);
}

export function parseSerialLog(source, context = {}) {
  const normalized = redactSensitiveText(source);
  const lines = normalized.split('\n');
  const challenges = lines.filter((line) => challengePattern().test(line));
  if (challenges.length !== 1) throw new Error('serial log must contain exactly one challenge');
  const challenge = challenges[0];
  const fields = challenge.match(challengePattern());
  if (fields[1] !== context.evidenceId || fields[2] !== context.manifestFingerprint
    || fields[3] !== context.kernelRelease) throw new Error('serial challenge does not match evidence context');
  const handoffs = lines.map((line, index) => ({ line, index })).filter(({ line }) => {
    return new RegExp(`^Linux version ${context.kernelRelease.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(line);
  });
  if (handoffs.length !== 1) throw new Error('serial log must contain exactly one Linux kernel handoff');
  const handoff = handoffs[0].index;
  const ready = lines.findIndex((line, index) => index > handoff
    && /(?:Welcome to Armbian\b|Armbian.*(?:ready|login)|systemd\[[0-9]+\].*Startup finished|\blogin:)/i.test(line));
  if (ready < 0) throw new Error('serial log is missing a Linux readiness marker');
  for (let index = handoff + 1; index < lines.length; index += 1) {
    if (postHandoffAndroid(lines[index])) throw new Error('post-handoff Android or stock fallback execution marker found');
  }
  return {
    normalized,
    markers: { challenge, kernelRelease: context.kernelRelease, readiness: lines[ready] },
    warnings: { preHandoffVendorText: lines.slice(0, handoff).some((line) => /android|u-boot|vendor|stock/i.test(line)) },
  };
}

export function safeEvidenceRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/')
    && !value.includes('\\') && !/[\s\x00-\x1f\x7f]/.test(value)
    && !value.split('/').includes('..') && /^[A-Za-z0-9._/-]+$/.test(value);
}

function validateBoard(value) {
  object(value, 'board');
  exactKeys(value, ['profile', 'declaredModel', 'observedModel', 'compatible'], 'board');
  if (value.profile !== 'b860av1-t' || value.declaredModel !== 'ZXV10 B860AV1.1-T') throw new Error('board identity is invalid');
  text(value.observedModel, 'board.observedModel');
  if (!Array.isArray(value.compatible) || value.compatible.length === 0 || value.compatible.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('board.compatible is invalid');
  }
}

function validateRelease(value) {
  object(value, 'release');
  exactKeys(value, ['repository', 'tag', 'image', 'imageSha256', 'rawSha256', 'manifestFingerprint'], 'release');
  if (value.repository !== REPOSITORY || !/^armbian-[A-Za-z0-9._+-]+-debian-[A-Za-z0-9._+-]+-k\d+\.\d+\.\d+-build-\d+\.\d+$/.test(value.tag)) throw new Error('release identity is invalid');
  if (!/^Armbian_[A-Za-z0-9._+-]+\.img\.gz$/.test(value.image)) throw new Error('release image name is invalid');
  digest(value.imageSha256, 'release.imageSha256'); digest(value.rawSha256, 'release.rawSha256'); digest(value.manifestFingerprint, 'release.manifestFingerprint');
}

function validateIdentity(value, release) {
  object(value, 'identity');
  exactKeys(value, ['path', 'sha256', 'manifestFingerprint', 'kernelVersion', 'kernelRelease'], 'identity');
  if (value.path !== '/usr/lib/b860av1-t/image-identity.json' || value.manifestFingerprint !== release.manifestFingerprint) throw new Error('identity binding is invalid');
  digest(value.sha256, 'identity.sha256');
  if (!KERNEL_VERSION.test(value.kernelVersion ?? '')) throw new Error('identity.kernelVersion is invalid');
  kernelRelease(value.kernelRelease, value.kernelVersion, 'identity.kernelRelease');
}

function validateCollector(value) {
  object(value, 'collector');
  exactKeys(value, ['repository', 'commit', 'scriptPath', 'scriptSha256'], 'collector');
  if (value.repository !== REPOSITORY || !/^[0-9a-f]{40}$/.test(value.commit)
    || value.scriptPath !== 'scripts/collect-device-evidence.sh') throw new Error('collector binding is invalid');
  digest(value.scriptSha256, 'collector.scriptSha256');
}

function validateBoot(value, identity) {
  object(value, 'boot');
  exactKeys(value, ['kernelRelease', 'components'], 'boot');
  if (value.kernelRelease !== identity.kernelRelease || !Array.isArray(value.components) || value.components.length === 0) throw new Error('boot binding is invalid');
  const roles = new Set(); const paths = new Set();
  for (const component of value.components) {
    object(component, 'boot component');
    exactKeys(component, ['role', 'path', 'sha256'], 'boot component');
    if (!['kernel', 'initrd', 'dtb', 'boot-config'].includes(component.role) || roles.has(component.role)
      || !safeEvidenceRelativePath(component.path) || paths.has(component.path)) throw new Error('boot component is invalid');
    digest(component.sha256, 'boot component sha256'); roles.add(component.role); paths.add(component.path);
  }
  for (const role of ['kernel', 'initrd', 'dtb', 'boot-config']) if (!roles.has(role)) throw new Error(`boot component ${role} is missing`);
}

function validateSerial(value) {
  object(value, 'serial');
  exactKeys(value, ['asset', 'sha256', 'bootFromPowerOn', 'linuxReady', 'androidMarkersAbsent'], 'serial');
  if (value.asset !== 'device-serial.log' || !['bootFromPowerOn', 'linuxReady', 'androidMarkersAbsent'].every((key) => value[key] === true)) throw new Error('serial status is invalid');
  digest(value.sha256, 'serial.sha256');
}

function validateCapability(name, value) {
  object(value, `capabilities.${name}`);
  if (value.passed !== true) throw new Error(`capabilities.${name}.passed must be true`);
  const observations = object(value.observations, `capabilities.${name}.observations`);
  for (const key of REQUIRED_CAPABILITY_FIELDS[name]) if (!Object.hasOwn(observations, key)) throw new Error(`capabilities.${name}.observations is incomplete`);
  const booleans = REQUIRED_CAPABILITY_FIELDS[name].filter((key) => !['capacityBytes', 'readOnlyProbeBytes', 'keyCode', 'edidSha256', 'vendorId', 'productId', 'driver'].includes(key));
  for (const key of booleans) if (typeof observations[key] !== 'boolean') throw new Error(`capabilities.${name}.${key} is invalid`);
  for (const key of ['capacityBytes', 'readOnlyProbeBytes', 'keyCode']) if (Object.hasOwn(observations, key) && (!Number.isSafeInteger(observations[key]) || observations[key] < 0)) throw new Error(`capabilities.${name}.${key} is invalid`);
  if (name === 'hdmi') digest(observations.edidSha256, `capabilities.${name}.edidSha256`);
  if (name === 'wifi' && observations.driver !== '8189fs') throw new Error('capabilities.wifi.driver is invalid');
  if (name === 'usb' && (!/^[0-9a-f]{4}$/i.test(observations.vendorId) || !/^[0-9a-f]{4}$/i.test(observations.productId))) throw new Error('capabilities.usb identifiers are invalid');
}

function validateCapabilities(value) {
  object(value, 'capabilities');
  exactKeys(value, CAPABILITIES, 'capabilities');
  CAPABILITIES.forEach((name) => validateCapability(name, value[name]));
}

export function validateDeviceEvidence(value, context = {}) {
  const evidence = object(value, 'device evidence');
  exactKeys(evidence, TOP_LEVEL_KEYS, 'device evidence');
  if (evidence.schemaVersion !== DEVICE_EVIDENCE_SCHEMA || evidence.status !== 'passed' || !EVIDENCE_ID.test(evidence.evidenceId ?? '')) throw new Error('device evidence identity is invalid');
  validateTimestamp(evidence.collectedAt);
  validateBoard(evidence.board); validateRelease(evidence.release); validateIdentity(evidence.identity, evidence.release);
  validateCollector(evidence.collector); validateBoot(evidence.boot, evidence.identity); validateSerial(evidence.serial); validateCapabilities(evidence.capabilities);
  assertNoSensitiveStrings(evidence);
  if (typeof context.serialLog === 'string') {
    const parsed = parseSerialLog(context.serialLog, { evidenceId: evidence.evidenceId, manifestFingerprint: evidence.release.manifestFingerprint, kernelRelease: evidence.identity.kernelRelease });
    const expectedDigest = createHash('sha256').update(parsed.normalized).digest('hex');
    if (expectedDigest !== evidence.serial.sha256) throw new Error('serial log digest does not match evidence');
  }
  return evidence;
}
