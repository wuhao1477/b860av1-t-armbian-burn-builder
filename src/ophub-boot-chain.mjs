// ophub BL33 直刷布局的校验：eMMC 上只有一个 DOS 分区（ext4 rootfs @ data），
// /boot 在 rootfs 内部。与 emmc-boot-chain.mjs 的两分区 + FAT16 布局并存，
// 因为那套被 zImage+uInitrd = 44.6 MiB > 32 MiB boot 分区证伪了。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { inspectSparseImage, readSparseExt4Uuid } from './android-sparse.mjs';
import {
  MBR_TABLE_START,
  normalizeBl2ForEvidence,
  readSector0,
  resealBl2,
  sectors,
  verifyBl2Seal,
  writePartition,
} from './emmc-boot-chain.mjs';

const SECTOR_BYTES = 512;
const MIB = 1024 * 1024;
const ROOT_START_MIB = 2176;
const ROOT_START_LBA = (ROOT_START_MIB * MIB) / SECTOR_BYTES;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const OPHUB_PARTITIONS = ['bootloader.PARTITION', 'data.PARTITION'];
// ophub 的 u-boot-s905x-s912.bin，即 /etc/ophub-release 的 UBOOT_OVERLOAD。
// s905_autoscript 用 `go 0x1000000` 链载它，所以它就链接在 GXL 的 BL33 入口。
export const OPHUB_BL33_SHA256 = '53c84804a5a80be5341dc6c30fbf881c04fb0e1bcb3116ad90faf324812b1b79';
export const STOCK_SIGNED_STAGES = Object.freeze({
  bl2: '0ed67a2ee15629eb4af16b41d2908816d3a4fe7ca591bcec7756fb56afc26417',
  bl30: '99208e665e255330e682db4df321982fa0bf29324f42047f10c1d689ae0e8b07',
  bl301: 'ad24ba46950216b32aa4f3edcf7be51707a732474752aaade1bc9aadc7249fd5',
  bl31: '2f4947e9f92aa9aabdd452f2514f268ee657fed610629cd2457a329be571101a',
});
const STOCK_BL33 = '3e983db37d4505626f92550d8b5b9da629f4251c9b003359b28034814ea342d5';

