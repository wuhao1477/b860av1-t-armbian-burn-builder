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
const MBR_TABLE_START = 446;

function fail(message) {
  throw new Error(message);
}

function sectors(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % SECTOR_BYTES !== 0) {
    fail(`${label} size must be a positive multiple of 512 bytes`);
  }
  return bytes / SECTOR_BYTES;
}

function writePartition(image, index, type, startLba, count) {
  const offset = MBR_TABLE_START + ((index - 1) * 16);
  image[offset] = 0;
  image.fill(0xff, offset + 1, offset + 4);
  image[offset + 4] = type;
  image.fill(0xff, offset + 5, offset + 8);
  image.writeUInt32LE(startLba, offset + 8);
  image.writeUInt32LE(count, offset + 12);
}

function readSector0(imagePath) {
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
