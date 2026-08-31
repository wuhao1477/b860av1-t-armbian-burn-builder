import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as chain from '../src/ophub-boot-chain.mjs';
import { bl2SelfDigest, verifyBl2Seal } from '../src/emmc-boot-chain.mjs';

const MIB = 1024 * 1024;
const SECTOR = 512;
const ROOT_UUID = '3e900a5c-42af-4f1f-a78e-e4a8efad2459';
const BOARD_DTB = 'meson-gxl-s905x-p212-b860av11t.dtb';
const ROOT_BYTES = 3145728000;

function scratch(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-ophub-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function stubFip(directory) {
  const filePath = path.join(directory, 'bootloader.PARTITION');
  const image = Buffer.alloc(4 * MIB);
  image.fill(0xa5, 0, 446);
  // 自洽的 BL2 摘要头：hash_start=0x60、hash_size=0xbf90，同原厂 bl2.sign。
  image.writeUInt32LE(0x60, 0x2c);
  image.writeUInt32LE(0xbf90, 0x3c);
  bl2SelfDigest(image).copy(image, 0x50);
  fs.writeFileSync(filePath, image);
  return filePath;
}

function writeConfig(directory, overrides = {}) {
  const values = {
    KERNEL: '/boot/zImage',
    INITRD: '/boot/uInitrd',
    FDT: `/boot/dtb/amlogic/${BOARD_DTB}`,
    APPEND: `root=UUID=${ROOT_UUID} rw rootwait rootfstype=ext4 console=tty0 mem=1024M`,
    ...overrides,
  };
  const filePath = path.join(directory, 'extlinux.conf');
  fs.writeFileSync(filePath, [
    'TIMEOUT 10',
    'DEFAULT Armbian',
    '',
    'LABEL Armbian',
    ...Object.entries(values).map(([key, value]) => `    ${key} ${value}`),
    '',
  ].join('\n'));
  return filePath;
}

test('embeds one bootable ext4 partition at the data offset and keeps BL2 intact', (context) => {
  const directory = scratch(context);
  const filePath = stubFip(directory);
  const before = fs.readFileSync(filePath);
  const inspected = chain.embedRootfsMbr(filePath, ROOT_BYTES);
  assert.equal(inspected.partitions.length, 1);
  assert.deepEqual(inspected.partitions[0], {
    index: 1,
    bootable: true,
    type: 0x83,
    startLba: (2176 * MIB) / SECTOR,
    sectors: ROOT_BYTES / SECTOR,
  });
  const after = fs.readFileSync(filePath);
  // 只有 66 字节 MBR 和 0x50 的自摘要变了；其余 BL2 头逐字节保留。
  assert.deepEqual(after.subarray(0, 0x50), before.subarray(0, 0x50));
  assert.deepEqual(after.subarray(0x70, 446), before.subarray(0x70, 446));
  assert.equal(after.readUInt16LE(510), 0xaa55);
  // 摘要必须重算，否则 bootrom 拒绝执行 BL2（两次实刷都是整机全黑）。
  assert.equal(verifyBl2Seal(filePath), after.subarray(0x50, 0x70).toString('hex'));
  assert.notDeepEqual(after.subarray(0x50, 0x70), before.subarray(0x50, 0x70));
  assert.deepEqual(chain.inspectRootfsMbr(filePath), inspected);
});

test('refuses to overwrite a sector 0 that already carries a partition table', (context) => {
  const filePath = stubFip(scratch(context));
  chain.embedRootfsMbr(filePath, ROOT_BYTES);
  assert.throws(() => chain.embedRootfsMbr(filePath, ROOT_BYTES), /already uses the MBR table area/u);
});

test('accepts a /boot-prefixed extlinux.conf that matches data.PARTITION', (context) => {
  const filePath = writeConfig(scratch(context));
  const parsed = chain.validateRootfsExtlinux(filePath, ROOT_UUID.toUpperCase(), BOARD_DTB);
  assert.equal(parsed.kernel, '/boot/zImage');
  assert.equal(parsed.rootUuid, ROOT_UUID);
});

test('rejects extlinux.conf mistakes that would dead-end the boot', (context) => {
  const directory = scratch(context);
  const cases = [
    [{ KERNEL: '/zImage' }, /KERNEL must be \/boot\/zImage/u],
    [{ FDT: '/boot/dtb/amlogic/meson-gxl-s905x-p212.dtb' }, /FDT must be/u],
    [{ APPEND: `root=UUID=${ROOT_UUID} rootfstype=ext4 mem=1024M` }, /lacks console=tty0/u],
    [{ APPEND: `root=UUID=${ROOT_UUID} rootfstype=ext4 console=tty0` }, /lacks mem=1024M/u],
    [{ APPEND: 'rw rootwait rootfstype=ext4 console=tty0 mem=1024M' }, /lacks one root filesystem UUID/u],
    [{ APPEND: `root=UUID=${ROOT_UUID} rootfstype=ext4 console=tty0 mem=1024M storeboot` }, /Android boot marker/u],
  ];
  for (const [overrides, pattern] of cases) {
    const filePath = writeConfig(directory, overrides);
    assert.throws(() => chain.validateRootfsExtlinux(filePath, ROOT_UUID, BOARD_DTB), pattern);
  }
});

test('a differing root UUID is a hard failure', (context) => {
  const filePath = writeConfig(scratch(context));
  assert.throws(
    () => chain.validateRootfsExtlinux(filePath, '11111111-2222-3333-4444-555555555555', BOARD_DTB),
    /differs from data.PARTITION/u,
  );
});
