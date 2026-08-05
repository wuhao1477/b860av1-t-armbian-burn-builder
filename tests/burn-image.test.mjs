import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

import * as burnImage from '../scripts/burn-image.mjs';

const cli = fileURLToPath(new URL('../scripts/burn-image.mjs', import.meta.url));

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-burn-image-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('P212 multi-DTB matches the stock U-Boot v2 selection format', () => {
  const dtb = Buffer.alloc(64, 0x5a);
  dtb.writeUInt32BE(0xd00dfeed, 0);
  dtb.writeUInt32BE(dtb.length, 4);

  assert.equal(
    typeof burnImage.createP212MultiDtb,
    'function',
    'missing P212 multi-DTB generator',
  );
  const image = burnImage.createP212MultiDtb(dtb);

  assert.equal(image.toString('ascii', 0, 4), 'AML_');
  assert.equal(image.readUInt32LE(4), 2);
  assert.equal(image.readUInt32LE(8), 2);
  assert.equal(image.subarray(12, 28).toString('hex'), '206c7867202020202020202020202020');
  assert.equal(image.subarray(28, 44).toString('hex'), '32313270202020202020202020202020');
  assert.equal(image.subarray(44, 60).toString('hex'), '20206731202020202020202020202020');
  assert.equal(image.readUInt32LE(60), 2048);
  assert.equal(image.readUInt32LE(64), 2048);
  assert.equal(image.readUInt32LE(116), 4096);
  assert.equal(image.readUInt32LE(120), 2048);
  assert.equal(image.length, 6144);
  assert.deepEqual(image.subarray(2048, 2048 + dtb.length), dtb);
  assert.deepEqual(image.subarray(4096, 4096 + dtb.length), dtb);
});