function fail(message) {
  throw new Error(message);
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function normalizeUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} UUID is invalid`);
  return value.toLowerCase();
}

/**
 * 单分区 MBR 嵌进 bootloader.PARTITION 的 sector 0，只动 446..511。
 * 0..445 是原厂签名 BL2 头，逐字节保留；烧录工具送不到 eMMC 的 LBA 0，
 * 独立的 1.PARTITION 会被 store 按分区名拒掉。
 * 分区项标成 bootable，distro_bootcmd 的 `part list -bootable` 才直接命中。
 * 446..511 落在 BL2 自身摘要覆盖的范围里，写完必须 resealBl2() 重算，
 * 否则 bootrom 拒绝执行 BL2，整机连电源灯以外什么都没有。
 */
export function embedRootfsMbr(bootloaderPath, rootBytes) {
  const rootSectors = sectors(rootBytes, 'ext4 root image');
  if (ROOT_START_LBA + rootSectors > 0xffffffff) fail('root filesystem exceeds DOS MBR limits');
  const sector = readSector0(bootloaderPath);
  for (let index = MBR_TABLE_START; index < SECTOR_BYTES; index += 1) {
    if (sector[index] !== 0) fail('bootloader.PARTITION sector 0 already uses the MBR table area');
  }
  writePartition(sector, 1, 0x83, ROOT_START_LBA, rootSectors);
  sector[MBR_TABLE_START] = 0x80;
  sector.writeUInt16LE(0xaa55, 510);
  const descriptor = fs.openSync(bootloaderPath, 'r+');
  try {
    fs.writeSync(descriptor, sector, 0, SECTOR_BYTES, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  resealBl2(bootloaderPath);
  return inspectRootfsMbr(bootloaderPath);
}

export function inspectRootfsMbr(bootloaderPath) {
  const sector = readSector0(bootloaderPath);
  if (sector.readUInt16LE(510) !== 0xaa55) {
    fail('bootloader.PARTITION sector 0 lacks a DOS MBR signature');
  }
  const partitions = [];
  for (let index = 1; index <= 4; index += 1) {
    const offset = MBR_TABLE_START + ((index - 1) * 16);
    const type = sector[offset + 4];
    const sectorCount = sector.readUInt32LE(offset + 12);
    if (type === 0 && sectorCount === 0) continue;
    const status = sector[offset];
    if (![0, 0x80].includes(status)) fail(`DOS MBR partition ${index} has invalid status`);
    partitions.push({
      index,
      bootable: status === 0x80,
      type,
      startLba: sector.readUInt32LE(offset + 8),
      sectors: sectorCount,
    });
  }
  if (partitions.length !== 1) fail('DOS MBR must describe exactly one partition');
  const [root] = partitions;
  if (root.index !== 1 || root.type !== 0x83) fail('DOS MBR partition 1 must be Linux ext4');
  if (!root.bootable) fail('DOS MBR partition 1 must be bootable');
  if (root.startLba !== ROOT_START_LBA) fail('DOS MBR partition 1 does not start at the data partition');
  return { size: sector.length, partitions };
}

/**
 * rootfs 内部的 extlinux.conf。路径必须带 /boot/ 前缀：sysboot 把绝对路径
 * 按分区根解析（cmd/pxe_utils.c 的 get_bootfile_path）。
 */
export function validateRootfsExtlinux(configPath, rootUuid, boardDtb) {
  const source = fs.readFileSync(configPath, 'utf8');
  if (/storeboot|imgread|ANDROID!|blkdevparts/iu.test(source)) {
    fail('extlinux.conf contains a prohibited Android boot marker');
  }
  if (!/^[A-Za-z0-9._+-]+\.dtb$/u.test(boardDtb)) fail('board DTB name is invalid');
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*(KERNEL|LINUX|INITRD|FDT|APPEND)\s+(.+?)\s*$/u);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) fail(`extlinux.conf repeats ${match[1]}`);
    values[match[1]] = match[2];
  }
  const kernel = values.KERNEL ?? values.LINUX;
  const expected = ['/boot/zImage', '/boot/uInitrd', `/boot/dtb/amlogic/${boardDtb}`];
  const actual = [kernel, values.INITRD, values.FDT];
  for (const [index, name] of ['KERNEL', 'INITRD', 'FDT'].entries()) {
    if (actual[index] !== expected[index]) fail(`extlinux.conf ${name} must be ${expected[index]}`);
  }
  const append = (values.APPEND ?? '').split(/\s+/u).filter(Boolean);
  const roots = append.filter((value) => value.startsWith('root=UUID='));
  if (roots.length !== 1) fail('extlinux.conf lacks one root filesystem UUID argument');
  const uuid = normalizeUuid(roots[0].slice('root=UUID='.length), 'extlinux root filesystem');
  if (uuid !== normalizeUuid(rootUuid, 'data.PARTITION root filesystem')) {
    fail('extlinux.conf root filesystem UUID differs from data.PARTITION');
  }
  // 没有串口，console=tty0 是唯一可读通道；B860 只有 1 GB，mem 必须封顶。
  for (const argument of ['console=tty0', 'mem=1024M', 'rootfstype=ext4']) {
    if (!append.includes(argument)) fail(`extlinux.conf APPEND lacks ${argument}`);
  }
  return { kernel, initrd: values.INITRD, fdt: values.FDT, rootUuid: uuid, append };
}

function environmentValue(image, name) {
  const marker = Buffer.from(`${name}=`);
  const values = new Set();
  let offset = 0;
  while ((offset = image.indexOf(marker, offset)) >= 0) {
    if (offset === 0 || image[offset - 1] === 0) {
      const end = image.indexOf(0, offset);
      if (end > offset) values.add(image.subarray(offset + marker.length, end).toString('ascii'));
    }
    offset += marker.length;
  }
  if (values.size !== 1) fail(`ophub BL33 must contain one ${name} environment value`);
  return [...values][0];
}

/**
 * ophub 的 BL33 必须逐字节就是这台机器上跑过的那份 u-boot.ext，并且它的
 * 内建环境要能自己走到 rootfs 里的 extlinux.conf。
 */
export function inspectOphubBl33(rawPath) {
  const image = fs.readFileSync(rawPath);
  const sha256 = digest(image);
  if (sha256 !== OPHUB_BL33_SHA256) fail('BL33 is not the ophub u-boot.ext this board has run');
  if (image.readUInt32BE(0) === 0x40414d4c) fail('BL33 still carries an @AML container header');
  const start = image.indexOf(Buffer.from('U-Boot 2020.07'));
  if (start < 0) fail('ophub BL33 has no U-Boot 2020.07 version string');
  const end = image.indexOf(0, start);
  const version = image.subarray(start, end < 0 ? start + 160 : end).toString('ascii');
  if (!version.includes('armbian')) fail('ophub BL33 is not the armbian-gxl build');
  const prefixes = environmentValue(image, 'boot_prefixes').split(/\s+/u).filter(Boolean);
  if (!prefixes.includes('/boot/')) fail('ophub BL33 does not scan the /boot/ prefix');
  if (environmentValue(image, 'boot_syslinux_conf') !== 'extlinux/extlinux.conf') {
    fail('ophub BL33 does not read extlinux/extlinux.conf');
  }
  if (!environmentValue(image, 'bootcmd').includes('distro_bootcmd')) {
    fail('ophub BL33 default boot command does not run distro_bootcmd');
  }
  return {
    size: image.length,
    sha256,
    version,
    bootPrefixes: prefixes,
    bootTargets: environmentValue(image, 'boot_targets').split(/\s+/u).filter(Boolean),
  };
}

function componentEvidence(directory, name) {
  const data = fs.readFileSync(path.join(directory, name));
  return { size: data.length, sha256: digest(data) };
}

/**
 * BL2 从 FIP 偏移 0 开始，嵌 MBR 改了它的 446..511，也逼着 0x50 的自摘要
 * 重算。清零那 66 字节、把摘要还原成原厂那份之后必须精确等于原厂 BL2 摘要
 * —— 这就是除 MBR 与重算摘要之外签名段未被改动的证据。
 */
function signedStageEvidence(directory) {
  const bl2Path = path.join(directory, 'bl2.sign');
  verifyBl2Seal(bl2Path);
  const bl2 = fs.readFileSync(bl2Path);
  const evidence = {
    bl2: { size: bl2.length, sha256: digest(normalizeBl2ForEvidence(bl2)) },
    bl30: componentEvidence(directory, 'bl30.enc'),
    bl301: componentEvidence(directory, 'bl301.enc'),
    bl31: componentEvidence(directory, 'bl31.enc'),
  };
  for (const [name, expected] of Object.entries(STOCK_SIGNED_STAGES)) {
    if (evidence[name].sha256 !== expected) fail(`vendor signed stage differs: ${name}`);
  }
  return evidence;
}

export function inspectOphubPackage(packageDirectory) {
  const names = fs.readdirSync(packageDirectory)
    .filter((name) => name.endsWith('.PARTITION'));
  for (const name of names) {
    if (!OPHUB_PARTITIONS.includes(name)) fail(`unexpected partition payload: ${name}`);
  }
  for (const name of OPHUB_PARTITIONS) {
    if (!names.includes(name) || fs.statSync(path.join(packageDirectory, name)).size === 0) {
      fail(`missing partition payload: ${name}`);
    }
  }
  return { partitions: [...OPHUB_PARTITIONS] };
}

export function validateOphubBootChain(bootloaderPath, sparseRootPath, componentsDirectory, rawBl33Path) {
  const mbr = inspectRootfsMbr(bootloaderPath);
  const rootfs = inspectSparseImage(sparseRootPath);
  const rootUuid = readSparseExt4Uuid(sparseRootPath);
  const [root] = mbr.partitions;
  if (root.sectors * SECTOR_BYTES !== rootfs.logicalBytes) {
    fail('DOS MBR partition 1 length differs from data.PARTITION');
  }
  const bl33 = componentEvidence(componentsDirectory, 'bl33.enc');
  if (bl33.sha256 === STOCK_BL33) fail('BL33 still matches the Android vendor stage');
  const fip = fs.readFileSync(bootloaderPath);
  return {
    schemaVersion: 1,
    status: 'format-valid / hardware-unverified',
    strategy: 'vendor-fip-ophub-bl33-rootfs-extlinux',
    fip: {
      size: fip.length,
      sha256: digest(fip),
      components: { ...signedStageEvidence(componentsDirectory), bl33 },
    },
    uboot: inspectOphubBl33(rawBl33Path),
    rootfs: {
      ...rootfs,
      startLba: root.startLba,
      startMiB: ROOT_START_MIB,
      bootDirectory: '/boot',
    },
    rootUuid,
  };
}
