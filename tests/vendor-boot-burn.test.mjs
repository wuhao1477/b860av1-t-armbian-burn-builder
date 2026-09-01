import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { createBootCommandLine, makeBoot } from '../scripts/burn-image.mjs';

// 变体 C 的全部价值就在「厂商 bootloader 一个字节都不改」上。这里把那条不变量
// 钉死：脚本一旦重新引入 MBR 嵌入或 FIP 重打包，测试必须红。
// 背景见 docs/burn-image.md 的「三次全黑的根因」。

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
// 注释里会解释「为什么不用 gxlimg」，检查实际调用时要先把注释去掉。
const code = (file) => read(file).split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

test('vendor-boot builder leaves the stock bootloader untouched', () => {
  const script = read('scripts/build-vendor-boot-burn.sh');

  assert.match(script, /vendor-fip-vendor-bl33-android-boot/);
  assert.match(script, /cmp -s "\$root\/board-inputs\/bootloader\.PARTITION"/);
  assert.match(script, /check-bl2-seal/);
  assert.match(script, /subarray\(440, 512\)/);
  // gxlimg 还原不出原厂 AMLC 编码，所以这条路径上不能出现任何 FIP 重打包。
  const body = code('scripts/build-vendor-boot-burn.sh');
  for (const forbidden of ['gxlimg', 'embed-dos-mbr', 'embed-rootfs-mbr', 'reseal-bl2']) {
    assert.ok(!body.includes(forbidden), `builder must not use ${forbidden}`);
  }
  // 没有串口时，开机图是唯一能区分「bootloader 没跑」和「跑了但没进系统」的信号。
  assert.match(script, /logo\.PARTITION/);
});

test('vendor-boot validator rejects partitions the stock partition table lacks', () => {
  const script = read('scripts/validate-vendor-boot-burn.sh');

  for (const required of ['bootloader.PARTITION', 'boot.PARTITION', 'data.PARTITION',
    'logo.PARTITION', 'meson1.dtb']) {
    assert.ok(script.includes(required), `validator must require ${required}`);
  }
  // store 按 meson1.dtb 的 /partitions 查表，没有 "1" 也没有 "env"。
  for (const prohibited of ['1.PARTITION', 'env.PARTITION', 'system.PARTITION']) {
    assert.ok(script.includes(prohibited), `validator must reject ${prohibited}`);
  }
  assert.match(script, /cmp -s "\$root\/board-inputs\/bootloader\.PARTITION"/);
  assert.match(script, /check-bl2-seal/);
  assert.match(script, /check-burn-dtb-roles/);
});

test('image tool bootstrap pins ampack and gxlimg to the configured commits', () => {
  const script = read('scripts/setup-image-tools.sh');

  assert.match(script, /config\/burn-tooling\.json/);
  assert.match(script, /config\/mainline-boot\.json/);
  assert.match(script, /rev-parse HEAD/);
});

test('command line ends with console=tty0 because the board has no usable serial port', () => {
  const cmdline = createBootCommandLine(1024, '3e900a5c-42af-4f1f-a78e-e4a8efad2459');
  const consoles = cmdline.match(/console=\S+/g);

  assert.equal(consoles.at(-1), 'console=tty0');
  // 厂商 storeargs 先设 Android initargs，我们的追加在后面，靠「取最后一个」覆盖。
  assert.match(cmdline, /blkdevparts=mmcblk2:/);
  assert.match(cmdline, /root=UUID=3e900a5c-42af-4f1f-a78e-e4a8efad2459/);
  assert.match(cmdline, /init=\/sbin\/init$/);
  assert.ok(cmdline.length <= 512, 'Android boot v0 caps the command line at 512 bytes');
});

test('Android boot image reuses the vendor load addresses', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-vendor-boot-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, data) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, data);
    return file;
  };
  // 最小合法 FDT：magic + totalsize，够 inspectPlainFdt 认。
  const dtb = Buffer.alloc(256);
  dtb.writeUInt32BE(0xd00dfeed, 0);
  dtb.writeUInt32BE(dtb.length, 4);
  const output = path.join(directory, 'boot.PARTITION');

  const contract = makeBoot(
    write('Image.gz', gzipSync(Buffer.alloc(4096, 7))),
    write('initrd.img', Buffer.alloc(2048, 3)),
    write('linux.dtb', dtb),
    output,
    createBootCommandLine(1024, '3e900a5c-42af-4f1f-a78e-e4a8efad2459'),
  );
  const image = fs.readFileSync(output);

  assert.equal(image.toString('ascii', 0, 8), 'ANDROID!');
  assert.equal(image.readUInt32LE(36), 2048, 'page size');
  assert.equal(image.readUInt32LE(40), 0, 'header version');
  // 逐个抄自原厂 boot.PARTITION；改动会让厂商 bootm 把载荷放错地方。
  assert.equal(image.readUInt32LE(12), 0x01080000, 'kernel address');
  assert.equal(image.readUInt32LE(20), 0x01000000, 'ramdisk address');
  assert.equal(image.readUInt32LE(28), 0x00f00000, 'second address');
  assert.equal(image.readUInt32LE(32), 0x100, 'tags address');
  assert.equal(contract.size, image.length);
  assert.equal(image.length % 2048, 0, 'payloads stay page aligned');
});
