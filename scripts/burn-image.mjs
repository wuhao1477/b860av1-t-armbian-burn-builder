#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';

const BOOT_PARTITION_BYTES = 32 * 1024 * 1024;
const AML_DTB_PAGE_BYTES = 2048;
const P212_DTB_TARGETS = ['gxl_p212_1g', 'gxl_p212_2g'];
const BURN_PARTITION_ARGUMENT = 'blkdevparts=mmcblk2:4M@0(bootloader),64M@36M(reserved),768M@108M(cache),8M@884M(env),4M@900M(conf),32M@912M(logo),32M@952M(recovery),8M@992M(rsv),8M@1008M(tee),32M@1024M(crypt),32M@1064M(misc),32M@1104M(boot),1024M@1144M(system),-@2176M(data)';

function fail(message) { throw new Error(message); }
function u32(buffer, offset, value) { buffer.writeUInt32LE(value >>> 0, offset); }

function align(value, boundary) {
  return Math.ceil(value / boundary) * boundary;
}

function encodeAmlogicDtbProperty(value) {
  if (!/^[a-z0-9]+$/.test(value) || value.length > 16) fail(`invalid Amlogic DTB property: ${value}`);
  const plain = Buffer.alloc(16, 0x20);
  plain.write(value, 0, 'ascii');
  const encoded = Buffer.alloc(16);
  for (let offset = 0; offset < plain.length; offset += 4) {
    for (let index = 0; index < 4; index += 1) encoded[offset + index] = plain[offset + 3 - index];
  }
  return encoded;
}

export function createP212MultiDtb(dtb) {
  if (!Buffer.isBuffer(dtb) || dtb.length < 8 || dtb.readUInt32BE(0) !== 0xd00dfeed) {
    fail('input is not a flattened device tree');
  }
  const fdtSize = dtb.readUInt32BE(4);
  if (fdtSize < 8 || fdtSize > dtb.length) fail('flattened device tree size is invalid');
  const entryBytes = 56;
  const headerBytes = align(12 + (entryBytes * P212_DTB_TARGETS.length), AML_DTB_PAGE_BYTES);
  const payloadBytes = align(dtb.length, AML_DTB_PAGE_BYTES);
  const output = Buffer.alloc(headerBytes + (payloadBytes * P212_DTB_TARGETS.length));
  output.write('AML_', 0, 'ascii');
  u32(output, 4, 2);
  u32(output, 8, P212_DTB_TARGETS.length);
  P212_DTB_TARGETS.forEach((target, index) => {
    const entryOffset = 12 + (index * entryBytes);
    target.split('_').forEach((property, propertyIndex) => {
      encodeAmlogicDtbProperty(property).copy(output, entryOffset + (propertyIndex * 16));
    });
    u32(output, entryOffset + 48, headerBytes + (index * payloadBytes));
    u32(output, entryOffset + 52, payloadBytes);
    dtb.copy(output, headerBytes + (index * payloadBytes));
  });
  return output;
}

export function writeP212MultiDtb(inputPath, outputPath) {
  const output = createP212MultiDtb(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath, output);
  return { size: output.length, targets: P212_DTB_TARGETS };
}

function decodeAmlogicDtbProperty(image, offset) {
  const decoded = Buffer.alloc(16);
  for (let group = 0; group < decoded.length; group += 4) {
    for (let index = 0; index < 4; index += 1) decoded[group + index] = image[offset + group + 3 - index];
  }
  return decoded.toString('ascii').replace(/ +$/u, '');
}

