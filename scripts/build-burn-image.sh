#!/usr/bin/env bash
set -Eeuo pipefail

usage() { echo "usage: $0 raw-image.gz output-dir" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
raw=$1
out=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ -f "$raw" ]] || { echo 'raw image not found' >&2; exit 1; }

mkdir -p "$out"
tmp=$(mktemp -d)
loop=''
root_mount="$tmp/root"
boot_mount="$tmp/boot"
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
mapfile -t parts < <(lsblk --noheadings --list --output NAME,TYPE "$loop" | awk '$2 == "part" {print "/dev/" $1}')
[[ ${#parts[@]} -ge 2 ]] || { echo 'raw image must have boot and root partitions' >&2; exit 1; }
boot_part=${parts[0]}
root_part=${parts[1]}
mkdir -p "$boot_mount" "$root_mount"
sudo mount -o ro "$boot_part" "$boot_mount"
sudo mount -o rw "$root_part" "$root_mount"

board_dtb=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/board.json')).dtb)")
mapfile -t kernel_candidates < <(find "$boot_mount" -type f \( -name Image.gz -o -name Image -o -name zImage \) | sort)
mapfile -t initrd_candidates < <(find "$boot_mount" -type f -name 'initrd.img-*' | sort)
mapfile -t dtb_candidates < <(find "$boot_mount" -type f -name "$board_dtb" | sort)
kernel=$(node "$root/scripts/burn-image.mjs" select-kernel "${kernel_candidates[@]}")
initrd=$(node "$root/scripts/burn-image.mjs" select-initrd "${initrd_candidates[@]}")
dtb=$(node "$root/scripts/burn-image.mjs" select-dtb "$board_dtb" "${dtb_candidates[@]}")
[[ -n "$kernel" && -n "$initrd" && -n "$dtb" ]] || {
  echo 'boot partition lacks the active B860 kernel, raw initrd, or P212 DTB' >&2
  exit 1
}
node "$root/scripts/burn-image.mjs" prepare-kernel "$kernel" "$tmp/kernel" >/dev/null
cp -- "$initrd" "$tmp/initrd"
cp -- "$dtb" "$tmp/linux.source.dtb"
node "$root/scripts/burn-image.mjs" standalone-dtb \
  "$tmp/linux.source.dtb" "$root/board-overlays/burn-partitions.dtso" \
  "$tmp/linux.dtb" >/dev/null
node "$root/scripts/burn-image.mjs" check-standalone-dtb "$tmp/linux.dtb" >/dev/null

root_uuid=$(sudo blkid --match-tag UUID --output value "$root_part")
sudo sed -i '/^[[:space:]]*LABEL=BOOT[[:space:]]/d' "$root_mount/etc/fstab" 2>/dev/null || true
memory_limit=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/board.json')).memoryLimitMiB)")
cmdline=$(node "$root/scripts/burn-image.mjs" command-line "$memory_limit" "$root_uuid")

root_size=$(sudo blockdev --getsize64 "$root_part")
sudo umount "$boot_mount"
sudo umount "$root_mount"
sudo e2fsck -pf "$root_part" || true
sudo dd if="$root_part" of="$tmp/rootfs.ext4" bs=4M status=none

package="$tmp/package"
mkdir -p "$package"
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION meson1.dtb; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$root/board-inputs/$name" | sha256sum --check --status
  cp -- "$root/board-inputs/$name" "$package/$name"
done

node "$root/scripts/burn-image.mjs" replace-linux-target-dtb \
  "$package/meson1.dtb" "$tmp/linux.dtb" "$tmp/meson1.hybrid.dtb" >/dev/null
mv -- "$tmp/meson1.hybrid.dtb" "$package/meson1.dtb"
node "$root/scripts/burn-image.mjs" check-burn-dtb-roles \
  "$package/meson1.dtb" "$tmp/linux.dtb" > "$out/dtb-contract.json"
node "$root/scripts/burn-image.mjs" boot "$tmp/kernel" "$tmp/initrd" \
  "$tmp/linux.dtb" "$package/boot.PARTITION" "$cmdline" >/dev/null
node "$root/scripts/burn-image.mjs" check-stock-boot \
  "$package/boot.PARTITION" "$root_uuid" > "$out/boot-contract.json"
node "$root/scripts/burn-image.mjs" check-dtb-pair \
  "$package/boot.PARTITION" "$tmp/linux.dtb" >/dev/null

node "$root/scripts/burn-image.mjs" sparse "$tmp/rootfs.ext4" \
  "$package/data.PARTITION" "$root_size" >/dev/null
[[ "$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$package/data.PARTITION")" == "$root_uuid" ]] || {
  echo 'data.PARTITION UUID differs from the source root filesystem' >&2
  exit 1
}
mapfile -t capacity < <(node -e '
  const fs = require("fs");
  const board = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const dtb = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  console.log(board.storageCapacityBytes);
  console.log(dtb.layoutMiB.data);
  console.log(board.storageSafetyMarginBytes);
' "$root/config/board.json" "$out/dtb-contract.json")
[[ ${#capacity[@]} -eq 3 ]] || { echo 'burn capacity inputs are incomplete' >&2; exit 1; }
node "$root/scripts/burn-image.mjs" check-sparse-capacity \
  "$package/data.PARTITION" "${capacity[0]}" "${capacity[1]}" "${capacity[2]}" \
  > "$out/rootfs-contract.json"

tmp_ampack="$tmp/ampack-src"
mapfile -t ampack_source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ampack;
  console.log(value.repository);
  console.log(value.commit);
' "$root/config/burn-tooling.json")
[[ ${#ampack_source[@]} -eq 2 && "${ampack_source[1]}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'ampack source contract is invalid' >&2
  exit 1
}
git clone --filter=blob:none "${ampack_source[0]}" "$tmp_ampack" >/dev/null
git -C "$tmp_ampack" checkout --detach "${ampack_source[1]}" >/dev/null
[[ "$(git -C "$tmp_ampack" rev-parse HEAD)" == "${ampack_source[1]}" ]] || {
  echo 'ampack commit differs from the pinned source' >&2
  exit 1
}
command -v cargo >/dev/null || { echo 'cargo is required' >&2; exit 1; }
cargo build --release --manifest-path "$tmp_ampack/Cargo.toml" >/dev/null
"$tmp_ampack/target/release/ampack" pack --verify "$package" "$out/burn.img" > "$out/ampack-pack.log"
"$tmp_ampack/target/release/ampack" verify "$out/burn.img" > "$out/ampack-verify.log"
burn_size=$(stat --format='%s' "$out/burn.img")
[[ "$burn_size" -lt 2147483648 ]] || {
  echo "burn.img exceeds the GitHub 2 GiB asset limit: $burn_size" >&2
  exit 1
}
node "$root/scripts/burn-image.mjs" report "$out/burn.img" "$raw" \
  "$out/boot-contract.json" "$out/dtb-contract.json" "$out/rootfs-contract.json" \
  > "$out/burn-report.json"
(cd "$out" && sha256sum burn.img boot-contract.json dtb-contract.json \
  rootfs-contract.json burn-report.json > SHA256SUMS)
