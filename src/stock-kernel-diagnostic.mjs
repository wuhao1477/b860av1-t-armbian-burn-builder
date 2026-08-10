import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ANDROID_MAGIC = 'ANDROID!';
const AML_MULTI_DTB_MAGIC = 'AML_';
const ARM64_ELF_MACHINE = 0xb7;
const BOOT_PARTITION_BYTES = 32 * 1024 * 1024;
const DIAGNOSTIC_MARKER = 'B860_STOCK_KERNEL_DIAGNOSTIC=1';

function fail(message) {
  throw new Error(message);
}

function align(value, boundary) {
  return Math.ceil(value / boundary) * boundary;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function checkedPayload(image, offset, size, label) {
  if (size <= 0 || offset + size > image.length) fail(`${label} payload is invalid`);
  return image.subarray(offset, offset + size);
}

function parseAndroidBoot(input, label) {
  if (input.length < 2048 || input.toString('ascii', 0, 8) !== ANDROID_MAGIC) {
    fail(`${label} is not Android boot v0`);
  }
  const pageSize = input.readUInt32LE(36);
  if (pageSize !== 2048) fail(`${label} page size is not 2048`);
  const kernelSize = input.readUInt32LE(8);
  const ramdiskSize = input.readUInt32LE(16);
  const secondSize = input.readUInt32LE(24);
  const kernelOffset = pageSize;
  const ramdiskOffset = kernelOffset + align(kernelSize, pageSize);
  const secondOffset = ramdiskOffset + align(ramdiskSize, pageSize);
  return {
    header: input.subarray(0, pageSize),
    kernel: checkedPayload(input, kernelOffset, kernelSize, `${label} kernel`),
    ramdisk: checkedPayload(input, ramdiskOffset, ramdiskSize, `${label} ramdisk`),
    second: checkedPayload(input, secondOffset, secondSize, `${label} second`),
    pageSize,
  };
}

function padded(payload, pageSize) {
  const padding = align(payload.length, pageSize) - payload.length;
  return padding === 0 ? [payload] : [payload, Buffer.alloc(padding)];
}

function bootId(parts) {
  const hash = crypto.createHash('sha1');
  for (const payload of parts) {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);
    hash.update(payload);
    hash.update(size);
  }
  return hash.digest();
}

function normalizedHeader(header) {
  const normalized = Buffer.from(header);
  normalized.fill(0, 16, 20);
  normalized.fill(0, 576, 608);
  return normalized;
}

function kernelVersion(kernel) {
  if (kernel[0] !== 0x1f || kernel[1] !== 0x8b) fail('stock kernel is not gzip-compressed');
  let image;
  try {
    image = gunzipSync(kernel);
  } catch {
    fail('stock kernel gzip stream is invalid');
  }
  const match = image.toString('latin1').match(/Linux version ([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s\0]+)?)/u);
  if (!match) fail('stock kernel version is missing');
  return match[1];
}

function newcInteger(header, field) {
  const value = Number.parseInt(header.toString('ascii', 6 + (field * 8), 14 + (field * 8)), 16);
  if (!Number.isSafeInteger(value)) fail('initramfs newc field is invalid');
  return value;
}

function normalizedCpioName(name) {
  const normalized = name.replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    fail(`initramfs path is unsafe: ${name}`);
  }
  return normalized;
}

function parseNewc(archive) {
  const entries = new Map();
  let offset = 0;
  while (offset + 110 <= archive.length) {
    const header = archive.subarray(offset, offset + 110);
    if (header.toString('ascii', 0, 6) !== '070701') fail('initramfs is not newc');
    const mode = newcInteger(header, 1);
    const size = newcInteger(header, 6);
    const nameSize = newcInteger(header, 11);
    if (nameSize < 1 || offset + 110 + nameSize > archive.length) fail('initramfs name is invalid');
    const nameStart = offset + 110;
    const name = archive.toString('utf8', nameStart, nameStart + nameSize - 1);
    const dataStart = align(nameStart + nameSize, 4);
    if (dataStart + size > archive.length) fail(`initramfs payload is truncated: ${name}`);
    if (name === 'TRAILER!!!') return entries;
    entries.set(normalizedCpioName(name), { mode, data: archive.subarray(dataStart, dataStart + size) });
    offset = align(dataStart + size, 4);
  }
  fail('initramfs newc trailer is missing');
}