export function inspectP212MultiDtb(image) {
  if (!Buffer.isBuffer(image) || image.length < AML_DTB_PAGE_BYTES
      || image.toString('ascii', 0, 4) !== 'AML_'
      || image.readUInt32LE(4) !== 2 || image.readUInt32LE(8) !== 2) {
    fail('P212 multi-DTB header is invalid');
  }
  const targets = [];
  const entries = [];
  const payloads = [];
  for (let index = 0; index < P212_DTB_TARGETS.length; index += 1) {
    const entry = 12 + (index * 56);
    const target = [0, 16, 32].map((delta) => decodeAmlogicDtbProperty(image, entry + delta)).join('_');
    const offset = image.readUInt32LE(entry + 48);
    const size = image.readUInt32LE(entry + 52);
    const expectedOffset = index === 0
      ? AML_DTB_PAGE_BYTES
      : entries[index - 1].offset + entries[index - 1].size;
    if (target !== P212_DTB_TARGETS[index] || offset !== expectedOffset
        || size === 0 || size % AML_DTB_PAGE_BYTES !== 0 || offset + size > image.length) {
      fail('P212 multi-DTB entry is invalid');
    }
    if (image.readUInt32BE(offset) !== 0xd00dfeed) fail('P212 multi-DTB payload is not an FDT');
    const fdtSize = image.readUInt32BE(offset + 4);
    if (fdtSize < 8 || fdtSize > size) fail('P212 multi-DTB FDT size is invalid');
    targets.push(target);
    entries.push({ offset, size });
    payloads.push(image.subarray(offset, offset + fdtSize));
  }
  if (entries[0].size !== entries[1].size
      || image.length !== entries[1].offset + entries[1].size
      || !payloads[0].equals(payloads[1])) fail('P212 multi-DTB payload copies differ');
  return { size: image.length, targets, fdtSize: payloads[0].length };
}

function extractBootSecond(image) {
  if (image.length < AML_DTB_PAGE_BYTES || image.toString('ascii', 0, 8) !== 'ANDROID!') {
    fail('boot partition is not Android boot v0');
  }
  const page = image.readUInt32LE(36);
  if (page !== AML_DTB_PAGE_BYTES) fail('boot partition page size is not 2048');
  const offset = page + align(image.readUInt32LE(8), page) + align(image.readUInt32LE(16), page);
  const size = image.readUInt32LE(24);
  if (size === 0 || offset + size > image.length) fail('boot partition second payload is invalid');
  return image.subarray(offset, offset + size);
}

export function validateP212Boot(bootPath) {
  const second = extractBootSecond(fs.readFileSync(bootPath));
  return inspectP212MultiDtb(second);
}

export function selectKernelPath(paths) {
  for (const name of ['Image.gz', 'zImage', 'Image']) {
    const matches = paths.filter((candidate) => basename(candidate) === name).sort();
    if (matches.length > 0) return matches[0];
  }
  fail('boot partition lacks Image.gz, zImage, or Image');
}

export function createBootCommandLine(memoryLimitMiB) {
  if (!Number.isInteger(memoryLimitMiB) || memoryLimitMiB < 256 || memoryLimitMiB > 4096) {
    fail('memory limit must be an integer from 256 to 4096 MiB');
  }
  return `${BURN_PARTITION_ARGUMENT} root=LABEL=ROOTFS rw rootwait rootfstype=ext4 mem=${memoryLimitMiB}M console=ttyAML0,115200n8 console=tty0 no_console_suspend consoleblank=0 fsck.fix=yes fsck.repair=yes net.ifnames=0 init=/sbin/init`;
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
  const dtb = createP212MultiDtb(fs.readFileSync(dtbPath));
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
  else if (command === 'prepare-kernel' && args.length === 2) console.log(JSON.stringify(prepareBootKernel(...args)));
  else if (command === 'command-line' && args.length === 1) console.log(createBootCommandLine(Number(args[0])));
  else if (command === 'multi-dtb' && args.length === 2) console.log(JSON.stringify(writeP212MultiDtb(...args)));
  else if (command === 'check-p212-boot' && args.length === 1) console.log(JSON.stringify(validateP212Boot(...args)));
  else if (command === 'check-boot-size' && args.length === 1) console.log(assertBootPartitionSize(fs.statSync(args[0]).size));
  else fail('usage: burn-image.mjs boot kernel initrd dtb output cmdline | command-line memory-limit-mib | multi-dtb input output | check-p212-boot boot | sparse input output length | select-kernel paths... | prepare-kernel input output | check-boot-size image');
}
