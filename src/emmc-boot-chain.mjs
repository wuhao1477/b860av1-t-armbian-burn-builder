import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';

import { inspectSparseImage, readSparseExt4Uuid } from './android-sparse.mjs';

const SECTOR_BYTES = 512;
const MIB = 1024 * 1024;
const ENV_BYTES = 64 * 1024;
const ENV_DATA_BYTES = ENV_BYTES - 4;
const FAT_BOOT_BYTES = 256 * MIB;
const BOOT_START_MIB = 1144;
const ROOT_START_MIB = 2176;
const EMMC_AUTOSCRIPT = 'if fatload mmc 1 1020000 emmc_autoscript; then autoscr 1020000; fi;';

function fail(message) {
  throw new Error(message);
}

function sectors(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % SECTOR_BYTES !== 0) {
    fail(`${label} size must be a positive multiple of 512 bytes`);
  }
  return bytes / SECTOR_BYTES;
}

function readTemplate(templatePath) {
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const source = Buffer.from(template.dataBase64 ?? '', 'base64');
  if (template.schemaVersion !== 1 || source.length !== template.source?.length
      || template.source?.variableCount !== 81 || source.at(-1) !== 0) {
    fail('stock U-Boot environment template is invalid');
  }
  return { source, expectedCount: template.source.variableCount };
}

function parseVariables(data) {
  const variables = {};
  let count = 0;
  for (const entry of data.toString('latin1').split('\0')) {
    if (entry.length === 0) break;
    const separator = entry.indexOf('=');
    if (separator <= 0) fail('U-Boot environment contains an invalid variable');
    const name = entry.slice(0, separator);
    if (Object.hasOwn(variables, name)) fail(`U-Boot environment repeats ${name}`);
    variables[name] = entry.slice(separator + 1);
    count += 1;
  }
  return { variables, variableCount: count };
}

function encodeVariables(variables) {
  const entries = Object.entries(variables).map(([name, value]) => `${name}=${value}`);
  const payload = Buffer.from(`${entries.join('\0')}\0\0`, 'latin1');
  if (payload.length > ENV_DATA_BYTES) fail('U-Boot environment exceeds 64 KiB');
  const data = Buffer.alloc(ENV_DATA_BYTES);
  payload.copy(data);
  return data;
}

export function writeUbootEnvironment(templatePath, outputPath) {
  const { source, expectedCount } = readTemplate(templatePath);
  const parsed = parseVariables(source);
  if (parsed.variableCount !== expectedCount) fail('stock U-Boot variable count is invalid');
  parsed.variables.bootcmd = 'run start_emmc_autoscript; run storeboot';
  parsed.variables.upgrade_step = '2';
  parsed.variables.start_emmc_autoscript = EMMC_AUTOSCRIPT;
  const data = encodeVariables(parsed.variables);
  const image = Buffer.alloc(ENV_BYTES);
  image.writeUInt32LE(crc32(data), 0);
  data.copy(image, 4);
  fs.writeFileSync(outputPath, image);
  return inspectUbootEnvironment(outputPath);
}

/**
 * 逐字面写回原厂环境快照，一个变量都不改。
 *
 * 用途：原厂 preboot 里的 upgrade_check 在 upgrade_step == 3 时直接 run update，
 * 而 update 会先 `update 1000` 等 USB 烧录工具——于是每次开机都停在 splash，
 * 永远走不到 bootcmd 的 storeboot。这与 boot.PARTITION 的内容完全无关，正好
 * 解释了「改 ramdisk 的三版与逐字节原厂对照包表现完全一致」。
 *
 * 快照里的 upgrade_step 是 0，落到 upgrade_check 的 else 分支，直通 bootcmd。
 * 因此这里刻意不做任何修改：偏离越少，实验的区分力越强。
 */