function requireExecutable(entries, name) {
  const entry = entries.get(name);
  if (!entry || (entry.mode & 0o111) === 0) fail(`initramfs requires executable ${name}`);
  return entry.data;
}

function requireArm64Elf(entries, name) {
  const data = requireExecutable(entries, name);
  if (data.length < 20 || data.toString('binary', 0, 4) !== '\x7fELF'
      || data[4] !== 2 || data[5] !== 1 || data.readUInt16LE(18) !== ARM64_ELF_MACHINE) {
    fail(`initramfs ${name} is not an ARM64 ELF`);
  }
}

function requireFile(entries, name) {
  const entry = entries.get(name);
  if (!entry || entry.data.length === 0) fail(`initramfs requires ${name}`);
  return entry.data;
}

export function validateDiagnosticInitramfs(inputPath) {
  const compressed = fs.readFileSync(inputPath);
  let archive;
  try {
    archive = gunzipSync(compressed);
  } catch {
    fail('diagnostic initramfs is not gzip');
  }
  const entries = parseNewc(archive);
  const init = requireExecutable(entries, 'init').toString('utf8');
  requireArm64Elf(entries, 'bin/busybox');
  requireFile(entries, 'www/index.html');
  const release = requireFile(entries, 'etc/b860-diagnostic-release').toString('utf8');
  if (!init.includes(DIAGNOSTIC_MARKER) || !release.includes(DIAGNOSTIC_MARKER)) {
    fail(`initramfs marker is missing: ${DIAGNOSTIC_MARKER}`);
  }
  if (!/\bhttpd\s+-p\s+80\s+-h\s+\/www\b/u.test(init)) {
    fail('initramfs must start the HTTP status server');
  }
  if (entries.has('usr/sbin/dropbear') || entries.has('usr/bin/dropbearkey')
      || entries.has('root/.ssh/authorized_keys')) {
    fail('HTTP-only initramfs must not contain SSH server payloads');
  }
  return {
    format: 'gzip-newc', architecture: 'arm64', marker: DIAGNOSTIC_MARKER,
    remoteAccess: 'http-only', entries: entries.size,
    size: compressed.length, sha256: sha256(compressed),
  };
}

function inputPath(directory, file) {
  if (directory instanceof URL) return fileURLToPath(new URL(file, directory));
  return `${directory.replace(/\/$/u, '')}/${file}`;
}

function validatePinnedSource(source, label) {
  if (!source || !/^https:\/\/github\.com\//u.test(source.repository)
      || !/^[0-9a-f]{40}$/u.test(source.commit)) {
    fail(`${label} source contract is invalid`);
  }
  return source.commit;
}

function validateInputFile(directory, contract, label) {
  if (!contract || typeof contract.file !== 'string'
      || !/^[0-9a-f]{64}$/u.test(contract.sha256)
      || !Number.isSafeInteger(contract.size)) {
    fail(`${label} contract is invalid`);
  }
  const contents = fs.readFileSync(inputPath(directory, contract.file));
  if (contents.length !== contract.size) fail(`${label} size mismatch`);
  if (sha256(contents) !== contract.sha256) fail(`${label} sha256 mismatch`);
  return contents;
}

export function validateStockDiagnosticInputs(boardInputs, configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const stockBoot = validateInputFile(boardInputs, config.stockBoot, 'stock boot');
  const logo = validateInputFile(boardInputs, config.stockLogo, 'stock logo');
  if (config.files?.[config.stockBoot.file] !== config.stockBoot.sha256
      || config.files?.[config.stockLogo.file] !== config.stockLogo.sha256) {
    fail('stock diagnostic file hash map differs from its contracts');
  }
  const parsed = parseAndroidBoot(stockBoot, 'stock boot');
  if (parsed.second.toString('ascii', 0, 4) !== AML_MULTI_DTB_MAGIC) {
    fail('stock boot second is not an AML multi-DTB');
  }
  return {
    schemaVersion: 1,
    status: config.status,
    stockBootSha256: sha256(stockBoot),
    stockBootSize: stockBoot.length,
    kernelVersion: kernelVersion(parsed.kernel),
    logoSha256: sha256(logo),
    logoSize: logo.length,
    busyboxCommit: validatePinnedSource(config.diagnosticSources?.busybox, 'BusyBox'),
  };
}

