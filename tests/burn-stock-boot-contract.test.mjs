import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import * as burnImage from '../scripts/burn-image.mjs';

const ROOT_UUID = '50031852-ee90-4285-ada7-ab9dc14670c9';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-stock-contract-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function kernelConfig(overrides = {}) {
  const values = {
    CONFIG_BLK_CMDLINE_PARSER: 'y',
    CONFIG_BLK_DEV_INITRD: 'y',
    CONFIG_CMDLINE_PARTITION: 'y',
    CONFIG_DRM_DW_HDMI: 'y',
    CONFIG_DRM_MESON: 'y',
    CONFIG_DRM_MESON_DW_HDMI: 'y',
    CONFIG_DWMAC_MESON: 'y',
    CONFIG_EXT4_FS: 'y',
    CONFIG_IKCONFIG: 'y',
    CONFIG_MESON_GXL_PHY: 'y',
    CONFIG_MMC_BLOCK: 'y',
    CONFIG_MMC_MESON_GX: 'y',
    CONFIG_PHY_MESON_GXL_USB2: 'y',
    CONFIG_RD_GZIP: 'y',
    CONFIG_STMMAC_ETH: 'y',
    ...overrides,
  };
  return `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
}

function arm64Kernel(config) {
  const embedded = Buffer.concat([
    Buffer.from('IKCFG_ST', 'ascii'),
    gzipSync(Buffer.from(config, 'utf8')),
    Buffer.from('IKCFG_ED', 'ascii'),
  ]);
  const image = Buffer.alloc(512 + embedded.length, 0x5a);
  image.fill(0, 0, 64);
  image.writeBigUInt64LE(0x01080000n, 8);
  image.writeBigUInt64LE(BigInt(image.length), 16);
  image.write('ARMd', 56, 'ascii');
  embedded.copy(image, 256);
  return image;
}

function plainDtb() {
  const dtb = Buffer.alloc(64, 0x5a);
  dtb.writeUInt32BE(0xd00dfeed, 0);
  dtb.writeUInt32BE(dtb.length, 4);
  return dtb;
}

function makeBootFixture(context, config = kernelConfig(), initrd = gzipSync(Buffer.from('070701initrd'))) {
  const directory = fixture(context);
  const kernel = path.join(directory, 'Image.gz');
  const ramdisk = path.join(directory, 'initrd.img');
  const dtb = path.join(directory, 'board.dtb');
  const boot = path.join(directory, 'boot.PARTITION');
  fs.writeFileSync(kernel, gzipSync(arm64Kernel(config)));
  fs.writeFileSync(ramdisk, initrd);
  fs.writeFileSync(dtb, plainDtb());
  burnImage.makeBoot(kernel, ramdisk, dtb, boot, `root=UUID=${ROOT_UUID}`);
  return boot;
}

test('stock boot validation proves the kernel and initrd direct-boot contract', (context) => {
  const boot = makeBootFixture(context);

  const result = burnImage.validateStockBoot(boot, ROOT_UUID);

  assert.equal(result.initrdCodec, 'gzip');
  assert.equal(result.initrdKernelConfig, 'CONFIG_RD_GZIP');
  assert.deepEqual(result.requiredKernelConfig, {
    CONFIG_BLK_CMDLINE_PARSER: 'y',
    CONFIG_BLK_DEV_INITRD: 'y',
    CONFIG_CMDLINE_PARTITION: 'y',
    CONFIG_DRM_DW_HDMI: 'y',
    CONFIG_DRM_MESON: 'y',
    CONFIG_DRM_MESON_DW_HDMI: 'y',
    CONFIG_DWMAC_MESON: 'y',
    CONFIG_EXT4_FS: 'y',
    CONFIG_IKCONFIG: 'y',
    CONFIG_MESON_GXL_PHY: 'y',
    CONFIG_MMC_BLOCK: 'y',
    CONFIG_MMC_MESON_GX: 'y',
    CONFIG_PHY_MESON_GXL_USB2: 'y',
    CONFIG_RD_GZIP: 'y',
    CONFIG_STMMAC_ETH: 'y',
  });
  assert.match(result.kernelConfigSha256, /^[0-9a-f]{64}$/);
});

test('stock boot validation rejects disabled direct-boot kernel features', (context) => {
  const missingPartitionParser = makeBootFixture(
    context,
    kernelConfig({ CONFIG_CMDLINE_PARTITION: 'n' }),
  );

  assert.throws(
    () => burnImage.validateStockBoot(missingPartitionParser, ROOT_UUID),
    /CONFIG_CMDLINE_PARTITION=y/,
  );
});

test('stock boot validation requires the initrd codec in the kernel', (context) => {
  const missingGzip = makeBootFixture(context, kernelConfig({ CONFIG_RD_GZIP: 'n' }));

  assert.throws(
    () => burnImage.validateStockBoot(missingGzip, ROOT_UUID),
    /CONFIG_RD_GZIP=y/,
  );
});

test('stock boot validation requires direct HDMI and Ethernet support', (context) => {
  const missingHdmi = makeBootFixture(context, kernelConfig({ CONFIG_DRM_MESON: 'n' }));

  assert.throws(
    () => burnImage.validateStockBoot(missingHdmi, ROOT_UUID),
    /CONFIG_DRM_MESON=y/,
  );
});
