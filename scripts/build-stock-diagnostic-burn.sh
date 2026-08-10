#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 2 ]] || { echo "usage: $0 diagnostic-initramfs.cpio.gz output-dir" >&2; exit 2; }
initramfs=$1
out=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
[[ -f "$initramfs" ]] || { echo 'diagnostic initramfs not found' >&2; exit 1; }
mkdir -p "$out"

node "$root/scripts/burn-image.mjs" check-stock-diagnostic-inputs \
  "$root/board-inputs" "$root/config/burn-inputs.json" \
  > "$out/diagnostic-inputs-contract.json"
node "$root/scripts/burn-image.mjs" check-diagnostic-initramfs "$initramfs" \
  > "$out/diagnostic-initramfs-contract.json"

package="$tmp/package"
mkdir -p "$package"
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION meson1.dtb logo.PARTITION; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$root/board-inputs/$name" | sha256sum --check --status
  cp -- "$root/board-inputs/$name" "$package/$name"
done

node "$root/scripts/burn-image.mjs" check-stock-bootloader \
  "$package/bootloader.PARTITION" "$root/config/burn-inputs.json" \
  > "$out/stock-bootloader-contract.json"
node "$root/scripts/burn-image.mjs" replace-stock-ramdisk \
  "$root/board-inputs/stock-boot.PARTITION" "$initramfs" "$package/boot.PARTITION" >/dev/null
node "$root/scripts/burn-image.mjs" check-stock-diagnostic-boot \
  "$root/board-inputs/stock-boot.PARTITION" "$package/boot.PARTITION" \
  "$initramfs" "$root/config/burn-inputs.json" \
  > "$out/diagnostic-boot-contract.json"

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
[[ "$(git -C "$ampack" rev-parse HEAD)" == "${ampack_source[1]}" ]] || exit 1
cargo build --release --manifest-path "$ampack/Cargo.toml" >/dev/null
"$ampack/target/release/ampack" pack --verify "$package" "$out/burn.img" \
  > "$out/ampack-pack.log"
"$ampack/target/release/ampack" verify "$out/burn.img" > "$out/ampack-verify.log"
[[ "$(stat --format='%s' "$out/burn.img")" -lt 2147483648 ]] || {
  echo 'diagnostic burn.img exceeds the GitHub 2 GiB asset limit' >&2
  exit 1
}