export function writeStockUbootEnvironment(templatePath, outputPath) {
  const { source, expectedCount } = readTemplate(templatePath);
  const parsed = parseVariables(source);
  if (parsed.variableCount !== expectedCount) fail('stock U-Boot variable count is invalid');
  if (parsed.variables.upgrade_step === '3') {
    fail('stock environment snapshot itself parks the board in upgrade mode');
  }
  const data = encodeVariables(parsed.variables);
  const image = Buffer.alloc(ENV_BYTES);
  image.writeUInt32LE(crc32(data), 0);
  data.copy(image, 4);
  fs.writeFileSync(outputPath, image);
  const inspected = inspectUbootEnvironment(outputPath);
  if (inspected.variableCount !== expectedCount) fail('written env variable count differs');
  return {
    schemaVersion: 1,
    size: inspected.size,
    storedCrc32: inspected.storedCrc32,
    variableCount: inspected.variableCount,
    upgradeStep: inspected.variables.upgrade_step,
    bootcmd: inspected.variables.bootcmd,
    modifiedVariables: 0,
  };
}

export function inspectUbootEnvironment(imagePath) {
  const image = fs.readFileSync(imagePath);
  if (image.length !== ENV_BYTES) fail('env.PARTITION must be exactly 65536 bytes');
  const storedCrc32 = image.readUInt32LE(0);
  const actualCrc32 = crc32(image.subarray(4));
  if (storedCrc32 !== actualCrc32) fail('env.PARTITION CRC32 is invalid');
  return { size: image.length, storedCrc32, ...parseVariables(image.subarray(4)) };
}

function writePartition(image, index, type, startLba, count) {
  const offset = 446 + ((index - 1) * 16);
  image[offset] = 0;
  image.fill(0xff, offset + 1, offset + 4);
  image[offset + 4] = type;
  image.fill(0xff, offset + 5, offset + 8);
  image.writeUInt32LE(startLba, offset + 8);
  image.writeUInt32LE(count, offset + 12);
}

export function writeDosMbr(outputPath, bootBytes, rootBytes) {
  const bootSectors = sectors(bootBytes, 'FAT boot image');
  const rootSectors = sectors(rootBytes, 'ext4 root image');
  const bootStartLba = (BOOT_START_MIB * MIB) / SECTOR_BYTES;
  const rootStartLba = (ROOT_START_MIB * MIB) / SECTOR_BYTES;
  if (bootStartLba + bootSectors > rootStartLba) {
    fail('FAT boot image overlaps the root filesystem');
  }
  if (rootStartLba + rootSectors > 0xffffffff) fail('root filesystem exceeds DOS MBR limits');
  const image = Buffer.alloc(SECTOR_BYTES);
  writePartition(image, 1, 0x0c, bootStartLba, bootSectors);
  writePartition(image, 2, 0x83, rootStartLba, rootSectors);
  image.writeUInt16LE(0xaa55, 510);
  fs.writeFileSync(outputPath, image);
  return inspectDosMbr(outputPath);
}

export function inspectDosMbr(imagePath) {
  const image = fs.readFileSync(imagePath);
  if (image.length !== SECTOR_BYTES || image.readUInt16LE(510) !== 0xaa55) {
    fail('1.PARTITION is not a 512-byte DOS MBR');
  }
  const partitions = [];
  for (let index = 1; index <= 4; index += 1) {
    const offset = 446 + ((index - 1) * 16);
    const type = image[offset + 4];
    const sectorsValue = image.readUInt32LE(offset + 12);
    if (type === 0 && sectorsValue === 0) continue;
    const status = image[offset];
    if (![0, 0x80].includes(status)) fail(`DOS MBR partition ${index} has invalid status`);
    partitions.push({ index, bootable: status === 0x80, type,
      startLba: image.readUInt32LE(offset + 8), sectors: sectorsValue });
  }
  if (partitions.length !== 2 || partitions[0].type !== 0x0c || partitions[1].type !== 0x83) {
    fail('DOS MBR must contain FAT32 boot and Linux root partitions');
  }
  return { size: image.length, partitions };
}

