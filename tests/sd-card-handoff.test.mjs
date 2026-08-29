import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import { crc32 } from 'node:zlib';

import {
  UIMAGE_SCRIPT_NAME,
  handoffScript,
  inspectUbootScriptImage,
  parseAmlResource,
  recoloredVendorBitmap,
  ubootScriptImage,
  writeSdHandoffKit,
} from '../src/sd-card-handoff.mjs';
import { extractUbootScriptBody } from '../src/uboot-script-payload.mjs';
import { diagnosticConsoleCmdline } from '../src/stock-kernel-diagnostic.mjs';

const STOCK_ENVIRONMENT = new URL('../config/stock-environment.json', import.meta.url);
const LOGO = new URL('../board-inputs/logo.PARTITION', import.meta.url);
const STOCK_BOOT = new URL('../board-inputs/stock-boot.PARTITION', import.meta.url);

function temporaryDirectory() {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/b860-sd-handoff-`);
  test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function kit() {
  const directory = temporaryDirectory();
  const contract = writeSdHandoffKit(
    new URL(STOCK_ENVIRONMENT).pathname, new URL(LOGO).pathname,
    new URL(STOCK_BOOT).pathname, directory,
  );
  return { directory, contract };
}

test('the U-Boot script image matches the mkimage legacy layout exactly', () => {
  const script = 'echo hello\n';
  const image = ubootScriptImage(script, UIMAGE_SCRIPT_NAME);
  assert.equal(image.readUInt32BE(0), 0x27051956);
  // mkimage -T script 的数据区是 8 字节表 + 脚本正文，正文不额外补 NUL。
  assert.equal(image.readUInt32BE(12), 8 + script.length);
  assert.equal(image.length, 64 + 8 + script.length);
  assert.equal(image.readUInt32BE(64), script.length);
  assert.equal(image.readUInt32BE(68), 0);
  // SOURCE_DATE_EPOCH=0 下 mkimage 的时间戳、加载地址与入口点都是 0。
  assert.equal(image.readUInt32BE(8), 0);
  assert.equal(image.readUInt32BE(16), 0);
  assert.equal(image.readUInt32BE(20), 0);
  assert.equal(image.readUInt8(28), 5);
  assert.equal(image.readUInt8(29), 2);
  assert.equal(image.readUInt8(30), 6);
  assert.equal(image.readUInt8(31), 0);
  assert.equal(image.toString('ascii', 32, 32 + UIMAGE_SCRIPT_NAME.length), UIMAGE_SCRIPT_NAME);
  const payload = image.subarray(64);
  assert.equal(crc32(payload) >>> 0, image.readUInt32BE(24));
  const header = Buffer.from(image.subarray(0, 64));
  header.fill(0, 4, 8);
  assert.equal(crc32(header) >>> 0, image.readUInt32BE(4));
  assert.equal(extractUbootScriptBody(payload).toString('ascii'), script);
});

test('a corrupted script image is rejected rather than silently accepted', () => {
  // 头 CRC 错的脚本会被 U-Boot 静默忽略，屏幕上与「根本没进 update」完全一样。
  const image = ubootScriptImage('echo hello\n', UIMAGE_SCRIPT_NAME);
  assert.deepEqual(inspectUbootScriptImage(image).script, 'echo hello\n');
  for (const [offset, label] of [[4, 'header CRC'], [24, 'payload CRC'], [0, 'magic']]) {
    const damaged = Buffer.from(image);
    damaged.writeUInt32BE((damaged.readUInt32BE(offset) ^ 0xff) >>> 0, offset);
    assert.throws(() => inspectUbootScriptImage(damaged), /CRC is wrong|magic is wrong/u, label);
  }
  const wrongType = Buffer.from(image);
  wrongType.writeUInt8(2, 30);
  wrongType.fill(0, 4, 8);
  wrongType.writeUInt32BE(crc32(wrongType.subarray(0, 64)) >>> 0, 4);
  assert.throws(() => inspectUbootScriptImage(wrongType), /not IH_TYPE_SCRIPT/u);
});

test('the handoff script only uses commands the stock environment already proves exist', () => {
  const script = handoffScript(diagnosticConsoleCmdline(new URL(STOCK_ENVIRONMENT).pathname));
  const lines = script.split('\n');
  // 原厂 init_display 是 bmp pixel -> osd open -> osd clear -> bmp display -> bmp scale，
  // 顺序照抄；bmp pixel 排在 osd open 之后会花屏或什么都不显示。
  const sequence = ['bmp pixel', 'osd open', 'osd clear', 'bmp display', 'bmp scale'];
  for (const bitmap of ['b860run.bmp', 'b860fail.bmp']) {
    const start = lines.indexOf(`if fatload mmc 0 \${loadaddr} ${bitmap}; then`);
    assert.notEqual(start, -1, bitmap);
    assert.deepEqual(
      lines.slice(start + 1, start + 1 + sequence.length)
        .map((line) => line.replace(' ${loadaddr}', '')),
      sequence,
      bitmap,
    );
    assert.equal(lines[start + 1 + sequence.length], 'fi', bitmap);
  }
  // recovery_from_sdcard 自己就用 fatload mmc 0 ${loadaddr} 再 bootm ${loadaddr}，
  // 命令里不引入任何原厂没用过的地址（bootargs 里的地址来自原厂快照，不算）。
  assert.ok(lines.includes('if fatload mmc 0 ${loadaddr} b860boot.img; then'));
  assert.ok(lines.includes('bootm ${loadaddr}'));
  for (const line of lines) {
    if (!line.startsWith('setenv bootargs ')) assert.doesNotMatch(line, /0x[0-9a-f]+/u);
  }
  assert.ok(lines.some((line) => line.startsWith('setenv bootargs ')));
  // 每条读盘都必须被 if 包住：fatload 失败会让整段脚本停下，后面的阶段就再也画不出来。
  for (const line of lines) {
    if (line.startsWith('fatload')) assert.fail(`unguarded fatload: ${line}`);
  }
  assert.equal(script.match(/^if /gmu).length, script.match(/^fi$/gmu).length);
  // 蓝屏必须画在 bootm 之前、红屏在之后，否则两种结局在屏幕上无法区分。
  assert.ok(script.indexOf('b860run.bmp') < script.indexOf('bootm'));
  assert.ok(script.indexOf('bootm') < script.indexOf('b860fail.bmp'));
  // sdc_burning 在 update 里排在 recovery_from_sdcard 之前，脚本绝不能把卡变成烧录盘。
  assert.doesNotMatch(script, /aml_sdc_burn|sdc_burn|update\b|saveenv|defenv|store\s+erase/u);
  assert.ok(script.endsWith('\n'));
});

test('the handoff script sets a command line that overrides the stock quiet serial-only one', () => {
  const script = handoffScript(diagnosticConsoleCmdline(new URL(STOCK_ENVIRONMENT).pathname));
  const setenv = script.split('\n').find((line) => line.startsWith('setenv bootargs '));
  const bootargs = setenv.slice('setenv bootargs '.length);
  assert.match(bootargs, /\binit=\/init\b/u);
  assert.match(bootargs, /\brootfstype=ramfs\b/u);
  assert.match(bootargs, /\bconsole=tty0\b/u);
  assert.match(bootargs, /\bignore_loglevel\b/u);
  // storeargs 会追加 quiet，把 loglevel 压到 4；交接盘是整条替换，不能把它带进来。
  assert.doesNotMatch(bootargs, /\bquiet\b/u);
  // logo=...,loaded 让内核沿用 U-Boot 已经初始化的 OSD，framebuffer 信号灯才有地方画。
  assert.match(bootargs, /\blogo=osd1,loaded,0x[0-9a-f]+,/u);
});

test('the handoff script refuses a command line that could break out of setenv', () => {
  assert.throws(() => handoffScript("a'b"), /must not carry quotes or command separators/u);
  assert.throws(() => handoffScript('a; reset'), /must not carry quotes or command separators/u);
  assert.throws(() => handoffScript('a\nb'), /must not carry quotes or command separators/u);
});

test('the beacon bitmaps reuse the vendor pixel format instead of inventing one', () => {
  const logo = fs.readFileSync(LOGO);
  const items = parseAmlResource(logo);
  // 原厂 9 张图全是 16bpp + BI_BITFIELDS，自造 24bpp 图有被 bmp display 拒绝的风险。
  assert.equal(items.size, 9);
  for (const [name, image] of items) {
    assert.equal(image.toString('ascii', 0, 2), 'BM', name);
    assert.equal(image.readUInt16LE(28), 16, name);
    assert.equal(image.readUInt32LE(30), 3, name);
  }
  // 借 bootup 而不是那些 300x300 的小图：它就是现在屏幕上的 ZTE splash，
  // 尺寸正好是整屏，换色后肉眼判断没有歧义。
  const source = items.get('bootup');
  assert.equal(source.readInt32LE(18), 1920);
  assert.equal(source.readInt32LE(22), 1080);
  for (const colour of [0x001f, 0xf800]) {
    const recoloured = recoloredVendorBitmap(logo, colour);
    assert.equal(recoloured.length, source.length);
    const dataOffset = recoloured.readUInt32LE(10);
    // 头逐字节保留：位深、掩码、DIB 版本都与原厂同构。
    assert.ok(recoloured.subarray(0, dataOffset).equals(source.subarray(0, dataOffset)));
    const pixels = recoloured.readInt32LE(18) * recoloured.readInt32LE(22);
    assert.equal(dataOffset + (pixels * 2), recoloured.length);
    for (const offset of [dataOffset, dataOffset + 2, dataOffset + ((pixels - 1) * 2)]) {
      assert.equal(recoloured.readUInt16LE(offset), colour);
    }
  }
  assert.throws(() => recoloredVendorBitmap(logo, 0x10000), /must be a 16-bit value/u);
});

test('the SD handoff kit never writes eMMC and never ships a burn configuration', () => {
  const { directory, contract } = kit();
  assert.equal(contract.writesEmmc, false);
  assert.deepEqual(contract.prohibited, ['aml_sdc_burn.ini', 'recovery.img']);
  // aml_sdc_burn.ini 会让 update 里排在前面的 sdc_burning 直接开始写 eMMC；
  // recovery.img 这个名字会被原厂 recovery_from_sdcard 在 autoscr 之后带 wipeisb 再启动一次。
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    ['aml_autoscript', 'b860boot.img', 'b860fail.bmp', 'b860run.bmp', 'handoff.cmd'],
  );
  for (const [name, digest] of Object.entries(contract.files)) {
    const contents = fs.readFileSync(`${directory}/${name}`);
    assert.equal(contents.length, digest.size, name);
    assert.equal(crypto.createHash('sha256').update(contents).digest('hex'), digest.sha256, name);
  }
});

test('the packaged autoscript decodes back to the published plain-text script', () => {
  const { directory, contract } = kit();
  const decoded = inspectUbootScriptImage(fs.readFileSync(`${directory}/aml_autoscript`));
  assert.equal(decoded.name, UIMAGE_SCRIPT_NAME);
  assert.equal(decoded.script, contract.script);
  // handoff.cmd 是给 mkimage 的输入；两者不一致就说明发布的字节不是契约描述的那份。
  assert.equal(fs.readFileSync(`${directory}/handoff.cmd`, 'utf8'), contract.script);
});

test('the kit carries the diagnostic boot image verbatim under a non-stock name', () => {
  const { directory, contract } = kit();
  // 同一份镜像走第二条独立通道：卡上这份与 boot.PARTITION 逐字节相同，
  // 于是「刷进去不动」与「镜像本身不能启动」可以分开判定。
  assert.equal(contract.bootFile, 'b860boot.img');
  assert.ok(fs.readFileSync(`${directory}/b860boot.img`).equals(fs.readFileSync(STOCK_BOOT)));
  assert.equal(fs.readFileSync(`${directory}/b860boot.img`).toString('ascii', 0, 8), 'ANDROID!');
  // recovery.img 会被原厂那段 fatload 捡走并带 wipeisb 二次启动，必须不存在。
  assert.equal(fs.existsSync(`${directory}/recovery.img`), false);
});

test('the kit rejects a boot image that is not an Android boot image', () => {
  const directory = temporaryDirectory();
  const notAndroid = `${directory}/not-android.img`;
  fs.writeFileSync(notAndroid, Buffer.alloc(4096, 0x5a));
  assert.throws(
    () => writeSdHandoffKit(
      new URL(STOCK_ENVIRONMENT).pathname, new URL(LOGO).pathname,
      notAndroid, `${directory}/kit`,
    ),
    /not Android boot v0/u,
  );
});

test('the build and validate scripts both derive the kit and cross-check it with mkimage', () => {
  const builder = fs.readFileSync(new URL('../scripts/build-stock-diagnostic-burn.sh', import.meta.url), 'utf8');
  const validator = fs.readFileSync(new URL('../scripts/validate-stock-diagnostic-burn.sh', import.meta.url), 'utf8');
  assert.match(builder, /sd-handoff-kit/u);
  // 自写的 uImage 必须与 mkimage 逐字节一致，否则 CRC 静默失败无从发现。
  assert.match(builder, /mkimage -C none -A arm -T script -n b860-sd-handoff/u);
  assert.match(builder, /cmp -- "\$tmp\/mkimage-autoscript" "\$out\/sd-handoff\/aml_autoscript"/u);
  // 校验侧的 recovery.img 必须取自解包出来的 boot.PARTITION，而不是构建侧的中间产物。
  assert.match(validator, /sd-handoff-kit[\s\S]*\$tmp\/unpack\/boot\.PARTITION/u);
  assert.match(validator, /published SD handoff \$name differs/u);
  assert.match(validator, /aml_sdc_burn\.ini/u);
});
