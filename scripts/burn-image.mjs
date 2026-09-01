#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import os from 'node:os';
import { basename } from 'node:path';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { readSparseExt4Uuid, validateSparseCapacity } from '../src/android-sparse.mjs';
import { replaceLinuxTargetDtb, validateBurnDtbRoles } from '../src/burn-dtb-roles.mjs';
import { buildBurnReport, validateBurnReport } from '../src/burn-report.mjs';
import { EMMC_NODE, validateStandaloneDtb } from '../src/burn-standalone-dtb.mjs';
import { validateDirectBootContract } from '../src/direct-boot-contract.mjs';
import {
  inspectBurnPackagePartitions,
  inspectDosMbr,
  inspectFatBootImage,
  inspectFatBootFiles,
  resealBl2,
  validateEmmcBootChain,
  verifyBl2Seal,
  embedDosMbr,
} from '../src/emmc-boot-chain.mjs';

export { readSparseExt4Uuid, validateSparseCapacity } from '../src/android-sparse.mjs';
export { replaceLinuxTargetDtb, validateBurnDtbRoles } from '../src/burn-dtb-roles.mjs';
export { buildBurnReport, validateBurnReport } from '../src/burn-report.mjs';
export {
  bl2SelfDigest,
  inspectBurnPackagePartitions,
  inspectDosMbr,
  inspectFatBootImage,
  inspectFatBootFiles,
  normalizeBl2ForEvidence,
  resealBl2,
  validateEmmcBootChain,
  verifyBl2Seal,
  embedDosMbr,
} from '../src/emmc-boot-chain.mjs';
import {
  embedRootfsMbr,
  inspectOphubPackage,
  inspectRootfsMbr,
  validateOphubBootChain,
  validateRootfsExtlinux,
} from '../src/ophub-boot-chain.mjs';
export {
  embedRootfsMbr,
  inspectOphubPackage,
  inspectRootfsMbr,
  validateOphubBootChain,
  validateRootfsExtlinux,
} from '../src/ophub-boot-chain.mjs';

const BOOT_PARTITION_BYTES = 32 * 1024 * 1024;
const STOCK_BOOTM_BYTES = 64 * 1024 * 1024;
const P211_DTB_SLOT_BYTES = 36 * 1024;
const ANDROID_BOOT_PAGE_BYTES = 2048;
const BURN_PARTITION_ARGUMENT = 'blkdevparts=mmcblk2:4M@0(bootloader),64M@36M(reserved),768M@108M(cache),8M@884M(env),4M@900M(conf),32M@912M(logo),32M@952M(recovery),8M@992M(rsv),8M@1008M(tee),32M@1024M(crypt),32M@1064M(misc),32M@1104M(boot),1024M@1144M(system),-@2176M(data)';

function fail(message) { throw new Error(message); }
function u32(buffer, offset, value) { buffer.writeUInt32LE(value >>> 0, offset); }

function align(value, boundary) {
  return Math.ceil(value / boundary) * boundary;
}

function normalizeUuid(value) {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    fail('root filesystem UUID is invalid');
  }
  return value.toLowerCase();
}

function inspectBootCommandLine(image) {
  const field = image.subarray(64, 576);
  const nul = field.indexOf(0);
  const commandLine = field.subarray(0, nul < 0 ? field.length : nul).toString('ascii');
  const roots = commandLine.split(/\s+/u).filter((token) => token.startsWith('root='));
  if (roots.length !== 1 || !roots[0].startsWith('root=UUID=')) {
    fail('stock boot command line must contain one root=UUID');
  }
  return { commandLine, rootUuid: normalizeUuid(roots[0].slice('root=UUID='.length)) };
}