export function inspectFatBootImage(imagePath) {
  const size = fs.statSync(imagePath).size;
  const image = Buffer.alloc(SECTOR_BYTES);
  const descriptor = fs.openSync(imagePath, 'r');
  try {
    if (fs.readSync(descriptor, image, 0, image.length, 0) !== image.length) {
      fail('system.PARTITION boot sector is truncated');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (size !== FAT_BOOT_BYTES || image.readUInt16LE(510) !== 0xaa55) {
    fail('system.PARTITION is not a FAT boot filesystem');
  }
  const bytesPerSector = image.readUInt16LE(11);
  const sectorsPerCluster = image[13];
  const totalSectors16 = image.readUInt16LE(19);
  const totalSectors = totalSectors16 || image.readUInt32LE(32);
  const fatType = image.toString('ascii', 82, 90).trim();
  if (![512, 1024, 2048, 4096].includes(bytesPerSector)
      || sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0
      || totalSectors * bytesPerSector !== size || fatType !== 'FAT32') {
    fail('system.PARTITION FAT32 geometry is invalid');
  }
  return { bytesPerSector, sectorsPerCluster, size, totalSectors, type: fatType };
}

function copyFatFile(imagePath, fatPath, outputPath) {
  try {
    childProcess.execFileSync('mcopy', ['-i', imagePath, `::${fatPath}`, outputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    fail(`system.PARTITION lacks ${fatPath}`);
  }
  const contents = fs.readFileSync(outputPath);
  if (contents.length === 0) fail(`system.PARTITION contains an empty ${fatPath}`);
  return { path: fatPath, size: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'), contents };
}

function parseBootPaths(contents) {
  const values = {};
  for (const line of contents.toString('utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (match) values[match[1]] = match[2];
  }
  if (!values.APPEND?.includes('root=UUID=')) fail('uEnv.txt lacks root filesystem arguments');
  return ['LINUX', 'INITRD', 'FDT'].map((name) => {
    const value = values[name];
    if (typeof value !== 'string' || !/^\/?[A-Za-z0-9._+/-]+$/u.test(value)
        || value.split('/').includes('..')) {
      fail(`uEnv.txt contains an invalid ${name} path`);
    }
    return value;
  });
}

export function inspectFatBootFiles(imagePath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-fat-files-'));
  try {
    const fixed = ['emmc_autoscript', 'u-boot.emmc', 'uEnv.txt'].map((name, index) => (
      copyFatFile(imagePath, name, path.join(directory, `fixed-${index}`))
    ));
    const bootPaths = parseBootPaths(fixed[2].contents);
    const configured = bootPaths.map((name, index) => (
      copyFatFile(imagePath, name, path.join(directory, `configured-${index}`))
    ));
    return [...fixed, ...configured].map(({ contents, ...record }) => record);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function validateEmmcBootChain(mbrPath, environmentPath, fatPath, rootfsPath) {
  const mbr = inspectDosMbr(mbrPath);
  const environment = inspectUbootEnvironment(environmentPath);
  const fat = inspectFatBootImage(fatPath);
  const rootfs = inspectSparseImage(rootfsPath);
  const [fatPartition, rootPartition] = mbr.partitions;
  if (fatPartition.startLba !== (BOOT_START_MIB * MIB) / SECTOR_BYTES) {
    fail('DOS MBR FAT partition start is invalid');
  }
  if (rootPartition.startLba !== (ROOT_START_MIB * MIB) / SECTOR_BYTES) {
    fail('DOS MBR root partition start is invalid');
  }
  if (fatPartition.sectors * SECTOR_BYTES !== fat.size) {
    fail('DOS MBR FAT partition length differs from system.PARTITION');
  }
  if (rootPartition.sectors * SECTOR_BYTES !== rootfs.logicalBytes) {
    fail('DOS MBR root partition length differs from data.PARTITION');
  }
  if (environment.variables.bootcmd !== 'run start_emmc_autoscript; run storeboot'
      || environment.variables.start_emmc_autoscript !== EMMC_AUTOSCRIPT
      || environment.variables.upgrade_step !== '2') {
    fail('env.PARTITION does not select the eMMC Armbian boot chain');
  }
  return {
    schemaVersion: 1,
    strategy: 'stock-fip-env-emmc-fat',
    environment: { size: environment.size, variableCount: environment.variableCount,
      bootcmd: environment.variables.bootcmd,
      startEmmcAutoscript: environment.variables.start_emmc_autoscript },
    fat: { ...fat, files: inspectFatBootFiles(fatPath),
      startLba: fatPartition.startLba, startMiB: BOOT_START_MIB },
    rootfs: { ...rootfs, startLba: rootPartition.startLba, startMiB: ROOT_START_MIB },
    rootUuid: readSparseExt4Uuid(rootfsPath),
  };
}
