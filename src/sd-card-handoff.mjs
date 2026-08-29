import crypto from 'node:crypto';
import fs from 'node:fs';
import { crc32 } from 'node:zlib';

import { extractUbootScriptBody } from './uboot-script-payload.mjs';
import { diagnosticConsoleCmdline } from './stock-kernel-diagnostic.mjs';

/**
 * 免刷机的 SD 卡交接盘。
 *
 * 原厂 U-Boot 环境快照里有一条一直没被用过的通道：
 *   update               = run usb_burning; run sdc_burning; if mmcinfo; then run recovery_from_sdcard;fi; ...
 *   recovery_from_sdcard = if fatload mmc 0 ${loadaddr} aml_autoscript; then autoscr ${loadaddr}; fi;
 *                          if fatload mmc 0 ${loadaddr} recovery.img; then ...wipeisb; bootm ${loadaddr};fi;
 * autoscr 把 FAT 卡上的 aml_autoscript 当 U-Boot 脚本执行 —— 也就是任意 U-Boot 命令，
 * 而且整条路完全不写 eMMC。卡拔掉就恢复原状，于是可以反复试，不再「一次刷机换一个结论」。
 *
 * 两个入口都通向 update：
 *   AV 孔里按住复位针再上电(toothpick)，switch_bootmode 读到 reboot_mode=update；
 *   或者 storeboot 的 bootm 失败后自己 fall through 到 run update ——
 *   现在停在 splash 的板子很可能已经每次开机都停在这里。
 *
 * 三态可见输出，只用 init_display 已经证实存在的 bmp 命令：
 *   蓝屏          autoscr 跑起来了，脚本通道成立
 *   红屏          bootm 返回了，内核没接手，问题在 boot 镜像本身
 *   ZTE splash 不变  根本没走到 update
 * 蓝屏之后转黑并开始闪烁，则是内核接手、initramfs 信号灯起来了。
 */
const UIMAGE_MAGIC = 0x27051956;
const UIMAGE_HEADER_BYTES = 64;
const UIMAGE_NAME_BYTES = 32;
// do_source 只校验 magic / 头 CRC / IH_TYPE_SCRIPT / 数据 CRC 并要求 os 是 Linux，
// arch 不参与判定。取 ARM(2) 与 mkimage -A arm 以及本仓库既有的 s905_autoscript 一致。
const IH_OS_LINUX = 5;
const IH_ARCH_ARM = 2;
const IH_TYPE_SCRIPT = 6;
const IH_COMP_NONE = 0;
export const UIMAGE_SCRIPT_NAME = 'b860-sd-handoff';

const AML_RESOURCE_MAGIC = 'AML_RES!';
const AML_RESOURCE_ENTRY_BYTES = 64;
// 原厂 logo 里的 BMP 一律是 16bpp + BI_BITFIELDS(RGB565) + 56 字节 DIB 头。
// 自己造 24bpp 无压缩图有被 Amlogic 的 bmp display 拒绝的风险，所以只借原厂的头，
// 单独改像素 —— 格式与原厂逐字节同构，能显示是既成事实。
// 借的是 bootup：它就是现在屏幕上那张 ZTE splash，1920x1080 正好等于 fb_width/fb_height，
// 于是整屏换色，不会变成白底上的一个小方块，靠肉眼判断时没有歧义。
const BMP_BITS_PER_PIXEL = 16;
const BMP_BITFIELDS_COMPRESSION = 3;
const RGB565_BLUE = 0x001f;
const RGB565_RED = 0xf800;
const BMP_SOURCE_ITEM = 'bootup';
// 位图和引导镜像共用 ${loadaddr}，不另挑地址。两件事都是照抄原厂：
//   init_display         读 logo 到 $loadaddr，bmp display 之后 storeboot 用同一块内存装内核，
//                        画面照旧留在屏上 —— 说明 bmp display 是同步拷进 OSD 的。
//   recovery_from_sdcard fatload mmc 0 ${loadaddr} recovery.img 之后直接 bootm ${loadaddr}。
// 于是「从卡上 fatload 一整个 Android 镜像到 loadaddr 再 bootm」是原厂自己就在走的路，
// 我们不引入任何新地址假设。
const LOAD_ADDRESS = '${loadaddr}';

