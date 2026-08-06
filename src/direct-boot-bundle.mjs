import fs from 'node:fs';

import { extractUbootScriptBody, validateUbootScriptImage } from './uboot-script-payload.mjs';

export const SECTOR_BYTES = 512;
export const MIB = 1024 * 1024;
export const BOOT_PARTITION_BYTES = 32 * MIB;
export const SCRIPT_REGION_BYTES = 64 * 1024;
export const MBR_OFFSET_BYTES = SCRIPT_REGION_BYTES;
export const FIT_OFFSET_BYTES = MIB;
export const ROOT_START_MIB = 2176;
export const ROOT_START_LBA = ROOT_START_MIB * 2048;

const LEGACY_HEADER_BYTES = 64;
const FIT_MAGIC = 0xd00dfeed;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  throw new Error(message);
}

function normalizeUuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('root UUID is invalid');
  return value.toLowerCase();
}

function requireAlignedBytes(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value % SECTOR_BYTES !== 0) {
    fail(`${label} must be a positive sector-aligned size`);
  }
  return value;
}

function readFit(path) {
  const image = fs.readFileSync(path);
  if (image.length < 8 || image.readUInt32BE(0) !== FIT_MAGIC) fail('FIT payload has an invalid FDT header');
  const declared = image.readUInt32BE(4);
  if (declared < 8 || declared > image.length) fail('FIT payload declares an invalid total size');
  return { image, declared };
}

export function buildRootMbr(rootfsBytes) {
  const bytes = requireAlignedBytes(rootfsBytes, 'root filesystem');
  const sectors = bytes / SECTOR_BYTES;
  if (ROOT_START_LBA + sectors > 0xffffffff) fail('root partition exceeds DOS MBR limits');
  const image = Buffer.alloc(SECTOR_BYTES);
  const entry = 446;
  image[entry] = 0;
  image.fill(0xff, entry + 1, entry + 4);
  image[entry + 4] = 0x83;
  image.fill(0xff, entry + 5, entry + 8);
  image.writeUInt32LE(ROOT_START_LBA, entry + 8);
  image.writeUInt32LE(sectors, entry + 12);
  image.writeUInt16LE(0xaa55, 510);
  return image;
}

export function inspectRootMbr(image, rootfsBytes) {
  if (!Buffer.isBuffer(image) || image.length !== SECTOR_BYTES || image.readUInt16LE(510) !== 0xaa55) {
    fail('runtime MBR is invalid');
  }
  const expectedBytes = requireAlignedBytes(rootfsBytes, 'root filesystem');
  const entry = 446;
  if (image[entry + 4] !== 0x83 || image.readUInt32LE(entry + 8) !== ROOT_START_LBA
      || image.readUInt32LE(entry + 12) !== expectedBytes / SECTOR_BYTES) {
    fail('runtime MBR root partition does not match the data partition');
  }
  for (let index = 1; index < 4; index += 1) {
    const offset = 446 + index * 16;
    if (image[offset + 4] !== 0 || image.readUInt32LE(offset + 8) !== 0
        || image.readUInt32LE(offset + 12) !== 0) fail('runtime MBR has unexpected extra partitions');
  }
  return { size: image.length, rootStartLba: ROOT_START_LBA, rootSectors: expectedBytes / SECTOR_BYTES };
}

export function buildBootScriptSource({ rootUuid, fitBytes }) {
  const uuid = normalizeUuid(rootUuid);
  const bytes = requireAlignedBytes(fitBytes, 'FIT payload');
  if (FIT_OFFSET_BYTES + bytes > BOOT_PARTITION_BYTES) fail('FIT payload exceeds the stock boot partition');
  const fitHex = `0x${bytes.toString(16)}`;
  return [
    `setenv bootargs root=UUID=${uuid} rw rootwait rootfstype=ext4 mem=1024M console=ttyAML0,115200n8 console=tty0 no_console_suspend consoleblank=0 fsck.fix=yes fsck.repair=yes net.ifnames=0;`,
    'if printenv mac; then setenv bootargs ${bootargs} mac=${mac}; elif printenv eth_mac; then setenv bootargs ${bootargs} mac=${eth_mac}; elif printenv ethaddr; then setenv bootargs ${bootargs} mac=${ethaddr}; fi;',
    'if store read boot 0x04000000 0x10000 0x200; then',
    '  if mmc dev 1; then',
    '    if mmc write 0x04000000 0 1; then',
    `      if store read boot 0x08000000 0x100000 ${fitHex}; then`,
    '        bootm 0x08000000;',
    '      fi;',
    '    fi;',
    '  fi;',
    'fi;',
    'reset;',
    '',
  ].join('\n');
}

