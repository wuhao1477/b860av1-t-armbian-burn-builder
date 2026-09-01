#!/usr/bin/env bash
set -Eeuo pipefail

# 变体 C：厂商 bootloader 一个字节不动，Armbian 装进 Android boot 镜像。
#
# 为什么不再重打包 FIP：gxlimg 连原封不动的原厂组件都还原不回原字节。拿 Milton
# 包实测，bl33.enc 解码再编码，549,888 字节里有 547,330 字节不同 —— AMLC 头
# 0x00..0x20 一致，0x20..0x40 的 32 字节和整个载荷全变；用未改动的 bl2/bl30/
# bl301/bl31/bl33 重建 FIP 也只有前 0xC000(BL2) 对得上，从 0xC020 起就不一样。
# 所以任何 gxlimg 重打包出来的 bootloader，原厂 BL2 拿到的都是它不认的 BL33 块，
# 加载完跳过去就死，HDMI 上什么都不会有 —— 这正是前三版实机全黑的原因。
#
# 于是改成：bootloader.PARTITION 直接用 board-inputs 里那份原厂副本(sha256
# 50b0fb65…，与 Milton 包里的逐字节相同)，连 MBR 都不嵌，BL33 仍是厂商
# U-Boot 2015.01 gxl_p211_1g。启动交给它自己的环境：
#
#   bootcmd   = run storeboot
#   storeboot = if imgread kernel boot ${loadaddr}; then bootm ${loadaddr}; fi; run update;
#
# imgread 读 eMMC boot 分区里的 Android boot 镜像再 bootm，所以 boot.PARTITION
# 换成 ANDROID! v0：kernel=Image.gz(厂商内核本身就是 gzip，bootm 会解压)、
# ramdisk=initrd.img、second=B860 的 Linux DTB。地址逐个抄厂商那份镜像的头
# (kernel@0x01080000 / ramdisk@0x01000000 / second@0x00f00000 / tags@0x100)。
#
# 根文件系统靠 cmdline 里的 blkdevparts= 定位，不依赖 MBR —— 这样 bootloader
# 才能真正保持零改动。厂商 storeargs 会先把 bootargs 设成 Android 的 initargs，
# boot 镜像自带的 cmdline 追加在后面，init=/root=/rootfstype=/console= 都是后者生效。
#
# meson1.dtb 用 replace-linux-target-dtb 把 gxl_p211_1g 槽换成同一份 Linux DTB：
# 厂商 U-Boot 不论从 boot 镜像的 second 还是从 eMMC dtb 区取树，拿到的都是它。
#
# 另外带上 Milton 的 logo.PARTITION 当可视证据：厂商 preboot 的 init_display 会
# 画这张图。开机图出现 = 厂商 BL2/BL31/BL33 全跑起来了，故障在 storeboot 之后；
# 全黑 = 连 bootloader 都没跑。没有串口，这是唯一能区分两者的信号。

usage() { echo "usage: $0 source-package-dir output-dir" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
source_package=$1
out=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ampack=${AMPACK:-ampack}

for command in mcopy node sha256sum "$ampack"; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
for name in boot.PARTITION data.PARTITION; do
  [[ -s "$source_package/$name" ]] || { echo "source package lacks $name" >&2; exit 1; }
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/src"
package="$tmp/package"
mkdir -p "$package"

echo '01. 校验并复制原厂输入（bootloader 与 logo 逐字节原样）'
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION logo.PARTITION; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$root/board-inputs/$name" | sha256sum --check --status
  cp -- "$root/board-inputs/$name" "$package/$name"
done
# 摘要自洽 = 这份 BL2 没被动过；变体 A/B 是在这里被 MBR 改脏的。
node "$root/scripts/burn-image.mjs" check-bl2-seal "$package/bootloader.PARTITION" >/dev/null
cmp -s "$root/board-inputs/bootloader.PARTITION" "$package/bootloader.PARTITION"
[[ "$(node -e '
  const fs = require("fs");
  const image = fs.readFileSync(process.argv[1]);
  console.log(image.subarray(440, 512).every((byte) => byte === 0));
' "$package/bootloader.PARTITION")" == true ]] || {
  echo 'vendor bootloader sector 0 must stay zero-filled at 440..511' >&2
  exit 1
}

echo '02. 从源包的 FAT16 取出内核、initrd 和 DTB'
mcopy -n -i "$source_package/boot.PARTITION" ::Image.gz "$tmp/src/Image.gz"
mcopy -n -i "$source_package/boot.PARTITION" ::initrd.img "$tmp/src/initrd.img"
board_dtb=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).dtb)' \
  "$root/config/board.json")
