#!/usr/bin/env bash
set -Eeuo pipefail

# ophub BL33 直刷包。与 build-burn-image.sh 的区别，以及为什么必须这样：
#
# 1. BL33 用 ophub 的 u-boot-s905x-s912.bin（U-Boot 2020.07 armbian-gxl），不是自编的
#    v2026.01。理由：/etc/ophub-release 给这块板指定 UBOOT_OVERLOAD='u-boot-s905x-s912.bin'，
#    而 s905_autoscript 用 `fatload ... 0x1000000; go 0x1000000` 链载它 —— 说明它就链接在
#    GXL 的 BL33 入口 0x1000000，且这台机器上跑过（U 盘装 Armbian 的那次）。
# 2. /boot 放进 ext4 rootfs 内部，MBR 只描述一个分区。理由：ophub 的 zImage 是裸 ARM64
#    Image（28.4 MiB）+ uInitrd（16.2 MiB）= 42.6 MiB，塞不进 32 MiB 的 Amlogic boot 分区；
#    而 booti 不解压 gzip，所以也不能退回 Image.gz。这份 U-Boot 的 boot_prefixes='/ /boot/'
#    会自己去找 /boot/extlinux/extlinux.conf，正好落在 rootfs 里。
# 3. extlinux.conf 里的路径必须带 /boot/ 前缀。理由：cmd/pxe_utils.c 的 get_bootfile_path()
#    对 `file_path[0]=='/' && !is_pxe` 直接返回空前缀，绝对路径按分区根解析。
# 4. MBR 嵌在 bootloader.PARTITION 的 sector 0（446..511）。理由：armbian-install 三条写
#    bootloader 的分支全是 `bs=1 count=444` + `bs=512 skip=1 seek=1`，且烧录工具送不到 eMMC
#    的 LBA 0，独立的 1.PARTITION 会被 store 拒绝。注意 446..511 确实落在 BL2 自身摘要覆盖的
#    [0x70,0xC000) 里，所以 embed-rootfs-mbr 之后必须重算并写回 0x50 的摘要，否则 bootrom
#    拒绝执行 BL2（实测整机全黑，只有电源灯）。embedRootfsMbr() 已经内置这一步。
#
# 启动链：bootrom -> 原厂签名 BL2/BL30/BL301/BL31 -> ophub BL33 -> distro_bootcmd
#         -> scan_dev_for_boot_part(mmc) -> sysboot /boot/extlinux/extlinux.conf
#         -> booti zImage + uInitrd + p212 DTB -> Debian rootfs

usage() { echo "usage: $0 raw-image[.gz|.xz] output-dir" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
raw=$1
out=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
gxlimg=${GXLIMG:-gxlimg}
ampack=${AMPACK:-ampack}

for command in blkid blockdev cmp dd e2fsck losetup mkimage node sha256sum "$gxlimg" "$ampack"; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
[[ -f "$raw" ]] || { echo "raw image not found: $raw" >&2; exit 1; }

tmp=$(mktemp -d)
boot_mount="$tmp/src-boot"
root_mount="$tmp/src-root"
loops=()
cleanup() {
  set +e
  mountpoint -q "$root_mount" && umount "$root_mount"
  mountpoint -q "$boot_mount" && umount "$boot_mount"
  for device in "${loops[@]}"; do losetup -d "$device"; done
  rm -rf "$tmp"
}
trap cleanup EXIT
mkdir -p "$out" "$boot_mount" "$root_mount"

echo '01. 解压并按 MBR 逐分区挂载'
# 要在 rootfs 里搬 /boot、改 fstab，所以必须是可写副本，不能直接挂原文件。
case "$raw" in
  *.gz) gzip -dc "$raw" > "$tmp/raw.img" ;;
  *.xz) xz -dc "$raw" > "$tmp/raw.img" ;;
  *) cp --reflink=auto -- "$raw" "$tmp/raw.img" ;;