export function replaceAndroidBootRamdisk(sourcePath, initramfsPath, outputPath) {
  validateDiagnosticInitramfs(initramfsPath);
  const source = parseAndroidBoot(fs.readFileSync(sourcePath), 'stock boot');
  if (source.second.toString('ascii', 0, 4) !== AML_MULTI_DTB_MAGIC) {
    fail('stock boot second is not an AML multi-DTB');
  }
  const ramdisk = fs.readFileSync(initramfsPath);
  const header = Buffer.from(source.header);
  header.writeUInt32LE(ramdisk.length, 16);
  header.fill(0, 576, 608);
  bootId([source.kernel, ramdisk, source.second]).copy(header, 576);
  const output = Buffer.concat([
    header, ...padded(source.kernel, source.pageSize), ...padded(ramdisk, source.pageSize),
    ...padded(source.second, source.pageSize),
  ]);
  if (output.length > BOOT_PARTITION_BYTES) fail('diagnostic boot exceeds the 32 MiB partition');
  fs.writeFileSync(outputPath, output);
  return {
    size: output.length, kernelSha256: sha256(source.kernel),
    ramdiskSha256: sha256(ramdisk), secondSha256: sha256(source.second),
  };
}

function validateSourceContract(sourceImage, sourcePath, config) {
  const expected = config.stockBoot;
  if (!expected || !/^[0-9a-f]{64}$/u.test(expected.sha256)
      || !Number.isSafeInteger(expected.size)) {
    fail('stock diagnostic boot contract is invalid');
  }
  if (sourceImage.length !== expected.size) fail('stock boot size mismatch');
  if (sha256(sourceImage) !== expected.sha256) fail('stock boot sha256 mismatch');
  return parseAndroidBoot(sourceImage, sourcePath);
}

export function validateStockDiagnosticBoot(sourcePath, candidatePath, initramfsPath, configPath) {
  const sourceImage = fs.readFileSync(sourcePath);
  const candidateImage = fs.readFileSync(candidatePath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const source = validateSourceContract(sourceImage, sourcePath, config);
  const candidate = parseAndroidBoot(candidateImage, 'diagnostic boot');
  const initramfs = fs.readFileSync(initramfsPath);
  validateDiagnosticInitramfs(initramfsPath);
  if (!source.kernel.equals(candidate.kernel)) fail('diagnostic boot stock kernel differs');
  if (!source.second.equals(candidate.second)) fail('diagnostic boot stock multi-DTB differs');
  if (!candidate.ramdisk.equals(initramfs)) fail('diagnostic boot ramdisk differs from initramfs');
  if (candidate.ramdisk.length > source.ramdisk.length) {
    fail('diagnostic boot ramdisk exceeds the stock ramdisk size');
  }
  if (!normalizedHeader(source.header).equals(normalizedHeader(candidate.header))) {
    fail('diagnostic boot changed a protected header field');
  }
  return {
    schemaVersion: 1,
    sourceBootSha256: sha256(sourceImage),
    candidateBootSha256: sha256(candidateImage),
    kernelSha256: sha256(source.kernel),
    sourceRamdiskSha256: sha256(source.ramdisk),
    sourceRamdiskSize: source.ramdisk.length,
    diagnosticRamdiskSha256: sha256(candidate.ramdisk),
    diagnosticRamdiskSize: candidate.ramdisk.length,
    ramdiskHeadroom: source.ramdisk.length - candidate.ramdisk.length,
    secondSha256: sha256(source.second),
    kernelVersion: kernelVersion(source.kernel),
    onlyRamdiskChanged: true,
  };
}
