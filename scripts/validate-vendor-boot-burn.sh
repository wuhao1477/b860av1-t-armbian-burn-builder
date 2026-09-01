#!/usr/bin/env bash
set -Eeuo pipefail

# 独立复核变体 C 的 burn.img：只看包里的字节，不信任构建过程。
# 传第二个参数时，还会把随包发布的 vendor-boot-contract.json 与重算结果比对。
#
# 这套检查的重点和变体 A/B 不一样：那两版要证明「重打包的 FIP 仍然合法」，
# 而这一版要证明「厂商 bootloader 根本没被碰过」—— 逐字节相同、摘要自洽、
# sector 0 干净。见 docs/burn-image.md。

usage() { echo "usage: $0 burn.img [vendor-boot-contract.json]" >&2; exit 2; }
[[ $# -eq 1 || $# -eq 2 ]] || usage
image=$1
contract=${2:-}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ampack=${AMPACK:-ampack}
[[ -f "$image" ]] || { echo 'burn image is missing' >&2; exit 1; }
[[ -z "$contract" || -f "$contract" ]] || { echo 'contract file is missing' >&2; exit 1; }
for command in node sha256sum cmp "$ampack"; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

"$ampack" verify "$image" >/dev/null
"$ampack" unpack "$image" "$tmp/unpack" >/dev/null

for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf meson1.dtb \
  bootloader.PARTITION boot.PARTITION data.PARTITION logo.PARTITION; do
  [[ -s "$tmp/unpack/$name" ]] || { echo "missing $name" >&2; exit 1; }
done
# store 按 meson1.dtb 的 /partitions 表查分区名，表里没有 "1" 也没有 "env"。
# 写它们必然停在 [0x30402004]UBOOT/烧录分区 N/初始化分区/命令结果返回错误。
for name in 1.PARTITION env.PARTITION system.PARTITION vendor.PARTITION recovery.PARTITION \
  cache.PARTITION crypt.PARTITION misc.PARTITION tee.PARTITION rsv.PARTITION; do
  [[ ! -e "$tmp/unpack/$name" ]] || { echo "prohibited partition payload: $name" >&2; exit 1; }
done

echo '01. 原厂输入摘要'
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION logo.PARTITION; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$tmp/unpack/$name" | sha256sum --check --status
done

echo '02. bootloader 与 board-inputs 逐字节相同'
cmp -s "$root/board-inputs/bootloader.PARTITION" "$tmp/unpack/bootloader.PARTITION" || {
  echo 'bootloader.PARTITION was modified' >&2
  exit 1
}
node "$root/scripts/burn-image.mjs" check-bl2-seal "$tmp/unpack/bootloader.PARTITION" >/dev/null
# 446..511 是 DOS MBR 的位置，也在 BL2 摘要覆盖的 [0x70,0xC000) 里面。
# 这一版不嵌 MBR，所以这里必须还是全零。
[[ "$(node -e '
  const image = require("fs").readFileSync(process.argv[1]);
  console.log(image.subarray(440, 512).every((byte) => byte === 0));
' "$tmp/unpack/bootloader.PARTITION")" == true ]] || {
  echo 'vendor bootloader sector 0 is polluted at 440..511' >&2
  exit 1
}

echo '03. Android boot 镜像'
node "$root/scripts/burn-image.mjs" check-boot-size "$tmp/unpack/boot.PARTITION" >/dev/null
node "$root/scripts/burn-image.mjs" check-boot-second "$tmp/unpack/boot.PARTITION" >/dev/null

echo '04. meson1.dtb 的 gxl_p211_1g 槽与 boot 镜像的 second 是同一棵树'
node "$root/scripts/burn-image.mjs" extract-boot-second \
  "$tmp/unpack/boot.PARTITION" "$tmp/second.dtb" >/dev/null
node "$root/scripts/burn-image.mjs" check-burn-dtb-roles \
  "$tmp/unpack/meson1.dtb" "$tmp/second.dtb" >/dev/null

echo '05. cmdline 与 rootfs UUID'
root_uuid=$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$tmp/unpack/data.PARTITION")
node -e '
  const fs = require("node:fs");
  const [, bootPath, expectedUuid, outPath] = process.argv;
  const image = fs.readFileSync(bootPath);
  if (image.toString("ascii", 0, 8) !== "ANDROID!") throw new Error("boot.PARTITION is not ANDROID! v0");
  if (image.readUInt32LE(36) !== 2048) throw new Error("page size is not 2048");
  if (image.readUInt32LE(40) !== 0) throw new Error("header version is not 0");
  // 地址逐个抄的厂商 boot 镜像，bootm 靠它们放载荷。
  for (const [offset, want, what] of [[12, 0x01080000, "kernel"], [20, 0x01000000, "ramdisk"],
    [28, 0x00f00000, "second"], [32, 0x100, "tags"]]) {
    if (image.readUInt32LE(offset) !== want) throw new Error(`${what} load address is wrong`);
  }
  const cmdline = image.toString("ascii", 64, 576).replace(/\0.*$/s, "");
  if (!cmdline.includes(`root=UUID=${expectedUuid}`)) {
    throw new Error("boot cmdline root UUID differs from data.PARTITION");
  }
  // 厂商 storeargs 先设 Android initargs，我们的 cmdline 追加在后面靠「取最后一个」生效。
  if (!cmdline.includes("blkdevparts=mmcblk2:")) throw new Error("cmdline lacks blkdevparts=");
  // 这块板没有可用串口：console= 的最后一个必须是 tty0，否则屏幕上什么都看不到。
  const consoles = cmdline.match(/console=[^\s]+/g) ?? [];
  if (consoles.at(-1) !== "console=tty0") throw new Error("the last console= must be tty0");
  if (!/\binit=\/sbin\/init\b/.test(cmdline)) throw new Error("cmdline lacks init=/sbin/init");
  const page = 2048;
  const pad = (n) => Math.ceil(n / page) * page;
  const kernel = image.readUInt32LE(8);
  const ramdisk = image.readUInt32LE(16);
  const dtb = image.readUInt32LE(24);
  if (kernel === 0 || ramdisk === 0 || dtb === 0) throw new Error("boot image has an empty payload");
  const expectedSize = page + pad(kernel) + pad(ramdisk) + pad(dtb);
  if (image.length !== expectedSize) throw new Error("boot image size does not match its header");
  const kernelStart = page;
  if (image[kernelStart] !== 0x1f || image[kernelStart + 1] !== 0x8b) {
    throw new Error("kernel is not gzip-compressed");
  }
  fs.writeFileSync(outPath, `${JSON.stringify({
    size: image.length, kernel, ramdisk, dtb, cmdline: cmdline.length,
  }, null, 2)}\n`);
  console.log(cmdline);
' "$tmp/unpack/boot.PARTITION" "$root_uuid" "$tmp/android-boot.json" >"$tmp/cmdline.txt"

if [[ -n "$contract" ]]; then
  echo '06. 与随包发布的 vendor-boot-contract.json 比对'
  node -e '
    const fs = require("node:fs");
    const [, publishedPath, recomputedPath, cmdlinePath, uuid] = process.argv;
    const published = JSON.parse(fs.readFileSync(publishedPath, "utf8"));
    const recomputed = JSON.parse(fs.readFileSync(recomputedPath, "utf8"));
    const cmdline = fs.readFileSync(cmdlinePath, "utf8").trim();
    if (published.strategy !== "vendor-fip-vendor-bl33-android-boot") {
      throw new Error("contract is not the vendor-bootloader strategy");
    }
    if (published.rootUuid !== uuid) throw new Error("contract root UUID differs from data.PARTITION");
    if (published.commandLine !== cmdline) throw new Error("contract command line differs from boot.PARTITION");
    if (JSON.stringify(published.androidBoot) !== JSON.stringify(recomputed)) {
      throw new Error("published vendor-boot-contract.json differs from the unpacked burn image");
    }
  ' "$contract" "$tmp/android-boot.json" "$tmp/cmdline.txt" "$root_uuid"
fi

echo "vendor-boot burn image is consistent  root=$root_uuid"
