import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeSparse } from '../scripts/burn-image.mjs';
import * as chain from '../src/emmc-boot-chain.mjs';

const MIB = 1024 * 1024;
const ROOT_UUID = '50031852-ee90-4285-ada7-ab9dc14670c9';
const CLI = fileURLToPath(new URL('../scripts/burn-image.mjs', import.meta.url));

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-emmc-chain-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFit(directory, bytes = 4096, declaredBytes = 3072) {
  const fit = path.join(directory, 'boot.PARTITION');
  const image = Buffer.alloc(bytes);
  image.writeUInt32BE(0xd00dfeed, 0);
  image.writeUInt32BE(declaredBytes, 4);
  fs.writeFileSync(fit, image);
  return fit;
}

function writeSparseRoot(directory) {
  const raw = path.join(directory, 'rootfs.ext4');
  const sparse = path.join(directory, 'data.PARTITION');
  const image = Buffer.alloc(8 * MIB);
  image.writeUInt16LE(0xef53, 1024 + 0x38);
  Buffer.from(ROOT_UUID.replaceAll('-', ''), 'hex').copy(image, 1024 + 0x68);
  fs.writeFileSync(raw, image);
  makeSparse(raw, sparse, image.length);
  return sparse;
}

function bootContract(fitSectors = 8) {
  return {
    fitLoadAddress: '0x08000000',
    fitSectors,
    fitStartLba: 2_260_992,
    rootUuid: ROOT_UUID,
  };
}

test('raw FIT inspection enforces the named boot partition geometry', (context) => {
  const fit = writeFit(fixture(context));

  assert.deepEqual(chain.inspectRawFitImage(fit), {
    declaredBytes: 3072,
    sectors: 8,
    size: 4096,
    startLba: 2_260_992,
    startMiB: 1104,
  });
});

test('raw FIT inspection rejects payloads that cannot be written in whole sectors', (context) => {
  const fit = writeFit(fixture(context), 4097, 3072);

  assert.throws(() => chain.inspectRawFitImage(fit), /sector-aligned/);
});

test('eMMC boot contract binds FIT sectors and root UUID to fixed U-Boot', (context) => {
  const directory = fixture(context);
  const fit = writeFit(directory);
  const rootfs = writeSparseRoot(directory);

  const result = chain.validateEmmcBootChain(fit, rootfs, bootContract());
  assert.equal(result.strategy, 'vendor-fip-mainline-bl33-fit');
  assert.equal(result.rootUuid, ROOT_UUID);
  assert.equal(result.fit.sectors, 8);
  assert.equal(result.fit.startMiB, 1104);
  assert.equal(result.rootfs.startMiB, 2176);
});

test('eMMC boot contract rejects a fixed U-Boot FIT sector mismatch', (context) => {
  const directory = fixture(context);
  const fit = writeFit(directory);
  const rootfs = writeSparseRoot(directory);

  assert.throws(
    () => chain.validateEmmcBootChain(fit, rootfs, bootContract(7)),
    /FIT sector count differs/,
  );
});

test('burn image CLI validates FIT, sparse rootfs and U-Boot evidence together', (context) => {
  const directory = fixture(context);
  const fit = writeFit(directory);
  const rootfs = writeSparseRoot(directory);
  const evidence = path.join(directory, 'mainline-fip-contract.json');
  fs.writeFileSync(evidence, JSON.stringify({ uboot: bootContract() }));

  const result = childProcess.spawnSync(process.execPath, [
    CLI, 'check-emmc-chain', fit, rootfs, evidence,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).fit.sectors, 8);
});

test('factory package contains only named FIP, FIT and sparse root payloads', (context) => {
  const directory = fixture(context);
  const packageDirectory = path.join(directory, 'package');
  fs.mkdirSync(packageDirectory);
  for (const name of [
    'bootloader.PARTITION',
    'boot.PARTITION',
    'data.PARTITION',
  ]) fs.writeFileSync(path.join(packageDirectory, name), name);

  assert.deepEqual(chain.inspectBurnPackagePartitions(packageDirectory), {
    partitions: [
      'bootloader.PARTITION',
      'boot.PARTITION',
      'data.PARTITION',
    ],
  });

  fs.writeFileSync(path.join(packageDirectory, '1.PARTITION'), 'invalid target');
  assert.throws(
    () => chain.inspectBurnPackagePartitions(packageDirectory),
    /unexpected partition payload: 1\.PARTITION/,
  );
});