mcopy -n -i "$source_package/boot.PARTITION" "::dtb/amlogic/$board_dtb" "$tmp/src/linux.dtb"
node "$root/scripts/burn-image.mjs" check-standalone-dtb "$tmp/src/linux.dtb" >/dev/null
# Image.gz 必须是 gzip：厂商 bootm 靠这个解压，裸 Image 会被当成非法镜像。
[[ "$(node -e '
  const image = require("fs").readFileSync(process.argv[1]);
  console.log(image[0] === 0x1f && image[1] === 0x8b);
' "$tmp/src/Image.gz")" == true ]] || { echo 'kernel is not gzip-compressed' >&2; exit 1; }

echo '03. 复制 rootfs 并取出它的 UUID'
cp -- "$source_package/data.PARTITION" "$package/data.PARTITION"
root_uuid=$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$package/data.PARTITION")
[[ "$root_uuid" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || {
  echo 'rootfs UUID is invalid' >&2
  exit 1
}

echo '04. 打 Android boot 镜像'
memory_limit=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).boot.memoryLimitMiB)' \
  "$root/config/mainline-boot.json")
cmdline=$(node "$root/scripts/burn-image.mjs" command-line "$memory_limit" "$root_uuid")
node "$root/scripts/burn-image.mjs" boot \
  "$tmp/src/Image.gz" "$tmp/src/initrd.img" "$tmp/src/linux.dtb" \
  "$package/boot.PARTITION" "$cmdline" > "$out/vendor-boot-contract.json"
node "$root/scripts/burn-image.mjs" check-boot-size "$package/boot.PARTITION" >/dev/null
node "$root/scripts/burn-image.mjs" check-boot-second "$package/boot.PARTITION" >/dev/null

echo '05. meson1.dtb 的 gxl_p211_1g 槽换成同一份 Linux DTB'
node "$root/scripts/burn-image.mjs" replace-linux-target-dtb \
  "$root/board-inputs/meson1.dtb" "$tmp/src/linux.dtb" "$package/meson1.dtb" \
  > "$out/burn-dtb-contract.json"
node "$root/scripts/burn-image.mjs" check-burn-dtb-roles \
  "$package/meson1.dtb" "$tmp/src/linux.dtb" >/dev/null

echo '06. 打包并自校验'
"$ampack" pack --verify "$package" "$out/burn.img" > "$out/ampack-pack.log"
"$ampack" verify "$out/burn.img" > "$out/ampack-verify.log"
burn_size=$(stat --format='%s' "$out/burn.img")
[[ "$burn_size" -lt 2147483648 ]] || {
  echo "burn.img exceeds the GitHub 2 GiB asset limit: $burn_size" >&2
  exit 1
}
node -e '
  const fs = require("fs");
  const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[1], `${JSON.stringify({
    schemaVersion: 1,
    // status 说的是这一份字节流：结构自洽。strategyVerifiedOn 说的是这套做法：
    // 已经有人拿它刷进真机并进了系统。两者不要混为一谈。
    status: "format-valid",
    strategy: "vendor-fip-vendor-bl33-android-boot",
    strategyVerifiedOn: "2026-09-01 B860AV1.1-T / Armbian 26.11.0 / 5.10.268-ophub",
    bootloader: "vendor byte-for-byte, no MBR, no FIP repack",
    rootUuid: process.argv[2],
    commandLine: process.argv[3],
    androidBoot: contract,
  }, null, 2)}\n`);
' "$out/vendor-boot-contract.json" "$root_uuid" "$cmdline"
(cd "$out" && sha256sum burn.img vendor-boot-contract.json burn-dtb-contract.json > SHA256SUMS)
echo "    burn.img=$burn_size bytes root=$root_uuid"
