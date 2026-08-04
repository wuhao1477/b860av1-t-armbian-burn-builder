#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';

function fail(message) { throw new Error(message); }
function u32(buffer, offset, value) { buffer.writeUInt32LE(value >>> 0, offset); }

export function makeBoot(kernelPath, ramdiskPath, dtbPath, outputPath, cmdline) {
  const page = 2048;
  const kernel = fs.readFileSync(kernelPath);
  const ramdisk = fs.readFileSync(ramdiskPath);
  const dtb = fs.readFileSync(dtbPath);
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
  else fail('usage: burn-image.mjs boot kernel initrd dtb output cmdline | sparse input output length');
}