function readLegacyScript(imagePath) {
  const image = fs.readFileSync(imagePath);
  if (image.length < LEGACY_HEADER_BYTES) fail('boot script image is too small');
  const dataSize = image.readUInt32BE(12);
  if (dataSize <= 0 || LEGACY_HEADER_BYTES + dataSize > image.length) fail('boot script image size is invalid');
  const payload = image.subarray(LEGACY_HEADER_BYTES, LEGACY_HEADER_BYTES + dataSize);
  validateUbootScriptImage(image.subarray(0, LEGACY_HEADER_BYTES + dataSize), payload);
  return { image, source: extractUbootScriptBody(payload) };
}

export function buildBootBundle({ scriptPath, mbrPath, fitPath, outputPath }) {
  const script = readLegacyScript(scriptPath);
  const mbr = fs.readFileSync(mbrPath);
  const { image: fit, declared } = readFit(fitPath);
  if (script.image.length > MBR_OFFSET_BYTES) fail('boot script exceeds its reserved region');
  if (mbr.length !== SECTOR_BYTES) fail('runtime MBR must be exactly one sector');
  if (FIT_OFFSET_BYTES + fit.length > BOOT_PARTITION_BYTES) fail('FIT payload exceeds the stock boot partition');
  if (/imgread|boot_android|run update|fatload/i.test(script.source)) {
    fail('boot script contains a stock Android fallback');
  }
  for (const required of ['store read boot', 'mmc dev 1', 'mmc write', 'bootm 0x08000000']) {
    if (!script.source.includes(required)) fail(`boot script is missing ${required}`);
  }
  const size = Math.ceil((FIT_OFFSET_BYTES + fit.length) / SECTOR_BYTES) * SECTOR_BYTES;
  if (size > BOOT_PARTITION_BYTES) fail('boot bundle exceeds the stock boot partition');
  const bundle = Buffer.alloc(size);
  script.image.copy(bundle, 0);
  mbr.copy(bundle, MBR_OFFSET_BYTES);
  fit.copy(bundle, FIT_OFFSET_BYTES);
  fs.writeFileSync(outputPath, bundle);
  return { size, scriptBytes: script.image.length, mbrOffset: MBR_OFFSET_BYTES, fitOffset: FIT_OFFSET_BYTES, fitBytes: fit.length, fitDeclaredBytes: declared };
}

export function inspectBootBundle(bundlePath, { rootUuid, rootfsBytes }) {
  const bundle = fs.readFileSync(bundlePath);
  if (bundle.length === 0 || bundle.length > BOOT_PARTITION_BYTES || bundle.length % SECTOR_BYTES !== 0) {
    fail('boot bundle size is invalid');
  }
  const scriptImage = bundle.subarray(0, MBR_OFFSET_BYTES);
  const scriptSize = scriptImage.readUInt32BE(12) + LEGACY_HEADER_BYTES;
  if (scriptSize > MBR_OFFSET_BYTES) fail('boot bundle script exceeds its reserved region');
  const scriptPayload = scriptImage.subarray(LEGACY_HEADER_BYTES, scriptSize);
  validateUbootScriptImage(scriptImage.subarray(0, scriptSize), scriptPayload);
  const source = extractUbootScriptBody(scriptPayload).toString('ascii');
  if (/imgread|boot_android|run update|fatload/i.test(source)) fail('boot bundle contains an Android fallback');
  const mbr = bundle.subarray(MBR_OFFSET_BYTES, MBR_OFFSET_BYTES + SECTOR_BYTES);
  const mbrResult = inspectRootMbr(mbr, rootfsBytes);
  const fit = bundle.subarray(FIT_OFFSET_BYTES);
  const fitDeclared = fit.readUInt32BE(4);
  if (fit.readUInt32BE(0) !== FIT_MAGIC || fitDeclared < 8 || fitDeclared > fit.length) fail('boot bundle FIT payload is invalid');
  if (!source.includes(`root=UUID=${normalizeUuid(rootUuid)}`)) fail('boot bundle root UUID is missing');
  return { size: bundle.length, scriptBytes: scriptSize, mbrOffset: MBR_OFFSET_BYTES, fitOffset: FIT_OFFSET_BYTES, fitBytes: fitDeclared, root: mbrResult };
}