test('multi-DTB CLI creates the standalone meson1 payload', (context) => {
  const directory = fixture(context);
  const input = path.join(directory, 'board.dtb');
  const output = path.join(directory, 'meson1.dtb');
  const dtb = Buffer.alloc(64, 0x5a);
  dtb.writeUInt32BE(0xd00dfeed, 0);
  dtb.writeUInt32BE(dtb.length, 4);
  fs.writeFileSync(input, dtb);

  const result = childProcess.spawnSync(process.execPath, [cli, 'multi-dtb', input, output], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const image = fs.readFileSync(output);
  assert.equal(image.length, 6144);
  assert.equal(image.toString('ascii', 0, 4), 'AML_');
  assert.equal(image.readUInt32LE(4), 2);
  assert.equal(image.readUInt32LE(8), 2);
});

test('kernel selection prefers Image.gz over an uncompressed Image', (context) => {
  const directory = fixture(context);
  const image = path.join(directory, 'Image');
  const imageGz = path.join(directory, 'Image.gz');
  fs.writeFileSync(image, 'uncompressed');
  fs.writeFileSync(imageGz, 'compressed');

  assert.equal(
    typeof burnImage.selectKernelPath,
    'function',
    'missing compressed-kernel selector',
  );
  assert.equal(burnImage.selectKernelPath([image, imageGz]), imageGz);
});

test('boot kernel preparation compresses an uncompressed ARM64 Image', (context) => {
  const directory = fixture(context);
  const input = path.join(directory, 'zImage');
  const output = path.join(directory, 'kernel.gz');
  const contents = Buffer.alloc(1024 * 1024, 0x5a);
  fs.writeFileSync(input, contents);

  assert.equal(
    typeof burnImage.prepareBootKernel,
    'function',
    'missing boot-kernel compression',
  );
  const result = burnImage.prepareBootKernel(input, output);

  assert.equal(result.compressed, true);
  assert.deepEqual(gunzipSync(fs.readFileSync(output)), contents);
  assert.ok(result.size < contents.length);
});

test('boot kernel preparation preserves an existing gzip stream', (context) => {
  const directory = fixture(context);
  const input = path.join(directory, 'Image.gz');
  const output = path.join(directory, 'kernel.gz');
  const compressed = gzipSync(Buffer.from('existing kernel stream'));
  fs.writeFileSync(input, compressed);

  const result = burnImage.prepareBootKernel(input, output);

  assert.equal(result.compressed, false);
  assert.equal(result.size, compressed.length);
  assert.deepEqual(fs.readFileSync(output), compressed);
});

test('boot image exposes the Linux DTB through both stock P212 selectors', (context) => {
  const directory = fixture(context);
  const kernel = path.join(directory, 'Image.gz');
  const ramdisk = path.join(directory, 'initrd');
  const dtb = path.join(directory, 'board.dtb');
  const output = path.join(directory, 'boot.PARTITION');
  const dtbBytes = Buffer.alloc(64, 0x5a);
  dtbBytes.writeUInt32BE(0xd00dfeed, 0);
  dtbBytes.writeUInt32BE(dtbBytes.length, 4);
  fs.writeFileSync(kernel, Buffer.alloc(3000, 0x11));
  fs.writeFileSync(ramdisk, Buffer.alloc(1000, 0x22));
  fs.writeFileSync(dtb, dtbBytes);

  const result = burnImage.makeBoot(kernel, ramdisk, dtb, output, 'root=LABEL=ROOTFS');
  const image = fs.readFileSync(output);
  const secondOffset = 2048 + 4096 + 2048;
  const second = image.subarray(secondOffset, secondOffset + result.dtb);

  assert.equal(result.dtb, 6144);
  assert.equal(image.readUInt32LE(24), 6144);
  assert.equal(second.toString('ascii', 0, 4), 'AML_');
  assert.equal(second.readUInt32LE(8), 2);
  assert.deepEqual(second.subarray(2048, 2048 + dtbBytes.length), dtbBytes);
  assert.deepEqual(second.subarray(4096, 4096 + dtbBytes.length), dtbBytes);
});

test('burn DTB validation checks the Linux multi-DTB in boot second independently', (context) => {
  const directory = fixture(context);
  const kernel = path.join(directory, 'Image.gz');
  const ramdisk = path.join(directory, 'initrd');
  const dtb = path.join(directory, 'board.dtb');
  const boot = path.join(directory, 'boot.PARTITION');
  const dtbBytes = Buffer.alloc(64, 0x5a);
  dtbBytes.writeUInt32BE(0xd00dfeed, 0);
  dtbBytes.writeUInt32BE(dtbBytes.length, 4);
  fs.writeFileSync(kernel, Buffer.alloc(3000, 0x11));
  fs.writeFileSync(ramdisk, Buffer.alloc(1000, 0x22));
  fs.writeFileSync(dtb, dtbBytes);
  burnImage.makeBoot(kernel, ramdisk, dtb, boot, 'root=LABEL=ROOTFS');

  assert.equal(
    typeof burnImage.validateP212Boot,
    'function',
    'missing boot second DTB validator',
  );
  assert.deepEqual(burnImage.validateP212Boot(boot), {
    size: 6144,
    targets: ['gxl_p212_1g', 'gxl_p212_2g'],
    fdtSize: 64,
  });
});

test('boot image creation rejects payloads larger than the stock 32 MiB partition', (context) => {
  const directory = fixture(context);
  const kernel = path.join(directory, 'Image');
  const ramdisk = path.join(directory, 'initrd');
  const dtb = path.join(directory, 'board.dtb');
  const output = path.join(directory, 'boot.PARTITION');
  fs.writeFileSync(kernel, Buffer.alloc(16 * 1024 * 1024));
  fs.writeFileSync(ramdisk, Buffer.alloc(16 * 1024 * 1024));
  const dtbBytes = Buffer.alloc(8);
  dtbBytes.writeUInt32BE(0xd00dfeed, 0);
  dtbBytes.writeUInt32BE(dtbBytes.length, 4);
  fs.writeFileSync(dtb, dtbBytes);

  assert.throws(
    () => burnImage.makeBoot(kernel, ramdisk, dtb, output, 'root=LABEL=ROOTFS'),
    /exceeds the stock 33554432-byte boot partition/,
  );
  assert.equal(fs.existsSync(output), false);
});

test('boot size CLI rejects an existing image larger than the stock partition', (context) => {
  const directory = fixture(context);
  const image = path.join(directory, 'boot.PARTITION');
  fs.writeFileSync(image, Buffer.alloc(1));
  fs.truncateSync(image, (32 * 1024 * 1024) + 1);

  const result = childProcess.spawnSync(
    process.execPath,
    [cli, 'check-boot-size', image],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exceeds the stock 33554432-byte boot partition/);
});