export function writeStandaloneDtb(inputPath, overlayPath, outputPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-standalone-dtb-'));
  const compiledOverlay = path.join(directory, 'burn-partitions.dtbo');
  const mergedDtb = path.join(directory, 'meson1.merged.dtb');
  const compactDtb = path.join(directory, 'meson1.compact.dtb');
  try {
    childProcess.execFileSync(
      'dtc',
      ['-q', '-@', '-I', 'dts', '-O', 'dtb', '-o', compiledOverlay, overlayPath],
    );
    childProcess.execFileSync(
      'fdtoverlay',
      ['-i', inputPath, '-o', mergedDtb, compiledOverlay],
    );
    const rootNodes = childProcess.execFileSync('fdtget', ['-l', mergedDtb, '/'], {
      encoding: 'utf8',
    }).trim().split(/\r?\n/u);
    if (rootNodes.includes('__symbols__')) {
      childProcess.execFileSync('fdtput', ['-r', mergedDtb, '/__symbols__']);
    }
    // 这块板的 eMMC 打不通 HS200：卡（东芝 008G70，DEVICE_TYPE 0x57）和主机都声明支持，
    // 但切换被卡拒绝 —— mmc_select_hs200 failed, error -74 (EBADMSG)。50 MHz 和 200 MHz
    // 两次实机都一样。而内核 mmc_select_timing() 碰到 EBADMSG 是「不报错、直接
    // goto bus_speed」，既不重试也不退到 HS52，结果卡在 legacy 25 MHz、22.4 MB/s。
    // 所以这里主动摘掉 mmc-hs200-1_8v，让它走 cap-mmc-highspeed + mmc-ddr-1_8v
    // 选到 DDR52。overlay 只能加属性不能删，只好在合并后用 fdtput -d 删。
    // 先查再删：fdtput -d 对不存在的属性会直接报错，上游哪天不带它构建就会崩。
    let emmcProperties = [];
    try {
      emmcProperties = childProcess.execFileSync('fdtget', ['-p', mergedDtb, EMMC_NODE], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().split(/\s+/u);
    } catch { emmcProperties = []; }
    if (emmcProperties.includes('mmc-hs200-1_8v')) {
      childProcess.execFileSync('fdtput', ['-d', mergedDtb, EMMC_NODE, 'mmc-hs200-1_8v']);
    }
    childProcess.execFileSync(
      'dtc',
      ['-q', '-I', 'dtb', '-O', 'dtb', '-o', compactDtb, mergedDtb],
    );
    const compact = fs.readFileSync(compactDtb);
    if (compact.length < 8 || compact.readUInt32BE(0) !== 0xd00dfeed) {
      fail('standalone DTB overlay output is not an FDT');
    }
    const fdtSize = compact.readUInt32BE(4);
    if (fdtSize !== compact.length || fdtSize > P211_DTB_SLOT_BYTES) {
      fail('standalone DTB overlay output size is invalid');
    }
    fs.writeFileSync(outputPath, compact);
    return { size: compact.length, fdtSize };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function extractBootSecond(image) {
  if (image.length < ANDROID_BOOT_PAGE_BYTES || image.toString('ascii', 0, 8) !== 'ANDROID!') {
    fail('boot partition is not Android boot v0');
  }
  const page = image.readUInt32LE(36);
  if (page !== ANDROID_BOOT_PAGE_BYTES) fail('boot partition page size is not 2048');
  const offset = page + align(image.readUInt32LE(8), page) + align(image.readUInt32LE(16), page);
  const size = image.readUInt32LE(24);
  if (size === 0 || offset + size > image.length) fail('boot partition second payload is invalid');
  return image.subarray(offset, offset + size);
}

export function extractBootSecondDtb(bootPath, outputPath) {
  const second = extractBootSecond(fs.readFileSync(bootPath));
  const inspected = inspectPlainFdt(second, 'boot second');
  fs.writeFileSync(outputPath, second);
  return inspected;
}

function bootPayload(image, sizeOffset, start, allowEmpty = false) {
  const size = image.readUInt32LE(sizeOffset);
  if (size === 0 && allowEmpty) return { payload: Buffer.alloc(0), next: start };
  if (size === 0 || start + size > image.length) fail('Android boot payload is invalid');
  return { payload: image.subarray(start, start + size), next: start + align(size, ANDROID_BOOT_PAGE_BYTES) };
}

function inspectArm64Kernel(compressed, loadAddress) {
  if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    fail('stock boot kernel is not gzip-compressed');
  }
  let kernel;
  try { kernel = gunzipSync(compressed); } catch { fail('stock boot kernel gzip stream is invalid'); }
  if (kernel.length < 64 || kernel.length > STOCK_BOOTM_BYTES
      || kernel.toString('ascii', 56, 60) !== 'ARMd') {
    fail('stock boot kernel is not a supported ARM64 Image');
  }
  const textOffset = Number(kernel.readBigUInt64LE(8));
  if (!Number.isSafeInteger(textOffset) || textOffset !== loadAddress) {
    fail('stock boot kernel text offset does not match its load address');
  }
  return { payload: kernel, size: kernel.length, textOffset };
}

export function validateStockBoot(bootPath, expectedRootUuid) {
  const image = fs.readFileSync(bootPath);
  assertBootPartitionSize(image.length);
  if (image.length < ANDROID_BOOT_PAGE_BYTES || image.toString('ascii', 0, 8) !== 'ANDROID!') {
    fail('boot partition is not Android boot v0');
  }
  const pageSize = image.readUInt32LE(36);
  if (pageSize !== ANDROID_BOOT_PAGE_BYTES) fail('boot partition page size is not 2048');
  const kernelLoadAddress = image.readUInt32LE(12);
  if (kernelLoadAddress !== 0x01080000) fail('stock boot kernel load address is invalid');
  const kernelPart = bootPayload(image, 8, pageSize);
  const ramdiskPart = bootPayload(image, 16, kernelPart.next, true);
  const secondPart = bootPayload(image, 24, ramdiskPart.next);
  if (ramdiskPart.payload.length !== 0) {
    fail('stock direct-root boot must not contain an initramfs');
  }
  if (ramdiskPart.payload.length >= 4 && ramdiskPart.payload.readUInt32BE(0) === 0x27051956) {
    fail('Android boot ramdisk contains a legacy uInitrd header');
  }
  const kernel = inspectArm64Kernel(kernelPart.payload, kernelLoadAddress);
  const directBoot = validateDirectBootContract(kernel.payload, ramdiskPart.payload);
  const second = inspectPlainFdt(secondPart.payload, 'boot second');
  const command = inspectBootCommandLine(image);
  if (expectedRootUuid !== undefined && command.rootUuid !== normalizeUuid(expectedRootUuid)) {
    fail('stock boot root filesystem UUID differs from data.PARTITION');
  }
  return {
    size: image.length, pageSize, kernelCompressedSize: kernelPart.payload.length,
    kernelUncompressedSize: kernel.size, kernelLoadAddress, kernelTextOffset: kernel.textOffset,
    ramdiskSize: ramdiskPart.payload.length, secondSize: secondPart.payload.length,
    secondFdtSize: second.fdtSize, rootUuid: command.rootUuid,
    ...directBoot,
  };
}

function inspectPlainFdt(image, label) {
  if (!Buffer.isBuffer(image) || image.length < 8 || image.readUInt32BE(0) !== 0xd00dfeed) {
    fail(`${label} is not a plain FDT`);
  }
  const fdtSize = image.readUInt32BE(4);
  if (fdtSize < 8 || fdtSize > image.length) fail(`${label} FDT size is invalid`);
  return { size: image.length, fdtSize };
}

export function validateBootSecondDtb(bootPath) {
  const second = extractBootSecond(fs.readFileSync(bootPath));
  return inspectPlainFdt(second, 'boot second');
}

export function validateDtbPair(bootPath, standalonePath) {
  const second = extractBootSecond(fs.readFileSync(bootPath));
  const standalone = fs.readFileSync(standalonePath);
  const inspected = inspectPlainFdt(second, 'boot second');
  inspectPlainFdt(standalone, 'meson1.dtb');
  if (!second.equals(standalone)) fail('boot second and meson1.dtb differ');
  return inspected;
}

export function selectKernelPath(paths) {
  for (const name of ['Image.gz', 'zImage', 'Image']) {
    const matches = paths.filter((candidate) => basename(candidate) === name).sort();
    if (matches.length > 0) return matches[0];
  }
  fail('boot partition lacks Image.gz, zImage, or Image');
}

export function selectDeviceTreePath(paths, expectedName = 'meson-gxl-s905x-p212-b860av11t.dtb') {
  const matches = paths
    .filter((candidate) => basename(candidate) === expectedName)
    .sort();
  if (matches.length > 0) return matches[0];
  fail(`boot partition lacks the expected DTB: ${expectedName}`);
}

export function selectInitrdPath(paths) {
  const matches = paths
    .filter((candidate) => /^initrd\.img-.+/.test(basename(candidate)))
    .sort();
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail('boot partition lacks a raw versioned initrd');
  fail('boot partition contains multiple raw versioned initrds');
}

export function createBootCommandLine(memoryLimitMiB, rootUuid) {
  if (!Number.isInteger(memoryLimitMiB) || memoryLimitMiB < 256 || memoryLimitMiB > 4096) {
    fail('memory limit must be an integer from 256 to 4096 MiB');
  }
  return `${BURN_PARTITION_ARGUMENT} root=UUID=${normalizeUuid(rootUuid)} rw rootwait rootfstype=ext4 mem=${memoryLimitMiB}M console=ttyAML0,115200n8 console=tty0 no_console_suspend consoleblank=0 fsck.fix=yes fsck.repair=yes net.ifnames=0 init=/sbin/init`;
}

export function assertBootPartitionSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0) fail('boot image size is invalid');
  if (size > BOOT_PARTITION_BYTES) {
    fail(`boot image size ${size} exceeds the stock ${BOOT_PARTITION_BYTES}-byte boot partition`);
  }
  return size;
}

