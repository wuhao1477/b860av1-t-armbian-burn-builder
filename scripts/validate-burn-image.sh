#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 3 ]] || { echo "usage: $0 burn.img burn-report.json raw-image.gz" >&2; exit 2; }
image=$1
report=$2
raw=$3
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
[[ -f "$image" && -f "$report" && -f "$raw" ]] || { echo 'burn validation input is missing' >&2; exit 1; }
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

ampack="$tmp/ampack-src"
mapfile -t ampack_source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ampack;
  console.log(value.repository);
  console.log(value.commit);
' "$root/config/burn-tooling.json")
[[ ${#ampack_source[@]} -eq 2 && "${ampack_source[1]}" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'ampack source contract is invalid' >&2
  exit 1
}
git clone --filter=blob:none "${ampack_source[0]}" "$ampack" >/dev/null
git -C "$ampack" checkout --detach "${ampack_source[1]}" >/dev/null
[[ "$(git -C "$ampack" rev-parse HEAD)" == "${ampack_source[1]}" ]] || {
  echo 'ampack commit differs from the pinned source' >&2
  exit 1
}
cargo build --release --manifest-path "$ampack/Cargo.toml" >/dev/null
"$ampack/target/release/ampack" verify "$image" >/dev/null
"$ampack/target/release/ampack" unpack "$image" "$tmp/unpack" >/dev/null

for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION boot.PARTITION data.PARTITION meson1.dtb; do
  [[ -s "$tmp/unpack/$name" ]] || { echo "missing $name" >&2; exit 1; }
done
for legacy in 1.PARTITION env.PARTITION system.PARTITION; do
  [[ ! -e "$tmp/unpack/$legacy" ]] || { echo "unsupported legacy eMMC payload: $legacy" >&2; exit 1; }
done
for name in vendor.PARTITION recovery.PARTITION cache.PARTITION; do
  [[ ! -e "$tmp/unpack/$name" ]] || { echo "prohibited Android partition payload: $name" >&2; exit 1; }
done

for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf bootloader.PARTITION; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$tmp/unpack/$name" | sha256sum --check --status
done
vendor_source="$tmp/vendor-meson1.dtb"
cp -- "$root/board-inputs/meson1.dtb" "$vendor_source"
expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['meson1.dtb'])")
printf '%s  %s\n' "$expected" "$vendor_source" | sha256sum --check --status

root_uuid=$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$tmp/unpack/data.PARTITION")
node "$root/scripts/burn-image.mjs" check-stock-boot \
  "$tmp/unpack/boot.PARTITION" "$root_uuid" > "$tmp/boot-contract.json"
node "$root/scripts/burn-image.mjs" extract-boot-second \
  "$tmp/unpack/boot.PARTITION" "$tmp/linux.dtb" >/dev/null
node "$root/scripts/burn-image.mjs" check-dtb-pair \
  "$tmp/unpack/boot.PARTITION" "$tmp/linux.dtb" >/dev/null
node "$root/scripts/burn-image.mjs" replace-linux-target-dtb \
  "$vendor_source" "$tmp/linux.dtb" "$tmp/expected-meson1.dtb" >/dev/null
cmp -- "$tmp/expected-meson1.dtb" "$tmp/unpack/meson1.dtb"
node "$root/scripts/burn-image.mjs" check-burn-dtb-roles \
  "$tmp/unpack/meson1.dtb" "$tmp/linux.dtb" > "$tmp/dtb-contract.json"

mapfile -t capacity < <(node -e '
  const fs = require("fs");
  const board = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const dtb = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  console.log(board.storageCapacityBytes);
  console.log(dtb.layoutMiB.data);
  console.log(board.storageSafetyMarginBytes);
' "$root/config/board.json" "$tmp/dtb-contract.json")
[[ ${#capacity[@]} -eq 3 ]] || { echo 'burn capacity inputs are incomplete' >&2; exit 1; }
node "$root/scripts/burn-image.mjs" check-sparse-capacity \
  "$tmp/unpack/data.PARTITION" "${capacity[0]}" "${capacity[1]}" "${capacity[2]}" \
  > "$tmp/rootfs-contract.json"
file "$tmp/unpack/data.PARTITION" | grep -q 'Android sparse' || {
  echo 'data.PARTITION is not sparse' >&2
  exit 1
}

report_dir=$(cd -- "$(dirname -- "$report")" && pwd)
for name in boot-contract.json dtb-contract.json rootfs-contract.json; do
  cmp --silent "$report_dir/$name" "$tmp/$name" || { echo "published $name differs from unpacked image" >&2; exit 1; }
done
node "$root/scripts/burn-image.mjs" check-report "$report" "$image" "$raw" \
  "$tmp/boot-contract.json" "$tmp/dtb-contract.json" "$tmp/rootfs-contract.json" >/dev/null
magic=$(od -An -tx4 -j8 -N4 "$image" | tr -d ' ')
[[ "$magic" == 27b51956 ]] || { echo "unexpected Amlogic v2 version magic: $magic" >&2; exit 1; }
echo 'format-valid / hardware-unverified'
