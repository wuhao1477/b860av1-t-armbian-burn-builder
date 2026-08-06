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
const TEST_KERNEL_CONFIG = [
  'CONFIG_BLK_CMDLINE_PARSER=y', 'CONFIG_BLK_DEV_INITRD=y', 'CONFIG_CMDLINE_PARTITION=y',
  'CONFIG_DEVTMPFS=y', 'CONFIG_DEVTMPFS_MOUNT=y',
  'CONFIG_DRM_DW_HDMI=y', 'CONFIG_DRM_MESON=y', 'CONFIG_DRM_MESON_DW_HDMI=y',
  'CONFIG_DWMAC_MESON=y', 'CONFIG_EXT4_FS=y', 'CONFIG_IKCONFIG=y',
  'CONFIG_MESON_GXL_PHY=y', 'CONFIG_MMC_BLOCK=y', 'CONFIG_MMC_MESON_GX=y',
  'CONFIG_PHY_MESON_GXL_USB2=y', 'CONFIG_RD_GZIP=y', 'CONFIG_STMMAC_ETH=y',
].join('\n') + '\n';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-burn-image-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function arm64Image(size = 4096) {
  const embeddedConfig = Buffer.concat([
    Buffer.from('IKCFG_ST'), gzipSync(Buffer.from(TEST_KERNEL_CONFIG)), Buffer.from('IKCFG_ED'),
  ]);
  const image = Buffer.alloc(size, 0x5a);
  image.fill(0, 0, 64);
  image.writeBigUInt64LE(0x01080000n, 8);
  image.writeBigUInt64LE(BigInt(size), 16);
  image.write('ARMd', 56, 'ascii');
  embeddedConfig.copy(image, 256);
  return image;
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

test('device-tree selection consumes the source-built B860 P212 DTB', (context) => {
  const directory = fixture(context);
  const generic = path.join(directory, 'meson-gxl-s905x-p212.dtb');
  const dedicated = path.join(directory, 'meson-gxl-s905x-p212-b860av11t.dtb');
  fs.writeFileSync(generic, 'generic');
  fs.writeFileSync(dedicated, 'dedicated');

  assert.equal(
    typeof burnImage.selectDeviceTreePath,
    'function',
    'missing B860-specific DTB selector',
  );
  assert.equal(burnImage.selectDeviceTreePath([generic, dedicated]), dedicated);
  assert.throws(
    () => burnImage.selectDeviceTreePath([generic]),
    /expected DTB: meson-gxl-s905x-p212-b860av11t\.dtb/,
  );
});

test('initrd selection requires the raw versioned initramfs', (context) => {
  const directory = fixture(context);
  const legacy = path.join(directory, 'uInitrd');
  const raw = path.join(directory, 'initrd.img-5.10.262-ophub');
  fs.writeFileSync(legacy, 'legacy');
  fs.writeFileSync(raw, 'raw');

  assert.equal(
    typeof burnImage.selectInitrdPath,
    'function',
    'missing raw initrd selector',
  );
  assert.equal(burnImage.selectInitrdPath([legacy, raw]), raw);
  assert.throws(
    () => burnImage.selectInitrdPath([legacy]),
    /raw versioned initrd/,
  );
});

test('direct eMMC boot command line uses the copied root filesystem UUID', () => {
  assert.equal(
    typeof burnImage.createBootCommandLine,
    'function',
    'missing direct-boot command-line builder',
  );

  const tokens = burnImage.createBootCommandLine(1024, '50031852-ee90-4285-ada7-ab9dc14670c9').split(/\s+/);

  assert.equal(tokens.filter((token) => /^mem=/.test(token)).length, 1);
  assert.ok(tokens.includes('mem=1024M'));
  assert.ok(tokens.includes('root=UUID=50031852-ee90-4285-ada7-ab9dc14670c9'));
  assert.equal(tokens.some((token) => token === 'root=LABEL=ROOTFS'), false);
  assert.throws(
    () => burnImage.createBootCommandLine(1024, 'ROOTFS'),
    /root filesystem UUID/,
  );
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

test('boot image exposes a plain Linux FDT to the stock boot second fallback', (context) => {
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

  assert.equal(result.dtb, dtbBytes.length);
  assert.equal(image.readUInt32LE(24), dtbBytes.length);
  assert.equal(second.readUInt32BE(0), 0xd00dfeed);
  assert.notEqual(second.toString('ascii', 0, 4), 'AML_');
  assert.deepEqual(second, dtbBytes);
});

test('burn DTB validation accepts a plain FDT in boot second', (context) => {
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
  burnImage.makeBoot(
    kernel,
    ramdisk,
    dtb,
    boot,
    'root=UUID=50031852-ee90-4285-ada7-ab9dc14670c9',
  );

  assert.equal(
    typeof burnImage.validateBootSecondDtb,
    'function',
    'missing boot second DTB validator',
  );
  assert.deepEqual(burnImage.validateBootSecondDtb(boot), {
    size: 64,
    fdtSize: 64,
  });
});

test('burn DTB validation rejects an AML multi-DTB in boot second', (context) => {
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
  burnImage.makeBoot(
    kernel,
    ramdisk,
    dtb,
    boot,
    'root=UUID=50031852-ee90-4285-ada7-ab9dc14670c9',
  );
  const image = fs.readFileSync(boot);
  const secondOffset = 2048 + 4096 + 2048;
  image.write('AML_', secondOffset, 'ascii');
  fs.writeFileSync(boot, image);

  assert.throws(
    () => burnImage.validateBootSecondDtb(boot),
    /plain FDT/,
  );
});

test('stock boot validation proves the complete Linux boot payload contract', (context) => {
  const directory = fixture(context);
  const kernel = path.join(directory, 'Image.gz');
  const ramdisk = path.join(directory, 'initrd.img');
  const dtb = path.join(directory, 'board.dtb');
  const boot = path.join(directory, 'boot.PARTITION');
  const rawKernel = arm64Image();
  const rawRamdisk = Buffer.alloc(0);
  const dtbBytes = Buffer.alloc(64, 0x5a);
  dtbBytes.writeUInt32BE(0xd00dfeed, 0);
  dtbBytes.writeUInt32BE(dtbBytes.length, 4);
  fs.writeFileSync(kernel, gzipSync(rawKernel));
  fs.writeFileSync(ramdisk, rawRamdisk);
  fs.writeFileSync(dtb, dtbBytes);
  burnImage.makeBoot(
    kernel,
    ramdisk,
    dtb,
    boot,
    'root=UUID=50031852-ee90-4285-ada7-ab9dc14670c9',
  );

  assert.equal(
    typeof burnImage.validateStockBoot,
    'function',
    'missing complete stock boot validator',
  );
  const result = burnImage.validateStockBoot(boot);
  assert.match(result.kernelConfigSha256, /^[0-9a-f]{64}$/);
  delete result.kernelConfigSha256;
  assert.deepEqual(result, {
    size: fs.statSync(boot).size,
    pageSize: 2048,
    kernelCompressedSize: fs.statSync(kernel).size,
    kernelUncompressedSize: rawKernel.length,
    kernelLoadAddress: 0x01080000,
    kernelTextOffset: 0x01080000,
    ramdiskSize: rawRamdisk.length,
    secondSize: dtbBytes.length,
    secondFdtSize: dtbBytes.length,
    rootUuid: '50031852-ee90-4285-ada7-ab9dc14670c9',
    initrdCodec: 'none',
    initrdKernelConfig: null,
    requiredKernelConfig: {
      CONFIG_BLK_CMDLINE_PARSER: 'y', CONFIG_BLK_DEV_INITRD: 'y',
      CONFIG_CMDLINE_PARTITION: 'y', CONFIG_DEVTMPFS: 'y', CONFIG_DEVTMPFS_MOUNT: 'y',
      CONFIG_DRM_DW_HDMI: 'y', CONFIG_DRM_MESON: 'y',
      CONFIG_DRM_MESON_DW_HDMI: 'y', CONFIG_DWMAC_MESON: 'y', CONFIG_EXT4_FS: 'y',
      CONFIG_IKCONFIG: 'y', CONFIG_MESON_GXL_PHY: 'y', CONFIG_MMC_BLOCK: 'y',
      CONFIG_MMC_MESON_GX: 'y', CONFIG_PHY_MESON_GXL_USB2: 'y',
      CONFIG_STMMAC_ETH: 'y',
    },
  });
});

test('stock boot validation rejects a ramdisk inside Android boot', (context) => {
  const directory = fixture(context);
  const kernel = path.join(directory, 'Image.gz');
  const ramdisk = path.join(directory, 'uInitrd');
  const dtb = path.join(directory, 'board.dtb');
  const boot = path.join(directory, 'boot.PARTITION');
  const legacyRamdisk = Buffer.alloc(128);
  legacyRamdisk.writeUInt32BE(0x27051956, 0);
  const dtbBytes = Buffer.alloc(64, 0x5a);
  dtbBytes.writeUInt32BE(0xd00dfeed, 0);
  dtbBytes.writeUInt32BE(dtbBytes.length, 4);
  fs.writeFileSync(kernel, gzipSync(arm64Image()));
  fs.writeFileSync(ramdisk, legacyRamdisk);
  fs.writeFileSync(dtb, dtbBytes);
  burnImage.makeBoot(kernel, ramdisk, dtb, boot, 'root=LABEL=ROOTFS');

  assert.throws(
    () => burnImage.validateStockBoot(boot),
    /must not contain an initramfs/,
  );
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
