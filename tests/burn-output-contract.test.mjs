import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import * as burnImage from '../scripts/burn-image.mjs';

const ROOT_UUID = '50031852-ee90-4285-ada7-ab9dc14670c9';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-burn-contract-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function arm64Image() {
  const config = [
    'CONFIG_BLK_CMDLINE_PARSER=y',
    'CONFIG_BLK_DEV_INITRD=y',
    'CONFIG_CMDLINE_PARTITION=y',
    'CONFIG_DEVTMPFS=y',
    'CONFIG_DEVTMPFS_MOUNT=y',
    'CONFIG_DRM_DW_HDMI=y',
    'CONFIG_DRM_MESON=y',
    'CONFIG_DRM_MESON_DW_HDMI=y',
    'CONFIG_DWMAC_MESON=y',
    'CONFIG_EXT4_FS=y',
    'CONFIG_IKCONFIG=y',
    'CONFIG_MESON_GXL_PHY=y',
    'CONFIG_MMC_BLOCK=y',
    'CONFIG_MMC_MESON_GX=y',
    'CONFIG_PHY_MESON_GXL_USB2=y',
    'CONFIG_RD_GZIP=y',
    'CONFIG_STMMAC_ETH=y',
  ].join('\n') + '\n';
  const embedded = Buffer.concat([
    Buffer.from('IKCFG_ST'), gzipSync(Buffer.from(config)), Buffer.from('IKCFG_ED'),
  ]);
  const image = Buffer.alloc(4096, 0x5a);
  image.fill(0, 0, 64);
  image.writeBigUInt64LE(0x01080000n, 8);
  image.writeBigUInt64LE(BigInt(image.length), 16);
  image.write('ARMd', 56, 'ascii');
  embedded.copy(image, 256);
  return image;
}

function plainFdt(marker = 0x5a) {
  const dtb = Buffer.alloc(64, marker);
  dtb.writeUInt32BE(0xd00dfeed, 0);
  dtb.writeUInt32BE(dtb.length, 4);
  return dtb;
}

function createBoot(directory, cmdline, dtbBytes = plainFdt()) {
  const kernel = path.join(directory, 'Image.gz');
  const initrd = path.join(directory, 'initrd.img');
  const dtb = path.join(directory, 'meson1.dtb');
  const boot = path.join(directory, 'boot.PARTITION');
  fs.writeFileSync(kernel, gzipSync(arm64Image()));
  fs.writeFileSync(initrd, Buffer.alloc(0));
  fs.writeFileSync(dtb, dtbBytes);
  burnImage.makeBoot(kernel, initrd, dtb, boot, cmdline);
  return { boot, dtb };
}

test('burn output binds boot second to the exact standalone DTB', (context) => {
  const directory = fixture(context);
  const { boot, dtb } = createBoot(directory, `root=UUID=${ROOT_UUID}`);

  assert.equal(typeof burnImage.validateDtbPair, 'function');
  assert.deepEqual(burnImage.validateDtbPair(boot, dtb), { size: 64, fdtSize: 64 });

  fs.writeFileSync(dtb, plainFdt(0x33));
  assert.throws(
    () => burnImage.validateDtbPair(boot, dtb),
    /boot second and meson1\.dtb differ/,
  );
});

test('burn output can export the boot second FDT for independent package validation', (context) => {
  const directory = fixture(context);
  const { boot, dtb } = createBoot(directory, `root=UUID=${ROOT_UUID}`);
  const extracted = path.join(directory, 'boot-second.dtb');
  burnImage.extractBootSecondDtb(boot, extracted);
  assert.deepEqual(fs.readFileSync(extracted), fs.readFileSync(dtb));
});

test('stock boot validation binds bootargs to the copied ext4 UUID', (context) => {
  const directory = fixture(context);
  const { boot } = createBoot(directory, `root=UUID=${ROOT_UUID} rw`);

  assert.equal(burnImage.validateStockBoot(boot, ROOT_UUID).rootUuid, ROOT_UUID);
  assert.throws(
    () => burnImage.validateStockBoot(boot, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    /root filesystem UUID differs/,
  );
});

test('sparse rootfs inspection reads the ext4 UUID without expanding the image', (context) => {
  const directory = fixture(context);
  const raw = path.join(directory, 'rootfs.ext4');
  const sparse = path.join(directory, 'data.PARTITION');
  const image = Buffer.alloc(4096);
  image.writeUInt16LE(0xef53, 1024 + 0x38);
  Buffer.from(ROOT_UUID.replaceAll('-', ''), 'hex').copy(image, 1024 + 0x68);
  fs.writeFileSync(raw, image);
  burnImage.makeSparse(raw, sparse, image.length);

  assert.equal(typeof burnImage.readSparseExt4Uuid, 'function');
  assert.equal(burnImage.readSparseExt4Uuid(sparse), ROOT_UUID);
});
