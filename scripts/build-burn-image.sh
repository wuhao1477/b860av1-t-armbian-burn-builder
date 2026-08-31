#!/usr/bin/env bash
set -Eeuo pipefail

usage() { echo "usage: $0 raw-image.gz output-dir" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
raw=$1
out=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
metadata="$(dirname -- "$raw")/boot-components.json"
[[ -f "$raw" && -f "$metadata" ]] || { echo 'raw image or boot-components.json not found' >&2; exit 1; }

for command in blkid cargo fdtget git gzip jq losetup mcopy mformat mmd node sha256sum; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mkdir -p "$out"
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

node "$root/scripts/burn-image.mjs" prepare-kernel "$kernel" "$tmp/Image.gz" >/dev/null
cp -- "$initrd" "$tmp/initrd.img"
node "$root/scripts/burn-image.mjs" standalone-dtb \
  "$dtb" "$root/board-overlays/burn-partitions.dtso" "$tmp/linux.dtb" >/dev/null
node "$root/scripts/burn-image.mjs" check-standalone-dtb "$tmp/linux.dtb" >/dev/null
dtb_path="/dtb/amlogic/$board_dtb"
node "$root/scripts/mainline-boot.mjs" extlinux 1024 "$root_uuid" "$dtb_path" \
  > "$tmp/extlinux.conf"

package="$tmp/package"
mkdir -p "$package"
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
node "$root/scripts/burn-image.mjs" sparse \
  "$tmp/rootfs.ext4" "$package/data.PARTITION" "$root_size" >/dev/null
[[ "$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$package/data.PARTITION")" == "$root_uuid" ]] || {
  echo 'data.PARTITION UUID differs from the source root filesystem' >&2
  exit 1
}

# FIP 证据在下面嵌完 MBR 后才写，这里不复制 build-mainline-uboot.sh 的中间版本。
"$root/scripts/build-mainline-uboot.sh" "$tmp/mainline-uboot"
cp -- "$tmp/mainline-uboot/bootloader.PARTITION" "$package/bootloader.PARTITION"
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf meson1.dtb; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$root/board-inputs/$name" | sha256sum --check --status
  cp -- "$root/board-inputs/$name" "$package/$name"
done
# MBR 嵌进 bootloader.PARTITION 的 sector 0（446..511）。store 只认
# meson1.dtb /partitions 里的分区名，没有 "1"，独立的 1.PARTITION 必然被拒。
chmod u+w -- "$package/bootloader.PARTITION"
node "$root/scripts/burn-image.mjs" embed-dos-mbr \
  "$package/bootloader.PARTITION" "$fat_bytes" "$root_size" >/dev/null
node "$root/scripts/burn-image.mjs" check-burn-partitions "$package" >/dev/null
node "$root/scripts/burn-image.mjs" check-emmc-chain \
  "$package/bootloader.PARTITION" "$package/boot.PARTITION" "$package/data.PARTITION" \
  > "$out/emmc-boot-contract.json"
# 嵌 MBR 改了 FIP 的字节，证据必须按最终交付的那份重算，否则独立校验会
# 发现 published mainline-fip-contract.json 与解包结果不一致。BL2 摘要在
# fip-evidence 里按 446..511 清零后比对，仍能证明签名段未被改动。
node "$root/scripts/mainline-boot.mjs" fip-evidence \
  "$package/bootloader.PARTITION" "$tmp/mainline-uboot/components" \
  "$tmp/mainline-uboot/u-boot.raw.bin" > "$out/mainline-fip-contract.json"
jq --arg fipSha256 "$(sha256sum "$package/bootloader.PARTITION" | awk '{print $1}')" \
  '.fipSha256 = $fipSha256' "$tmp/mainline-uboot/u-boot-build.json" > "$out/u-boot-build.json"

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

ampack_src="$tmp/ampack-src"
mapfile -t ampack_source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ampack;
  console.log(value.repository); console.log(value.commit);
' "$root/config/burn-tooling.json")
git clone --quiet --filter=blob:none "${ampack_source[0]}" "$ampack_src"
git -C "$ampack_src" checkout --detach "${ampack_source[1]}" >/dev/null
[[ "$(git -C "$ampack_src" rev-parse HEAD)" == "${ampack_source[1]}" ]] || {
  echo 'ampack commit differs from the pinned source' >&2
  exit 1
}
cargo build --quiet --release --manifest-path "$ampack_src/Cargo.toml"
ampack="$ampack_src/target/release/ampack"
"$ampack" pack --verify "$package" "$out/burn.img" > "$out/ampack-pack.log"
"$ampack" verify "$out/burn.img" > "$out/ampack-verify.log"
burn_size=$(stat --format='%s' "$out/burn.img")
[[ "$burn_size" -lt 2147483648 ]] || {
  echo "burn.img exceeds the GitHub 2 GiB asset limit: $burn_size" >&2
  exit 1
}
node "$root/scripts/burn-image.mjs" report "$out/burn.img" "$raw" \
  "$out/emmc-boot-contract.json" "$out/mainline-fip-contract.json" \
  "$out/rootfs-contract.json" > "$out/burn-report.json"
(cd "$out" && sha256sum burn.img emmc-boot-contract.json mainline-fip-contract.json \
  rootfs-contract.json u-boot-build.json burn-report.json > SHA256SUMS)