export function prepareBootKernel(inputPath, outputPath) {
  const input = fs.readFileSync(inputPath);
  const alreadyCompressed = input[0] === 0x1f && input[1] === 0x8b;
  const output = alreadyCompressed ? input : gzipSync(input, { level: 9, mtime: 0 });
  fs.writeFileSync(outputPath, output);
  return { compressed: !alreadyCompressed, size: output.length };
}

export function makeBoot(kernelPath, ramdiskPath, dtbPath, outputPath, cmdline) {
  const page = 2048;
  const kernel = fs.readFileSync(kernelPath);
  const ramdisk = fs.readFileSync(ramdiskPath);
  const dtb = fs.readFileSync(dtbPath);
  inspectPlainFdt(dtb, 'boot second input');
  const command = Buffer.from(cmdline, 'ascii');
  if (command.length > 512) fail('Android boot v0 command line exceeds 512 bytes');
  const header = Buffer.alloc(page);
  header.write('ANDROID!', 0, 'ascii');
  u32(header, 8, kernel.length); u32(header, 12, 0x01080000);
  u32(header, 16, ramdisk.length); u32(header, 20, 0x01000000);
  u32(header, 24, dtb.length); u32(header, 28, 0x00f00000);
  u32(header, 32, 0x100); u32(header, 36, page);
  header.write('Armbian-B860', 48, 'ascii'); command.copy(header, 64);
  const id = crypto.createHash('sha1');
  for (const part of [kernel, ramdisk, dtb]) { id.update(part); const size = Buffer.alloc(4); size.writeUInt32LE(part.length); id.update(size); }
  id.digest().copy(header, 576);
  const chunks = [];
  for (const part of [header, kernel, ramdisk, dtb]) {
    chunks.push(part); const pad = (page - (part.length % page)) % page;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  const totalSize = chunks.reduce((sum, part) => sum + part.length, 0);
  assertBootPartitionSize(totalSize);
  fs.writeFileSync(outputPath, Buffer.concat(chunks));
  return { size: fs.statSync(outputPath).size, kernel: kernel.length, ramdisk: ramdisk.length, dtb: dtb.length, cmdline: command.length };
}

export function makeSparse(inputPath, outputPath, length) {
  const block = 4096;
  if (length % block) fail('rootfs length is not 4096-byte aligned');
  const input = fs.openSync(inputPath, 'r'); const output = fs.openSync(outputPath, 'w');
  const header = Buffer.alloc(28); header.writeUInt32LE(0xed26ff3a); header.writeUInt16LE(1, 4); header.writeUInt16LE(28, 8); header.writeUInt16LE(12, 10); header.writeUInt32LE(block, 12); header.writeUInt32LE(length / block, 16);
  fs.writeSync(output, header);
  const chunk = Buffer.alloc(block); let pos = 0; let remaining = length; let count = 0; let zeros = 0; let raw = [];
  const emitDontCare = (blocks) => { const h = Buffer.alloc(12); h.writeUInt16LE(0xCAC3); h.writeUInt32LE(blocks, 4); h.writeUInt32LE(12, 8); fs.writeSync(output, h); count++; };
  const emitRaw = (parts) => { const data = Buffer.concat(parts); const h = Buffer.alloc(12); h.writeUInt16LE(0xCAC1); h.writeUInt32LE(parts.length, 4); h.writeUInt32LE(12 + data.length, 8); fs.writeSync(output, h); fs.writeSync(output, data); count++; };
  while (remaining) {
    const got = fs.readSync(input, chunk, 0, block, pos); if (got !== block) fail(`short rootfs read at ${pos}`);
    let zero = true; for (const byte of chunk) if (byte) { zero = false; break; }
    if (zero) { if (raw.length) { emitRaw(raw); raw = []; } zeros++; }
    else { if (zeros) { emitDontCare(zeros); zeros = 0; } raw.push(Buffer.from(chunk)); if (raw.length >= 500) { emitRaw(raw); raw = []; } }
    pos += block; remaining -= block;
  }
  if (raw.length) emitRaw(raw); if (zeros) emitDontCare(zeros);
  const patch = Buffer.alloc(4); patch.writeUInt32LE(count); fs.writeSync(output, patch, 0, 4, 20);
  fs.closeSync(input); fs.closeSync(output); return { size: fs.statSync(outputPath).size, blocks: length / block, chunks: count };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , command, ...args] = process.argv;
  if (command === 'boot' && args.length === 5) console.log(JSON.stringify(makeBoot(...args)));
  else if (command === 'sparse' && args.length === 3) console.log(JSON.stringify(makeSparse(args[0], args[1], Number(args[2]))));
  else if (command === 'select-kernel' && args.length > 0) console.log(selectKernelPath(args));
  else if (command === 'select-dtb' && args.length > 0) console.log(selectDeviceTreePath(args.slice(1), args[0]));
  else if (command === 'select-initrd' && args.length > 0) console.log(selectInitrdPath(args));
  else if (command === 'prepare-kernel' && args.length === 2) console.log(JSON.stringify(prepareBootKernel(...args)));
  else if (command === 'command-line' && args.length === 2) console.log(createBootCommandLine(Number(args[0]), args[1]));
  else if (command === 'standalone-dtb' && args.length === 3) console.log(JSON.stringify(writeStandaloneDtb(...args)));
  else if (command === 'check-standalone-dtb' && args.length === 1) console.log(JSON.stringify(validateStandaloneDtb(args[0])));
  else if (command === 'check-boot-second' && args.length === 1) console.log(JSON.stringify(validateBootSecondDtb(...args)));
  else if (command === 'check-dtb-pair' && args.length === 2) console.log(JSON.stringify(validateDtbPair(...args)));
  else if (command === 'extract-boot-second' && args.length === 2) console.log(JSON.stringify(
    extractBootSecondDtb(...args),
  ));
  else if (command === 'check-stock-boot' && (args.length === 1 || args.length === 2)) console.log(JSON.stringify(validateStockBoot(...args)));
  else if (command === 'sparse-ext4-uuid' && args.length === 1) console.log(readSparseExt4Uuid(args[0]));
  else if (command === 'check-sparse-capacity' && args.length === 4) console.log(JSON.stringify(
    validateSparseCapacity(args[0], Number(args[1]), Number(args[2]), Number(args[3])),
  ));
  else if (command === 'report' && args.length === 5) console.log(JSON.stringify(await buildBurnReport({
    burnPath: args[0], rawSourcePath: args[1], emmcBootContractPath: args[2],
    mainlineFipContractPath: args[3], rootfsContractPath: args[4],
  })));
  else if (command === 'check-report' && args.length === 6) console.log(JSON.stringify(await validateBurnReport({
    reportPath: args[0], burnPath: args[1], rawSourcePath: args[2],
    emmcBootContractPath: args[3], mainlineFipContractPath: args[4],
    rootfsContractPath: args[5],
  })));
  else if (command === 'embed-dos-mbr' && args.length === 3) console.log(JSON.stringify(
    embedDosMbr(args[0], Number(args[1]), Number(args[2])),
  ));
  else if (command === 'check-dos-mbr' && args.length === 1) console.log(JSON.stringify(
    inspectDosMbr(args[0]),
  ));
  else if (command === 'reseal-bl2' && args.length === 1) console.log(resealBl2(args[0]));
  else if (command === 'check-bl2-seal' && args.length === 1) console.log(verifyBl2Seal(args[0]));
  else if (command === 'check-fat-boot' && args.length === 1) console.log(JSON.stringify(
    inspectFatBootImage(args[0]),
  ));
  else if (command === 'check-emmc-chain' && args.length === 3) console.log(JSON.stringify(
    validateEmmcBootChain(...args),
  ));
  else if (command === 'check-burn-partitions' && args.length === 1) console.log(JSON.stringify(
    inspectBurnPackagePartitions(args[0]),
  ));
  else if (command === 'check-burn-dtb-roles' && args.length === 2) console.log(JSON.stringify(
    validateBurnDtbRoles(...args),
  ));
  else if (command === 'replace-linux-target-dtb' && args.length === 3) console.log(JSON.stringify(
    replaceLinuxTargetDtb(...args),
  ));
  else if (command === 'hybrid-dtb' && args.length === 3) console.log(JSON.stringify(
    replaceLinuxTargetDtb(...args),
  ));
  else if (command === 'check-boot-size' && args.length === 1) console.log(assertBootPartitionSize(fs.statSync(args[0]).size));
  else if (command === 'check-extlinux-rootfs' && args.length === 3) console.log(JSON.stringify(
    validateRootfsExtlinux(...args),
  ));
  else if (command === 'embed-rootfs-mbr' && args.length === 2) console.log(JSON.stringify(
    embedRootfsMbr(args[0], Number(args[1])),
  ));
  else if (command === 'check-rootfs-mbr' && args.length === 1) console.log(JSON.stringify(
    inspectRootfsMbr(args[0]),
  ));
  else if (command === 'check-ophub-partitions' && args.length === 1) console.log(JSON.stringify(
    inspectOphubPackage(args[0]),
  ));
  else if (command === 'check-ophub-chain' && args.length === 4) console.log(JSON.stringify(
    validateOphubBootChain(...args), null, 2,
  ));
  else fail('usage: burn-image.mjs reseal-bl2 bootloader | check-bl2-seal bootloader | check-extlinux-rootfs conf root-uuid board-dtb | embed-rootfs-mbr bootloader root-bytes | check-rootfs-mbr bootloader | check-ophub-partitions package-dir | check-ophub-chain bootloader sparse-root components-dir raw-bl33 | embed-dos-mbr bootloader fat-bytes root-bytes | check-emmc-chain bootloader fat sparse-root | check-burn-partitions package-dir | check-burn-dtb-roles vendor-dtb linux-dtb | check-dos-mbr bootloader | check-fat-boot fat | boot kernel initrd dtb output cmdline | command-line memory-limit-mib root-uuid | standalone-dtb input overlay output | check-stock-boot boot [root-uuid] | check-dtb-pair boot dtb | check-boot-second boot | check-standalone-dtb dtb | sparse-ext4-uuid sparse | check-sparse-capacity sparse storage-bytes data-offset-mib safety-bytes | report burn raw emmc-boot-contract mainline-fip-contract rootfs-contract | check-report report burn raw emmc-boot-contract mainline-fip-contract rootfs-contract | sparse input output length | select-kernel paths... | prepare-kernel input output | check-boot-size image');
}