esac
# OrbStack 内核 loop.max_part=0，--partscan 造不出 /dev/loopNpM，所以自己解析 MBR。
mapfile -t layout < <(node -e '
  const fs = require("node:fs");
  const descriptor = fs.openSync(process.argv[1], "r");
  const sector = Buffer.alloc(512);
  fs.readSync(descriptor, sector, 0, 512, 0);
  fs.closeSync(descriptor);
  if (sector.readUInt16LE(510) !== 0xaa55) throw new Error("source image has no MBR");
  for (let index = 0; index < 4; index += 1) {
    const offset = 446 + (index * 16);
    if (sector[offset + 4] === 0) continue;
    console.log(`${sector.readUInt32LE(offset + 8) * 512} ${sector.readUInt32LE(offset + 12) * 512}`);
  }
' "$tmp/raw.img")
[[ ${#layout[@]} -eq 2 ]] || { echo 'raw image must have exactly boot and root partitions' >&2; exit 1; }
for entry in "${layout[@]}"; do
  read -r offset length <<<"$entry"
  loops+=("$(losetup --find --show --offset "$offset" --sizelimit "$length" "$tmp/raw.img")")
done
mount -o ro "${loops[0]}" "$boot_mount"
mount -o rw "${loops[1]}" "$root_mount"
root_uuid=$(blkid -o value -s UUID "${loops[1]}" | tr '[:upper:]' '[:lower:]')
[[ "$root_uuid" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || {
  echo 'source root filesystem UUID is invalid' >&2
  exit 1
}
root_size=$(blockdev --getsize64 "${loops[1]}")
board_dtb=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).dtb)' \
  "$root/config/board.json")
echo "    root UUID=$root_uuid size=$root_size dtb=$board_dtb"

echo '02. 把 /boot 搬进 ext4 rootfs 并改写启动配置'
cp -a "$boot_mount/." "$root_mount/boot/"
# 只留启动真正要的东西：sparse 后要留在 2 GiB 的 GitHub 资产上限内。
rm -f "$root_mount"/boot/System.map-* "$root_mount/boot/boot.bmp"
rm -f "$root_mount"/boot/*.scr "$root_mount"/boot/*_autoscript "$root_mount"/boot/*.cmd
rm -f "$root_mount/boot/boot.ini" "$root_mount/boot/boot-emmc.ini"
rm -f "$root_mount/boot/extlinux/extlinux.conf.bak"
find "$root_mount/boot/dtb" -mindepth 1 -maxdepth 1 -type d ! -name amlogic -exec rm -rf {} +
find "$root_mount/boot/dtb/amlogic" -type f ! -name "$board_dtb" -delete
[[ -s "$root_mount/boot/dtb/amlogic/$board_dtb" ]] || { echo 'board DTB is missing' >&2; exit 1; }
for file in zImage uInitrd u-boot.ext; do
  [[ -s "$root_mount/boot/$file" ]] || { echo "boot file is missing: $file" >&2; exit 1; }
done
# fstab 里的 LABEL=BOOT vfat 必须删掉：这套布局没有独立 FAT boot 分区，留着会让
# systemd 在 local-fs.target 上卡死。
sed -i '\@^LABEL=BOOT@d' "$root_mount/etc/fstab"
grep -q '^LABEL=BOOT' "$root_mount/etc/fstab" && { echo 'fstab still mounts /boot' >&2; exit 1; }

append="root=UUID=$root_uuid rootflags=data=writeback rw rootwait rootfstype=ext4"
append+=" console=ttyAML0,115200n8 console=tty0 no_console_suspend consoleblank=0"
append+=" fsck.fix=yes fsck.repair=yes net.ifnames=0 max_loop=128 loglevel=7"
append+=" voutmode=hdmi disablehpd=false overscan=100 sdrmode=auto"
append+=" video=HDMI-A-1:1920x1080@60e plymouth.enable=0 mem=1024M"
mkdir -p "$root_mount/boot/extlinux"
# 路径必须带 /boot/：sysboot 把绝对路径按分区根解析（cmd/pxe_utils.c）。
cat > "$root_mount/boot/extlinux/extlinux.conf" <<EOF
TIMEOUT 10
DEFAULT Armbian

LABEL Armbian
    KERNEL /boot/zImage
    INITRD /boot/uInitrd
    FDT /boot/dtb/amlogic/$board_dtb
    APPEND $append
EOF
node "$root/scripts/burn-image.mjs" check-extlinux-rootfs \
  "$root_mount/boot/extlinux/extlinux.conf" "$root_uuid" "$board_dtb" >/dev/null

# 二级兜底：extlinux 若失败，U-Boot 会打印 "SCRIPT FAILED: continuing..." 然后在同一个
# prefix 下找 boot.scr。ophub 那份是 SD 版（fatload mmc 0，路径不带 /boot/），对这套布局
# 没用，所以自己生成一份。devnum/distro_bootpart 由 distro_bootcmd 设好。
command -v mkimage >/dev/null || { echo 'mkimage is required' >&2; exit 1; }
cat > "$tmp/boot.cmd" <<EOF
echo "b860 ext4 fallback boot"
setenv bootargs "$append"
if load \${devtype} \${devnum}:\${distro_bootpart} \${kernel_addr_r} /boot/zImage; then
  if load \${devtype} \${devnum}:\${distro_bootpart} \${ramdisk_addr_r} /boot/uInitrd; then
    if load \${devtype} \${devnum}:\${distro_bootpart} \${fdt_addr_r} /boot/dtb/amlogic/$board_dtb; then
      fdt addr \${fdt_addr_r}
      booti \${kernel_addr_r} \${ramdisk_addr_r} \${fdt_addr_r}
    fi
  fi
fi
echo "b860 fallback boot failed"
EOF
SOURCE_DATE_EPOCH=0 mkimage -C none -A arm64 -T script -n b860-ext4-boot \
  -d "$tmp/boot.cmd" "$root_mount/boot/boot.scr" >/dev/null

echo '03. 取出 ophub BL33，卸载后做 sparse'
# u-boot.ext 就是 /etc/ophub-release 的 UBOOT_OVERLOAD，这台机器上跑过的那份。
cp -- "$root_mount/boot/u-boot.ext" "$tmp/bl33.raw.bin"
sync
umount "$root_mount"
umount "$boot_mount"
set +e
e2fsck -pf "${loops[1]}"
fsck_status=$?
set -e
[[ "$fsck_status" -le 1 ]] || { echo "root filesystem check failed: $fsck_status" >&2; exit 1; }
package="$tmp/package"
mkdir -p "$package"
dd if="${loops[1]}" of="$tmp/rootfs.ext4" bs=4M status=none
node "$root/scripts/burn-image.mjs" sparse \
  "$tmp/rootfs.ext4" "$package/data.PARTITION" "$root_size" >/dev/null
[[ "$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$package/data.PARTITION")" == "$root_uuid" ]] || {
  echo 'data.PARTITION UUID differs from the source root filesystem' >&2
  exit 1
}

echo '04. 用 ophub BL33 换掉原厂 FIP 里的 Android BL33'
stock_fip="$root/board-inputs/bootloader.PARTITION"
mapfile -t stock_digest < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stockFip;
  console.log(value.sha256);
  for (const name of ["bl2", "bl30", "bl301", "bl31", "bl33"]) console.log(value.components[name]);
' "$root/config/mainline-boot.json")
[[ ${#stock_digest[@]} -eq 6 ]] || { echo 'stock FIP recipe is incomplete' >&2; exit 1; }
printf '%s  %s\n' "${stock_digest[0]}" "$stock_fip" | sha256sum --check --status
stock_components="$tmp/stock-components"
mkdir -p "$stock_components"
"$gxlimg" -e "$stock_fip" "$stock_components"
index=1
for file in bl2.sign bl30.enc bl301.enc bl31.enc bl33.enc; do
  printf '%s  %s\n' "${stock_digest[$index]}" "$stock_components/$file" | sha256sum --check --status
  index=$((index + 1))
done
"$gxlimg" -t bl3x -c "$tmp/bl33.raw.bin" "$tmp/bl33.enc"
"$gxlimg" -t fip --bl2 "$stock_components/bl2.sign" --bl30 "$stock_components/bl30.enc" \
  --bl301 "$stock_components/bl301.enc" --bl31 "$stock_components/bl31.enc" \
  --bl33 "$tmp/bl33.enc" "$package/bootloader.PARTITION"
fip_size=$(stat --format='%s' "$package/bootloader.PARTITION")
[[ "$fip_size" -gt 0 && "$fip_size" -le 4194304 ]] || {
  echo "FIP does not fit the 4 MiB bootloader partition: $fip_size" >&2
  exit 1
}

echo '05. 嵌单分区 MBR、补齐烧录工具输入、出证据'
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf meson1.dtb; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$root/board-inputs/$name" | sha256sum --check --status
  cp -- "$root/board-inputs/$name" "$package/$name"
done
chmod u+w -- "$package/bootloader.PARTITION"
node "$root/scripts/burn-image.mjs" embed-rootfs-mbr \
  "$package/bootloader.PARTITION" "$root_size" >/dev/null
node "$root/scripts/burn-image.mjs" check-ophub-partitions "$package" >/dev/null
# 证据必须按最终交付的那份 FIP 解包重算：嵌 MBR 改了 BL2 的 446..511，
# check-ophub-chain 会把那 66 字节清零后比对原厂摘要。
components="$tmp/final-components"
mkdir -p "$components"
"$gxlimg" -e "$package/bootloader.PARTITION" "$components"
"$gxlimg" -t bl3x -d "$components/bl33.enc" "$tmp/bl33.roundtrip.bin"
# gxlimg 的 bl3x 编码把载荷补齐到块边界，解回来会比原文件长；只比前缀。
bl33_bytes=$(stat --format='%s' "$tmp/bl33.raw.bin")
[[ "$(stat --format='%s' "$tmp/bl33.roundtrip.bin")" -ge "$bl33_bytes" ]] || {
  echo 'decoded BL33 is shorter than the ophub u-boot.ext' >&2
  exit 1
}
cmp -n "$bl33_bytes" -- "$tmp/bl33.raw.bin" "$tmp/bl33.roundtrip.bin"
node "$root/scripts/burn-image.mjs" check-ophub-chain \
  "$package/bootloader.PARTITION" "$package/data.PARTITION" "$components" \
  "$tmp/bl33.raw.bin" > "$out/ophub-boot-contract.json"
mapfile -t capacity < <(node -e '
  const board = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const boot = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
  console.log(board.storageCapacityBytes);
  console.log(boot.root.startMiB);
  console.log(board.storageSafetyMarginBytes);
' "$root/config/board.json" "$root/config/mainline-boot.json")
node "$root/scripts/burn-image.mjs" check-sparse-capacity \
  "$package/data.PARTITION" "${capacity[0]}" "${capacity[1]}" "${capacity[2]}" \
  > "$out/rootfs-contract.json"

echo '06. 打包并自校验'
"$ampack" pack --verify "$package" "$out/burn.img" > "$out/ampack-pack.log"
"$ampack" verify "$out/burn.img" > "$out/ampack-verify.log"
burn_size=$(stat --format='%s' "$out/burn.img")
[[ "$burn_size" -lt 2147483648 ]] || {
  echo "burn.img exceeds the GitHub 2 GiB asset limit: $burn_size" >&2
  exit 1
}
(cd "$out" && sha256sum burn.img ophub-boot-contract.json rootfs-contract.json > SHA256SUMS)
echo "    burn.img=$burn_size bytes fip=$fip_size bytes"
