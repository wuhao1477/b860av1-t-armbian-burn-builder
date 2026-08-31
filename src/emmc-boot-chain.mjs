import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { inspectSparseImage, readSparseExt4Uuid } from './android-sparse.mjs';

const SECTOR_BYTES = 512;
const MIB = 1024 * 1024;
const FAT_BOOT_BYTES = 32 * MIB;
const BOOT_START_MIB = 1104;
const ROOT_START_MIB = 2176;
// 原厂 u-boot 的 store 按分区名查 meson1.dtb 的 /partitions 表，表里只有
// conf/logo/recovery/rsv/tee/crypt/misc/boot/system/cache/data。曾经把 DOS MBR
// 当成一个名为 "1" 的分区项来写，烧录工具必然报
// [0x30402004]UBOOT/烧录分区 1/初始化分区/命令结果返回错误。
// eMMC user 区 LBA 0 同时承载 bootloader 前 442 字节和 MBR 分区表
// （blkdevparts 的 4M@0(bootloader)，以及 ophub install-aml.sh 用
// bs=1 count=442 + bs=512 skip=1 seek=1 刻意跳过 442..511 的写法），
// 所以 MBR 直接嵌进 bootloader.PARTITION 的 sector 0。
const BURN_PARTITIONS = [
  'bootloader.PARTITION',
  'boot.PARTITION',
  'data.PARTITION',
];
export const MBR_TABLE_START = 446;

// 原厂 BL2 自带完整性摘要，嵌 MBR 会破坏它，必须重算。
// gxlimg bl2.c 的 gi_bl2_sign()：SHA-256 覆盖 [0x10,0x50) 与
// [0x10+hash_start, +hash_size)，摘要本身存在 0x50..0x70。本板
// hash_start=0x60、hash_size=0xbf90，即第二段是 [0x70,0xC000)——
// 446..511 落在里面。实测原厂 0x50 处的值正是按此规则算出的
// 195c7ea9…，而写完 MBR 后重算得到 494f89e1…，两者不等时 bootrom
// 直接拒绝执行 BL2：整机没有串口输出、没有 HDMI、只有电源灯。
// 0x70..0x25F 全为零说明这块板没有 RSA 签名，只有这一份摘要，
// 所以嵌完 MBR 重算并写回是完整的修复，不需要任何厂商私钥。
const BL2_STAGE_BYTES = 0xc000;
const BL2_HEADER_OFFSET = 0x10;
const BL2_HEADER_BYTES = 0x40;
const BL2_DIGEST_OFFSET = 0x50;
const BL2_DIGEST_BYTES = 0x20;
const BL2_HASH_START_FIELD = 0x2c;
const BL2_HASH_SIZE_FIELD = 0x3c;
export const STOCK_BL2_SELF_DIGEST =
  '195c7ea9e48dc92b1aae54cd3a0aba6b8e1f1a7052392f39f1ff52c8b2ef18d6';

function fail(message) {
  throw new Error(message);
}

