#!/usr/bin/env bash
set -Eeuo pipefail

# 从公开的 Armbian raw 镜像里做出两个直刷载荷：
#
#   boot.PARTITION   32 MiB FAT16，含 Image.gz / initrd.img / DTB / extlinux.conf
#   data.PARTITION   sparse ext4 rootfs（已经用 apply-rootfs-defaults.sh 预置成开箱即用）
#
# 这两个载荷与 bootloader 无关，变体 A（build-burn-image.sh）和变体 C
# （build-vendor-boot-burn.sh）都用它们，所以单独成一个脚本，避免 CI 为了拿载荷
# 去跑整套已经被实机证伪的主线 U-Boot 构建。
#
# 结果目录直接可以喂给 build-vendor-boot-burn.sh。stdout 是一行 JSON，给调用方
# 取 rootUuid / rootSizeBytes / fatBytes。

usage() { echo "usage: $0 raw-image.gz package-dir" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
raw=$1
package=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
metadata="$(dirname -- "$raw")/boot-components.json"
[[ -f "$raw" && -f "$metadata" ]] || { echo 'raw image or boot-components.json not found' >&2; exit 1; }

for command in blkid debugfs depmod fdtget gzip losetup mcopy mformat mmd node sha256sum; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mkdir -p "$package"
tmp=$(mktemp -d)
loop=''
root_mount="$tmp/root"
boot_mount="$tmp/source-boot"
cleanup() {
  set +e
  mountpoint -q "$root_mount" && sudo umount "$root_mount"
  mountpoint -q "$boot_mount" && sudo umount "$boot_mount"
  [[ -n "$loop" ]] && sudo losetup -d "$loop"
  rm -rf "$tmp"
}
trap cleanup EXIT

gzip -dc "$raw" > "$tmp/raw.img"
loop=$(sudo losetup --find --show --partscan "$tmp/raw.img")
sudo udevadm settle
mapfile -t parts < <(lsblk --noheadings --list --output NAME,TYPE "$loop" \
  | awk '$2 == "part" {print "/dev/" $1}')
[[ ${#parts[@]} -eq 2 ]] || { echo 'raw image must have exactly boot and root partitions' >&2; exit 1; }
boot_part=${parts[0]}
root_part=${parts[1]}
mkdir -p "$boot_mount" "$root_mount"
sudo mount -o ro "$boot_part" "$boot_mount"
sudo mount -o rw "$root_part" "$root_mount"

board_dtb=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).dtb)' \
  "$root/config/board.json")
mapfile -t components < <(node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const dtbPath = `dtb/amlogic/${process.argv[2]}`;
  const pick = (role, predicate) => {
    const matches = manifest.components.filter((item) => item.role === role && predicate(item.path));
    if (matches.length !== 1) throw new Error(`boot metadata must contain one ${role}`);
    const item = matches[0];
    if (typeof item.path !== "string" || item.path.startsWith("/") || item.path.split("/").includes("..")
        || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error(`${role} metadata is invalid`);
    console.log(item.path); console.log(item.sha256);
  };
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.components)) throw new Error("boot metadata is invalid");
  pick("kernel", () => true);
  pick("initrd", (value) => /^initrd\.img-[A-Za-z0-9._+~-]+$/.test(value));
  pick("dtb", (value) => value === dtbPath);
' "$metadata" "$board_dtb")
[[ ${#components[@]} -eq 6 ]] || { echo 'boot component selection failed' >&2; exit 1; }
kernel="$boot_mount/${components[0]}"
initrd="$boot_mount/${components[2]}"
dtb="$boot_mount/${components[4]}"
for index in 0 1 2; do
  path_index=$((index * 2))
  digest_index=$((path_index + 1))
  file=${components[$path_index]}
  printf '%s  %s\n' "${components[$digest_index]}" "$boot_mount/$file" \
    | sha256sum --check --status
done

root_uuid=$(sudo blkid --match-tag UUID --output value "$root_part" | tr '[:upper:]' '[:lower:]')
[[ "$root_uuid" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || {
  echo 'source root filesystem UUID is invalid' >&2
  exit 1
}
root_size=$(sudo blockdev --getsize64 "$root_part")
sudo sed -i '\@[[:space:]]/boot[[:space:]]@d' "$root_mount/etc/fstab" 2>/dev/null || true
"$root/scripts/apply-rootfs-defaults.sh" "$root_mount"

# 镜像里那颗内核的 release，下面复查 hcodec 模块要用。apply-rootfs-defaults.sh §7
# 已经断言过只有一颗，这里只是取名字。
kernel_release=$(basename -- "$(echo "$root_mount"/lib/modules/*/)")
hcodec_ko="/lib/modules/$kernel_release/extra/meson_hcodec.ko"

node "$root/scripts/burn-image.mjs" prepare-kernel "$kernel" "$tmp/Image.gz" >/dev/null
cp -- "$initrd" "$tmp/initrd.img"
node "$root/scripts/burn-image.mjs" standalone-dtb \
  "$dtb" "$root/board-overlays/burn-partitions.dtso" "$tmp/linux.dtb" >/dev/null
node "$root/scripts/burn-image.mjs" check-standalone-dtb "$tmp/linux.dtb" >/dev/null
dtb_path="/dtb/amlogic/$board_dtb"
node "$root/scripts/mainline-boot.mjs" extlinux 1024 "$root_uuid" "$dtb_path" \
  > "$tmp/extlinux.conf"

fat_bytes=$((32 * 1024 * 1024))
truncate --size="$fat_bytes" "$package/boot.PARTITION"
mformat -i "$package/boot.PARTITION" -N 00000000 -v BOOT ::
mmd -i "$package/boot.PARTITION" ::extlinux ::dtb ::dtb/amlogic
touch -d '1980-01-01 00:00:00 UTC' \
  "$tmp/Image.gz" "$tmp/initrd.img" "$tmp/linux.dtb" "$tmp/extlinux.conf"
mcopy -o -i "$package/boot.PARTITION" "$tmp/Image.gz" ::Image.gz
mcopy -o -i "$package/boot.PARTITION" "$tmp/initrd.img" ::initrd.img
mcopy -o -i "$package/boot.PARTITION" "$tmp/linux.dtb" "::dtb/amlogic/$board_dtb"
mcopy -o -i "$package/boot.PARTITION" "$tmp/extlinux.conf" ::extlinux/extlinux.conf
node "$root/scripts/burn-image.mjs" check-fat-boot "$package/boot.PARTITION" >/dev/null

sudo sync
sudo umount "$boot_mount"
sudo umount "$root_mount"
set +e
sudo e2fsck -pf "$root_part"
fsck_status=$?
set -e
[[ "$fsck_status" -le 1 ]] || { echo "root filesystem check failed: $fsck_status" >&2; exit 1; }
sudo dd if="$root_part" of="$tmp/rootfs.ext4" bs=4M status=none

# 预置项必须真的躺在要写进 eMMC 的那份 ext4 里，光看 apply-rootfs-defaults.sh 的
# 日志不算数：build-47.1 打印了「启用」、e2fsck 报干净，实机上两条 *.wants 符号
# 链接却都不见了（docs/known-issues.md 第 8 条）。所以在 dd 出来的镜像上用 debugfs
# 直接查，不挂载也不改字节。drop-in 是常规文件，缺了就让构建红；链接只打印，
# 它是不是又掉了留给下一次实机对照。
zram_dropin=/etc/systemd/system/sysinit.target.d/10-b860-armbian-zram-config.conf
expand_dropin=/etc/systemd/system/multi-user.target.d/10-b860-expand-rootfs.conf
mapfile -t vdec_blobs < <(node -e '
  const fs = require("fs");
  const spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).vdecFirmware;
  for (const file of Object.keys(spec.files)) console.log(`${spec.installPath}/${file}`);
' "$root/config/board.json")
for dropin in "$zram_dropin" "$expand_dropin" "${vdec_blobs[@]}" "$hcodec_ko"; do
  sudo debugfs -R "stat $dropin" "$tmp/rootfs.ext4" 2>&1 | grep -q '^Inode:' || {
    echo "drop-in is missing from the packaged rootfs: $dropin" >&2
    exit 1
  }
  echo "  rootfs: drop-in 已在包里 $dropin"
done
# 光有 .ko 不够：modprobe 靠 modules.dep 找它、也靠 modules.dep 先加载
# v4l2-mem2mem / videobuf2-dma-contig（ophub 内核里是 =m）。索引没重生成的话，
# 开机 systemd-modules-load 会静默失败，实机表现是「没有 /dev/videoN」。
hcodec_dep=$(sudo debugfs -R "cat /lib/modules/$kernel_release/modules.dep" \
  "$tmp/rootfs.ext4" 2>/dev/null | grep '^extra/meson_hcodec\.ko:' || true)
[[ "$hcodec_dep" == *v4l2-mem2mem.ko* && "$hcodec_dep" == *videobuf2-dma-contig.ko* ]] || {
  echo "modules.dep in the packaged rootfs does not resolve meson_hcodec: ${hcodec_dep:-<缺行>}" >&2
  exit 1
}
echo "  rootfs: modules.dep 已带上 meson_hcodec 及其两个依赖"
sudo debugfs -R 'ls -l /etc/systemd/system/sysinit.target.wants' "$tmp/rootfs.ext4" 2>/dev/null \
  | sed 's/^/  rootfs: sysinit.target.wants: /'

node "$root/scripts/burn-image.mjs" sparse \
  "$tmp/rootfs.ext4" "$package/data.PARTITION" "$root_size" >/dev/null
[[ "$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$package/data.PARTITION")" == "$root_uuid" ]] || {
  echo 'data.PARTITION UUID differs from the source root filesystem' >&2
  exit 1
}

node -e 'console.log(JSON.stringify({
  rootUuid: process.argv[1],
  rootSizeBytes: Number(process.argv[2]),
  fatBytes: Number(process.argv[3]),
  boardDtb: process.argv[4],
}))' "$root_uuid" "$root_size" "$fat_bytes" "$board_dtb"
