import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as chain from '../src/ophub-boot-chain.mjs';

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
  const inspected = chain.embedRootfsMbr(filePath, ROOT_BYTES);
  assert.equal(inspected.partitions.length, 1);
  assert.deepEqual(inspected.partitions[0], {
    index: 1,
    bootable: true,
    type: 0x83,
    startLba: (2176 * MIB) / SECTOR,
    sectors: ROOT_BYTES / SECTOR,
  });
  const sector = fs.readFileSync(filePath).subarray(0, SECTOR);
  assert.ok(sector.subarray(0, 446).every((byte) => byte === 0xa5), 'BL2 header must survive');
  assert.equal(sector.readUInt16LE(510), 0xaa55);
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
