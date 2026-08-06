#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 burn.img" >&2; exit 2; }
image=$1; tmp=$(mktemp -d)
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cleanup() { rm -rf "$tmp"; }; trap cleanup EXIT
ampack="$tmp/ampack-src"
git clone --filter=blob:none --depth=1 https://github.com/7Ji/ampack.git "$ampack" >/dev/null
cargo build --release --manifest-path "$ampack/Cargo.toml" >/dev/null
"$ampack/target/release/ampack" verify "$image" >/dev/null
"$ampack/target/release/ampack" unpack "$image" "$tmp/unpack" >/dev/null
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf bootloader.PARTITION boot.PARTITION data.PARTITION meson1.dtb; do
  [[ -s "$tmp/unpack/$name" ]] || { echo "missing $name" >&2; exit 1; }
done
node "$root/scripts/burn-image.mjs" check-standalone-dtb "$tmp/unpack/meson1.dtb" >/dev/null
root_uuid=$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$tmp/unpack/data.PARTITION")
node "$root/scripts/burn-image.mjs" check-stock-boot "$tmp/unpack/boot.PARTITION" "$root_uuid" >/dev/null
node "$root/scripts/burn-image.mjs" check-dtb-pair "$tmp/unpack/boot.PARTITION" "$tmp/unpack/meson1.dtb" >/dev/null
magic=$(od -An -tx4 -j8 -N4 "$image" | tr -d ' ')
[[ "$magic" == 27b51956 ]] || { echo "unexpected Amlogic v2 version magic: $magic" >&2; exit 1; }
file "$tmp/unpack/data.PARTITION" | grep -q 'Android sparse' || { echo 'data.PARTITION is not sparse' >&2; exit 1; }
echo 'format-valid / hardware-unverified'
