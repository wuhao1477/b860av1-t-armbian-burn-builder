import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { makeSparse } from '../scripts/burn-image.mjs';
import * as chain from '../src/emmc-boot-chain.mjs';

const MIB = 1024 * 1024;
const ROOT_UUID = '50031852-ee90-4285-ada7-ab9dc14670c9';
const DTB_PATH = '/dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-emmc-chain-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function copyToFat(image, directory, destination, contents) {
  const source = path.join(directory, destination.replaceAll('/', '_'));
  fs.writeFileSync(source, contents);
  childProcess.execFileSync('mcopy', ['-o', '-i', image, source, `::${destination}`]);
}

function writeFatFixture(filePath, directory, rootUuid = ROOT_UUID) {
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 32 * MIB);
  childProcess.execFileSync(
    'mformat', ['-i', filePath, '-N', '00000000', '-v', 'BOOT', '::'],
    { stdio: 'ignore' },
  );
  childProcess.execFileSync(
    'mmd', ['-i', filePath, '::extlinux', '::dtb', '::dtb/amlogic'],
    { stdio: 'ignore' },
  );

  const kernel = Buffer.alloc(64);
  kernel.write('ARMd', 56, 'ascii');
  const dtb = Buffer.alloc(128);
  dtb.writeUInt32BE(0xd00dfeed, 0);
  dtb.writeUInt32BE(dtb.length, 4);
  const config = [
    'TIMEOUT 30',
    'DEFAULT armbian',
    '',
    'LABEL armbian',
    '  LINUX /Image.gz',
    '  INITRD /initrd.img',
    `  FDT ${DTB_PATH}`,
    `  APPEND root=UUID=${rootUuid} rw rootwait rootfstype=ext4 mem=1024M console=ttyAML0,115200n8 console=tty0 net.ifnames=0`,
    '',
  ].join('\n');
  copyToFat(filePath, directory, 'Image.gz', gzipSync(kernel));
  copyToFat(filePath, directory, 'initrd.img', gzipSync(Buffer.from('initramfs')));
  copyToFat(filePath, directory, 'dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb', dtb);
  copyToFat(filePath, directory, 'extlinux/extlinux.conf', config);
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

test('DOS MBR maps a 32 MiB FAT16 boot filesystem at the vendor boot offset', (context) => {
  const directory = fixture(context);
  const output = path.join(directory, '1.PARTITION');

  chain.writeDosMbr(output, 32 * MIB, 8 * MIB);

  assert.deepEqual(chain.inspectDosMbr(output).partitions, [
    { index: 1, bootable: false, type: 0x0e, startLba: 2_260_992, sectors: 65_536 },
    { index: 2, bootable: false, type: 0x83, startLba: 4_456_448, sectors: 16_384 },
  ]);
});

test('FAT boot inspection validates extlinux files in the fixed 32 MiB image', (context) => {
  const directory = fixture(context);
  const fat = path.join(directory, 'boot.PARTITION');
  writeFatFixture(fat, directory);

  const geometry = chain.inspectFatBootImage(fat);
  assert.equal(geometry.size, 32 * MIB);
  assert.equal(geometry.type, 'FAT16');
  assert.deepEqual(chain.inspectFatBootFiles(fat).map(({ path: file }) => file), [
    'extlinux/extlinux.conf',
    '/Image.gz',
    '/initrd.img',
    DTB_PATH,
  ]);
});

test('eMMC boot contract binds MBR, extlinux and sparse rootfs by UUID', (context) => {
  const directory = fixture(context);
  const mbr = path.join(directory, '1.PARTITION');
  const fat = path.join(directory, 'boot.PARTITION');
  const rootfs = writeSparseRoot(directory);
  writeFatFixture(fat, directory);
  chain.writeDosMbr(mbr, 32 * MIB, 8 * MIB);

  assert.equal(typeof chain.validateEmmcBootChain, 'function');
  const result = chain.validateEmmcBootChain(mbr, fat, rootfs);
  assert.equal(result.strategy, 'vendor-fip-mainline-bl33-extlinux');
  assert.equal(result.rootUuid, ROOT_UUID);
  assert.equal(result.fat.startMiB, 1104);
  assert.equal(result.rootfs.startMiB, 2176);
});

test('eMMC boot contract rejects an extlinux root UUID not present in data.PARTITION', (context) => {
  const directory = fixture(context);
  const mbr = path.join(directory, '1.PARTITION');
  const fat = path.join(directory, 'boot.PARTITION');
  const rootfs = writeSparseRoot(directory);
  writeFatFixture(fat, directory, '11111111-2222-3333-4444-555555555555');
  chain.writeDosMbr(mbr, 32 * MIB, 8 * MIB);

  assert.throws(
    () => chain.validateEmmcBootChain(mbr, fat, rootfs),
    /extlinux root filesystem UUID differs/,
  );
});

test('factory package contains only MBR, FIP, FAT boot and sparse root payloads', (context) => {
  const directory = fixture(context);
  const packageDirectory = path.join(directory, 'package');
  fs.mkdirSync(packageDirectory);
  for (const name of [
    '1.PARTITION',
    'bootloader.PARTITION',
    'boot.PARTITION',
    'data.PARTITION',
  ]) fs.writeFileSync(path.join(packageDirectory, name), name);

  assert.deepEqual(chain.inspectBurnPackagePartitions(packageDirectory), {
    partitions: [
      '1.PARTITION',
      'bootloader.PARTITION',
      'boot.PARTITION',
      'data.PARTITION',
    ],
  });

  fs.writeFileSync(path.join(packageDirectory, 'env.PARTITION'), 'vendor environment');
  assert.throws(
    () => chain.inspectBurnPackagePartitions(packageDirectory),
    /unexpected partition payload: env\.PARTITION/,
  );
});