function readBl2Stage(bootloaderPath, flags = 'r') {
  const image = Buffer.alloc(BL2_STAGE_BYTES);
  const descriptor = fs.openSync(bootloaderPath, flags);
  try {
    if (fs.readSync(descriptor, image, 0, BL2_STAGE_BYTES, 0) !== BL2_STAGE_BYTES) {
      fail(`${path.basename(bootloaderPath)} is shorter than the BL2 stage`);
    }
    return { image, descriptor };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

/** 按 gxlimg 的规则重算 BL2 头里的完整性摘要。 */
export function bl2SelfDigest(image) {
  const hashStart = image.readUInt32LE(BL2_HASH_START_FIELD);
  const hashSize = image.readUInt32LE(BL2_HASH_SIZE_FIELD);
  const start = BL2_HEADER_OFFSET + hashStart;
  if (start + hashSize > image.length) fail('BL2 header describes a hash range past the stage');
  if (start <= BL2_DIGEST_OFFSET + BL2_DIGEST_BYTES - 1 && start >= BL2_DIGEST_OFFSET) {
    fail('BL2 hashed payload overlaps its own digest');
  }
  return crypto.createHash('sha256')
    .update(image.subarray(BL2_HEADER_OFFSET, BL2_HEADER_OFFSET + BL2_HEADER_BYTES))
    .update(image.subarray(start, start + hashSize))
    .digest();
}

/** 嵌 MBR 之后写回重算的摘要，否则 bootrom 不执行 BL2。 */
export function resealBl2(bootloaderPath) {
  const { image, descriptor } = readBl2Stage(bootloaderPath, 'r+');
  try {
    const digest = bl2SelfDigest(image);
    fs.writeSync(descriptor, digest, 0, BL2_DIGEST_BYTES, BL2_DIGEST_OFFSET);
    return digest.toString('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

/** 交付件必须自洽：存的摘要要等于按同一规则重算的结果。 */
export function verifyBl2Seal(bootloaderPath) {
  const { image, descriptor } = readBl2Stage(bootloaderPath);
  fs.closeSync(descriptor);
  const stored = image
    .subarray(BL2_DIGEST_OFFSET, BL2_DIGEST_OFFSET + BL2_DIGEST_BYTES).toString('hex');
  const computed = bl2SelfDigest(image).toString('hex');
  if (stored !== computed) fail(`BL2 integrity digest is stale: ${stored} != ${computed}`);
  return computed;
}

/**
 * 出证据时把 446..511 清零、并把摘要恢复成原厂值，这样和原厂 BL2 摘要
 * 逐字节比对仍然成立：除了 66 字节 MBR 和这份重算摘要，签名段没有改动。
 */
export function normalizeBl2ForEvidence(image) {
  const copy = Buffer.from(image);
  copy.fill(0, MBR_TABLE_START, SECTOR_BYTES);
  Buffer.from(STOCK_BL2_SELF_DIGEST, 'hex').copy(copy, BL2_DIGEST_OFFSET);
  return copy;
}

export function sectors(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % SECTOR_BYTES !== 0) {
    fail(`${label} size must be a positive multiple of 512 bytes`);
  }
  return bytes / SECTOR_BYTES;
}

export function writePartition(image, index, type, startLba, count) {
  const offset = MBR_TABLE_START + ((index - 1) * 16);
  image[offset] = 0;
  image.fill(0xff, offset + 1, offset + 4);
  image[offset + 4] = type;
  image.fill(0xff, offset + 5, offset + 8);
  image.writeUInt32LE(startLba, offset + 8);
  image.writeUInt32LE(count, offset + 12);
}

export function readSector0(imagePath) {
  const sector = Buffer.alloc(SECTOR_BYTES);
  const descriptor = fs.openSync(imagePath, 'r');
  try {
    if (fs.readSync(descriptor, sector, 0, SECTOR_BYTES, 0) !== SECTOR_BYTES) {
      fail(`${path.basename(imagePath)} sector 0 is truncated`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return sector;
}

/**
 * 把 FAT16 与 rootfs 的 DOS 分区项写进 bootloader.PARTITION 的 sector 0。
 * 只动 446..511；0..441 是原厂签名 BL2 头，必须逐字节保留。
 */
export function embedDosMbr(bootloaderPath, bootBytes, rootBytes) {
  const bootSectors = sectors(bootBytes, 'FAT boot image');
  const rootSectors = sectors(rootBytes, 'ext4 root image');
  const bootStartLba = (BOOT_START_MIB * MIB) / SECTOR_BYTES;
  const rootStartLba = (ROOT_START_MIB * MIB) / SECTOR_BYTES;
  if (bootStartLba + bootSectors > rootStartLba) {
    fail('FAT boot image overlaps the root filesystem');
  }
  if (rootStartLba + rootSectors > 0xffffffff) fail('root filesystem exceeds DOS MBR limits');
  const sector = readSector0(bootloaderPath);
  for (let index = MBR_TABLE_START; index < SECTOR_BYTES; index += 1) {
    if (sector[index] !== 0) fail('bootloader.PARTITION sector 0 already uses the MBR table area');
  }
  writePartition(sector, 1, 0x0e, bootStartLba, bootSectors);
  writePartition(sector, 2, 0x83, rootStartLba, rootSectors);
  sector.writeUInt16LE(0xaa55, 510);
  const descriptor = fs.openSync(bootloaderPath, 'r+');
  try {
    fs.writeSync(descriptor, sector, 0, SECTOR_BYTES, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  resealBl2(bootloaderPath);
  return inspectDosMbr(bootloaderPath);
}

export function inspectDosMbr(imagePath) {
  const image = readSector0(imagePath);
  if (image.readUInt16LE(510) !== 0xaa55) {
    fail('bootloader.PARTITION sector 0 lacks a DOS MBR signature');
  }
  const partitions = [];
  for (let index = 1; index <= 4; index += 1) {
    const offset = MBR_TABLE_START + ((index - 1) * 16);
    const type = image[offset + 4];
    const sectorCount = image.readUInt32LE(offset + 12);
    if (type === 0 && sectorCount === 0) continue;
    const status = image[offset];
    if (![0, 0x80].includes(status)) fail(`DOS MBR partition ${index} has invalid status`);
    partitions.push({
      index,
      bootable: status === 0x80,
      type,
      startLba: image.readUInt32LE(offset + 8),
      sectors: sectorCount,
    });
  }
  if (partitions.length !== 2 || partitions[0].type !== 0x0e || partitions[1].type !== 0x83) {
    fail('DOS MBR must contain FAT16 boot and Linux root partitions');
  }
  return { size: image.length, partitions };
}

export function inspectFatBootImage(imagePath) {
  const size = fs.statSync(imagePath).size;
  const bootSector = Buffer.alloc(SECTOR_BYTES);
  const descriptor = fs.openSync(imagePath, 'r');
  try {
    if (fs.readSync(descriptor, bootSector, 0, bootSector.length, 0) !== bootSector.length) {
      fail('boot.PARTITION boot sector is truncated');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (size !== FAT_BOOT_BYTES || bootSector.readUInt16LE(510) !== 0xaa55) {
    fail('boot.PARTITION is not a 32 MiB FAT boot filesystem');
  }
  const bytesPerSector = bootSector.readUInt16LE(11);
  const sectorsPerCluster = bootSector[13];
  const totalSectors16 = bootSector.readUInt16LE(19);
  const totalSectors = totalSectors16 || bootSector.readUInt32LE(32);
  const fatType = bootSector.toString('ascii', 54, 62).trim();
  if (![512, 1024, 2048, 4096].includes(bytesPerSector)
      || sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0
      || totalSectors * bytesPerSector !== size || fatType !== 'FAT16') {
    fail('boot.PARTITION FAT16 geometry is invalid');
  }
  return { bytesPerSector, sectorsPerCluster, size, totalSectors, type: fatType };
}

function copyFatFile(imagePath, fatPath, outputPath) {
  try {
    childProcess.execFileSync('mcopy', ['-i', imagePath, `::${fatPath}`, outputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    fail(`boot.PARTITION lacks ${fatPath}`);
  }
  const contents = fs.readFileSync(outputPath);
  if (contents.length === 0) fail(`boot.PARTITION contains an empty ${fatPath}`);
  return {
    path: fatPath,
    size: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    contents,
  };
}

function normalizeUuid(value) {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    fail('extlinux.conf contains an invalid root filesystem UUID');
  }
  return value.toLowerCase();
}

function parseExtlinuxConfig(contents) {
  const source = contents.toString('utf8');
  if (/storeboot|imgread|ANDROID!|blkdevparts/iu.test(source)) {
    fail('extlinux.conf contains a prohibited Android boot marker');
  }
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*(LINUX|INITRD|FDT|APPEND)\s+(.+?)\s*$/u);
    if (match) {
      if (Object.hasOwn(values, match[1])) fail(`extlinux.conf repeats ${match[1]}`);
      values[match[1]] = match[2];
    }
  }
  const paths = ['LINUX', 'INITRD', 'FDT'].map((name) => {
    const value = values[name];
    if (typeof value !== 'string' || !/^\/[A-Za-z0-9._+/-]+$/u.test(value)
        || value.split('/').includes('..')) {
      fail(`extlinux.conf contains an invalid ${name} path`);
    }
    return value;
  });
  if (paths[0] !== '/Image.gz' || paths[1] !== '/initrd.img'
      || paths[2] !== '/dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb') {
    fail('extlinux.conf does not select the B860 Armbian boot files');
  }
  const rootArguments = (values.APPEND ?? '').split(/\s+/u)
    .filter((value) => value.startsWith('root=UUID='));
  if (rootArguments.length !== 1) fail('extlinux.conf lacks one root filesystem UUID argument');
  return {
    paths,
    rootUuid: normalizeUuid(rootArguments[0].slice('root=UUID='.length)),
  };
}

function validateBootPayloads(files) {
  const kernel = gunzipSync(files[1].contents);
  if (kernel.length < 64 || kernel.toString('ascii', 56, 60) !== 'ARMd') {
    fail('Image.gz is not a compressed ARM64 kernel Image');
  }
  const dtb = files[3].contents;
  if (dtb.length < 8 || dtb.readUInt32BE(0) !== 0xd00dfeed
      || dtb.readUInt32BE(4) > dtb.length) {
    fail('B860 device tree is invalid');
  }
}

function inspectFatBootContents(imagePath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-fat-files-'));
  try {
    const config = copyFatFile(
      imagePath,
      'extlinux/extlinux.conf',
      path.join(directory, 'extlinux.conf'),
    );
    const parsed = parseExtlinuxConfig(config.contents);
    const configured = parsed.paths.map((fatPath, index) => (
      copyFatFile(imagePath, fatPath, path.join(directory, `configured-${index}`))
    ));
    const files = [config, ...configured];
    validateBootPayloads(files);
    return {
      files: files.map(({ contents, ...record }) => record),
      rootUuid: parsed.rootUuid,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function inspectFatBootFiles(imagePath) {
  return inspectFatBootContents(imagePath).files;
}

export function inspectBurnPackagePartitions(packageDirectory) {
  const entries = fs.readdirSync(packageDirectory, { withFileTypes: true });
  const actual = entries.filter((entry) => entry.name.endsWith('.PARTITION'))
    .map((entry) => entry.name);
  for (const name of actual) {
    if (!BURN_PARTITIONS.includes(name)) fail(`unexpected partition payload: ${name}`);
  }
  for (const name of BURN_PARTITIONS) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry?.isFile() || fs.statSync(path.join(packageDirectory, name)).size === 0) {
      fail(`missing partition payload: ${name}`);
    }
  }
  return { partitions: [...BURN_PARTITIONS] };
}

export function validateEmmcBootChain(bootloaderPath, fatPath, rootfsPath) {
  const mbr = inspectDosMbr(bootloaderPath);
  verifyBl2Seal(bootloaderPath);
  const fat = inspectFatBootImage(fatPath);
  const rootfs = inspectSparseImage(rootfsPath);
  const fatContents = inspectFatBootContents(fatPath);
  const rootUuid = readSparseExt4Uuid(rootfsPath);
  const [fatPartition, rootPartition] = mbr.partitions;
  if (fatPartition.startLba !== (BOOT_START_MIB * MIB) / SECTOR_BYTES) {
    fail('DOS MBR FAT partition start is invalid');
  }
  if (rootPartition.startLba !== (ROOT_START_MIB * MIB) / SECTOR_BYTES) {
    fail('DOS MBR root partition start is invalid');
  }
  if (fatPartition.sectors * SECTOR_BYTES !== fat.size) {
    fail('DOS MBR FAT partition length differs from boot.PARTITION');
  }
  if (rootPartition.sectors * SECTOR_BYTES !== rootfs.logicalBytes) {
    fail('DOS MBR root partition length differs from data.PARTITION');
  }
  if (fatContents.rootUuid !== rootUuid) {
    fail('extlinux root filesystem UUID differs from data.PARTITION');
  }
  return {
    schemaVersion: 1,
    strategy: 'vendor-fip-mainline-bl33-extlinux',
    fat: {
      ...fat,
      files: fatContents.files,
      startLba: fatPartition.startLba,
      startMiB: BOOT_START_MIB,
    },
    rootfs: { ...rootfs, startLba: rootPartition.startLba, startMiB: ROOT_START_MIB },
    rootUuid,
  };
}
