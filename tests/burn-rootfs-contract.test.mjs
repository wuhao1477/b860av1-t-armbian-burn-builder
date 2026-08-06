import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as burnImage from '../scripts/burn-image.mjs';

const cli = fileURLToPath(new URL('../scripts/burn-image.mjs', import.meta.url));

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-rootfs-contract-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('sparse rootfs validation reports its logical fit in the data partition', (context) => {
  const directory = fixture(context);
  const rootfs = path.join(directory, 'rootfs.ext4');
  const sparse = path.join(directory, 'data.PARTITION');
  const contents = Buffer.alloc(32_768);
  contents.writeUInt32LE(0xef53, 4096);
  fs.writeFileSync(rootfs, contents);
  burnImage.makeSparse(rootfs, sparse, contents.length);

  assert.equal(typeof burnImage.validateSparseCapacity, 'function');
  assert.deepEqual(
    burnImage.validateSparseCapacity(sparse, 8_000_000_000, 2176, 134_217_728),
    {
      availableBytes: 5_584_080_896,
      blockSize: 4096,
      dataOffsetBytes: 2_281_701_376,
      logicalBytes: 32_768,
      remainingBytes: 5_584_048_128,
      safetyMarginBytes: 134_217_728,
      storageCapacityBytes: 8_000_000_000,
      totalBlocks: 8,
      totalChunks: 3,
    },
  );
});

test('sparse rootfs validation rejects a logical image larger than data', (context) => {
  const directory = fixture(context);
  const rootfs = path.join(directory, 'rootfs.ext4');
  const sparse = path.join(directory, 'data.PARTITION');
  fs.writeFileSync(rootfs, Buffer.alloc(8192, 0x5a));
  burnImage.makeSparse(rootfs, sparse, 8192);

  assert.throws(
    () => burnImage.validateSparseCapacity(sparse, 12_288, 0, 8192),
    /logical size 8192 exceeds 4096 available bytes/,
  );
});

test('sparse capacity CLI emits machine-readable validation evidence', (context) => {
  const directory = fixture(context);
  const rootfs = path.join(directory, 'rootfs.ext4');
  const sparse = path.join(directory, 'data.PARTITION');
  fs.writeFileSync(rootfs, Buffer.alloc(8192, 0x5a));
  burnImage.makeSparse(rootfs, sparse, 8192);

  const result = childProcess.spawnSync(
    process.execPath,
    [cli, 'check-sparse-capacity', sparse, '8000000000', '2176', '134217728'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).logicalBytes, 8192);
});
