#!/usr/bin/env bash
set -Eeuo pipefail

usage() { echo "usage: $0 raw-image.gz output-dir" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
raw=$1
out=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

for command in cargo git jq node sha256sum; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

package="$tmp/package"
mkdir -p "$package"
"$root/scripts/build-burn-payloads.sh" "$raw" "$package" > "$tmp/payloads.json"
mapfile -t payload < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(value.rootSizeBytes);
  console.log(value.fatBytes);
' "$tmp/payloads.json")
root_size=${payload[0]}
fat_bytes=${payload[1]}

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
