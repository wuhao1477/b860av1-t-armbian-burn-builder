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

test('boot image creation rejects payloads larger than the stock 32 MiB partition', (context) => {
  const directory = fixture(context);
  const kernel = path.join(directory, 'Image');
  const ramdisk = path.join(directory, 'initrd');
  const dtb = path.join(directory, 'board.dtb');
  const output = path.join(directory, 'boot.PARTITION');
  fs.writeFileSync(kernel, Buffer.alloc(16 * 1024 * 1024));
  fs.writeFileSync(ramdisk, Buffer.alloc(16 * 1024 * 1024));
  fs.writeFileSync(dtb, Buffer.alloc(1));

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