const SCRIPT_SOURCE_FILE = 'handoff.cmd';
const SCRIPT_FILE = 'aml_autoscript';
// 刻意不叫 recovery.img：原厂 recovery_from_sdcard 在 autoscr 之后自己还有一段
//   if fatload mmc 0 ${loadaddr} recovery.img; then ...wipeisb; bootm ${loadaddr};fi;
// 用原名的话，我们的 bootm 一旦返回，原厂那段会带着 wipeisb 再启动一次同一份镜像。
// 换个名字，这段 fatload 必然失败，整张卡就只有我们的脚本会读它。
const BOOT_FILE = 'b860boot.img';
const RUNNING_BMP_FILE = 'b860run.bmp';
const FAILED_BMP_FILE = 'b860fail.bmp';
// 这个文件一旦出现在卡上，update 里排在 recovery_from_sdcard 之前的 sdc_burning
// 会抢先把卡当烧录盘、直接开始写 eMMC。交接盘的全部价值就是不写 eMMC，必须没有它。
const PROHIBITED_FILE = 'aml_sdc_burn.ini';

function fail(message) {
  throw new Error(message);
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** logo.PARTITION 是 AML_RES! 容器：64 字节头 + 每项 64 字节的目录 + 各 BMP 正文。 */
export function parseAmlResource(image) {
  if (image.length < AML_RESOURCE_ENTRY_BYTES
      || image.toString('ascii', 8, 16) !== AML_RESOURCE_MAGIC) {
    fail('logo partition is not an AML_RES! container');
  }
  if (image.readUInt32LE(16) !== image.length) fail('AML_RES! total size differs from the file');
  const count = image.readUInt32LE(20);
  if (count < 1 || count > 64) fail('AML_RES! item count is implausible');
  const items = new Map();
  for (let index = 0; index < count; index += 1) {
    const entry = image.subarray(
      AML_RESOURCE_ENTRY_BYTES * (index + 1),
      AML_RESOURCE_ENTRY_BYTES * (index + 2),
    );
    if (entry.length !== AML_RESOURCE_ENTRY_BYTES) fail('AML_RES! directory is truncated');
    if (entry.readUInt32LE(0) !== UIMAGE_MAGIC) fail('AML_RES! item magic is wrong');
    const size = entry.readUInt32LE(8);
    const start = entry.readUInt32LE(12);
    const name = entry.toString('latin1', 32, 64).replace(/\0[\s\S]*$/u, '');
    if (start + size > image.length) fail(`AML_RES! item overruns the file: ${name}`);
    items.set(name, image.subarray(start, start + size));
  }
  return items;
}

/**
 * 借原厂 BMP 的头，把像素整片改成一个 RGB565 常量。
 * 头逐字节保留意味着位深、掩码、DIB 版本都与原厂一致，不引入新的显示风险。
 */
export function recoloredVendorBitmap(logoImage, rgb565) {
  if (!Number.isInteger(rgb565) || rgb565 < 0 || rgb565 > 0xffff) {
    fail('bitmap colour must be a 16-bit value');
  }
  const source = parseAmlResource(logoImage).get(BMP_SOURCE_ITEM);
  if (!source) fail(`logo partition lacks ${BMP_SOURCE_ITEM}`);
  if (source.toString('ascii', 0, 2) !== 'BM') fail('vendor bitmap is not a BMP');
  if (source.readUInt16LE(28) !== BMP_BITS_PER_PIXEL
      || source.readUInt32LE(30) !== BMP_BITFIELDS_COMPRESSION) {
    fail('vendor bitmap is not 16bpp BI_BITFIELDS');
  }
  const dataOffset = source.readUInt32LE(10);
  const width = source.readInt32LE(18);
  const height = source.readInt32LE(22);
  if (width <= 0 || height <= 0) fail('vendor bitmap dimensions are invalid');
  const pixelBytes = width * height * 2;
  if (dataOffset + pixelBytes > source.length) fail('vendor bitmap pixel array is truncated');
  const output = Buffer.from(source);
  for (let offset = dataOffset; offset < dataOffset + pixelBytes; offset += 2) {
    output.writeUInt16LE(rgb565, offset);
  }
  return output;
}

/** U-Boot legacy uImage，IH_TYPE_SCRIPT，与 mkimage -C none -A arm -T script 逐字节一致。 */
export function ubootScriptImage(script, name) {
  if (!/^[\x20-\x7e\n]+$/u.test(script)) fail('U-Boot script must be printable ASCII');
  if (!script.endsWith('\n')) fail('U-Boot script must end with a newline');
  const text = Buffer.from(script, 'ascii');
  const table = Buffer.alloc(8);
  table.writeUInt32BE(text.length, 0);
  const payload = Buffer.concat([table, text]);
  const header = Buffer.alloc(UIMAGE_HEADER_BYTES);
  header.writeUInt32BE(UIMAGE_MAGIC, 0);
  header.writeUInt32BE(payload.length, 12);
  header.writeUInt32BE(crc32(payload) >>> 0, 24);
  header.writeUInt8(IH_OS_LINUX, 28);
  header.writeUInt8(IH_ARCH_ARM, 29);
  header.writeUInt8(IH_TYPE_SCRIPT, 30);
  header.writeUInt8(IH_COMP_NONE, 31);
  const encoded = Buffer.from(name, 'ascii');
  if (encoded.length >= UIMAGE_NAME_BYTES) fail('U-Boot script name is too long');
  encoded.copy(header, 32);
  // 头 CRC 覆盖整个头，计算时 CRC 字段本身为零。
  header.writeUInt32BE(crc32(header) >>> 0, 4);
  return Buffer.concat([header, payload]);
}

/** 独立重解一遍：CRC 错的脚本会被 U-Boot 静默拒绝，那正是最难与「没进 update」区分的失败。 */
export function inspectUbootScriptImage(image) {
  if (image.length < UIMAGE_HEADER_BYTES + 8) fail('U-Boot script image is truncated');
  if (image.readUInt32BE(0) !== UIMAGE_MAGIC) fail('U-Boot script image magic is wrong');
  const header = Buffer.from(image.subarray(0, UIMAGE_HEADER_BYTES));
  const headerCrc = header.readUInt32BE(4);
  header.fill(0, 4, 8);
  if ((crc32(header) >>> 0) !== headerCrc) fail('U-Boot script image header CRC is wrong');
  if (image.readUInt8(28) !== IH_OS_LINUX) fail('U-Boot script image OS is not Linux');
  if (image.readUInt8(30) !== IH_TYPE_SCRIPT) fail('U-Boot script image is not IH_TYPE_SCRIPT');
  if (image.readUInt8(31) !== IH_COMP_NONE) fail('U-Boot script image is compressed');
  const size = image.readUInt32BE(12);
  if (size !== image.length - UIMAGE_HEADER_BYTES) fail('U-Boot script image size mismatch');
  const payload = image.subarray(UIMAGE_HEADER_BYTES);
  if ((crc32(payload) >>> 0) !== image.readUInt32BE(24)) {
    fail('U-Boot script image payload CRC is wrong');
  }
  return {
    name: image.toString('ascii', 32, 64).replace(/\0[\s\S]*$/u, ''),
    script: extractUbootScriptBody(payload).toString('ascii'),
  };
}

/**
 * fatload 找不到文件会让脚本停下，所以每次读盘都套在 if 里；显示序列则逐条照抄原厂
 * init_display：`bmp pixel` 按位图的位深配置 OSD，必须排在 `osd open` 之前，
 * 顺序错了就是一屏花屏或者干脆什么都不显示。
 *
 * 先画蓝屏再 bootm：bootm 成功就不返回，屏幕停在蓝屏直到内核把 fb 接过去；
 * bootm 失败才会走到红屏。两种结局在屏幕上互不混淆。
 */
function showBitmap(file) {
  return [
    `if fatload mmc 0 ${LOAD_ADDRESS} ${file}; then`,
    `bmp pixel ${LOAD_ADDRESS}`,
    'osd open',
    'osd clear',
    `bmp display ${LOAD_ADDRESS}`,
    'bmp scale',
    'fi',
  ];
}

export function handoffScript(consoleCmdline) {
  if (/['\n;]/u.test(consoleCmdline)) {
    fail('diagnostic command line must not carry quotes or command separators');
  }
  return `${[
    'echo b860 sd handoff autoscript',
    ...showBitmap(RUNNING_BMP_FILE),
    `setenv bootargs ${consoleCmdline}`,
    'echo bootargs=${bootargs}',
    `if fatload mmc 0 ${LOAD_ADDRESS} ${BOOT_FILE}; then`,
    `bootm ${LOAD_ADDRESS}`,
    'fi',
    ...showBitmap(FAILED_BMP_FILE),
    'echo b860 sd handoff did not boot',
  ].join('\n')}\n`;
}

/**
 * 写出交接盘的五个文件并返回契约。校验侧独立重跑同一函数再逐字节 cmp，两侧互不信任。
 * handoff.cmd 是给 mkimage 的脚本正文，构建脚本用它交叉验证 aml_autoscript 的字节。
 */
export function writeSdHandoffKit(
  stockEnvironmentPath, logoPath, bootImagePath, outputDirectory,
) {
  const consoleCmdline = diagnosticConsoleCmdline(stockEnvironmentPath);
  const script = handoffScript(consoleCmdline);
  const image = ubootScriptImage(script, UIMAGE_SCRIPT_NAME);
  const decoded = inspectUbootScriptImage(image);
  if (decoded.script !== script || decoded.name !== UIMAGE_SCRIPT_NAME) {
    fail('U-Boot script image does not round-trip');
  }
  const boot = fs.readFileSync(bootImagePath);
  if (boot.toString('ascii', 0, 8) !== 'ANDROID!') {
    fail('SD handoff boot image is not Android boot v0');
  }
  const logo = fs.readFileSync(logoPath);
  const files = {
    [SCRIPT_SOURCE_FILE]: Buffer.from(script, 'ascii'),
    [SCRIPT_FILE]: image,
    [BOOT_FILE]: boot,
    [RUNNING_BMP_FILE]: recoloredVendorBitmap(logo, RGB565_BLUE),
    [FAILED_BMP_FILE]: recoloredVendorBitmap(logo, RGB565_RED),
  };
  if (PROHIBITED_FILE in files) fail(`SD handoff kit must never contain ${PROHIBITED_FILE}`);
  // 原名 recovery.img 会被原厂 recovery_from_sdcard 在 autoscr 之后再启动一次，
  // 而且带 wipeisb。用别名确保这张卡只有我们的脚本会读引导镜像。
  if ('recovery.img' in files) fail('SD handoff kit must not use the stock recovery.img name');
  const directory = outputDirectory.replace(/\/$/u, '');
  fs.mkdirSync(directory, { recursive: true });
  const digests = {};
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(`${directory}/${name}`, contents);
    digests[name] = { size: contents.length, sha256: sha256(contents) };
  }
  for (const name of fs.readdirSync(directory)) {
    if (!(name in files)) fail(`SD handoff kit contains an unexpected file: ${name}`);
  }
  return {
    schemaVersion: 1,
    variant: 'sd-handoff',
    entry: 'toothpick reset into update, or storeboot falling through to update',
    path: 'recovery_from_sdcard -> fatload mmc 0 aml_autoscript -> autoscr',
    writesEmmc: false,
    consoleCmdline,
    script,
    scriptName: UIMAGE_SCRIPT_NAME,
    bootFile: BOOT_FILE,
    bitmapSource: BMP_SOURCE_ITEM,
    loadAddress: LOAD_ADDRESS,
    files: digests,
    prohibited: [PROHIBITED_FILE, 'recovery.img'],
  };
}
