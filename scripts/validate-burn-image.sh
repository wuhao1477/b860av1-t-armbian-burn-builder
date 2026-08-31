#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 3 ]] || { echo "usage: $0 burn.img burn-report.json raw-image.gz" >&2; exit 2; }
image=$1
report=$2
raw=$3
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ -f "$image" && -f "$report" && -f "$raw" ]] || {
  echo 'burn validation input is missing' >&2
  exit 1
}
tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

checkout_exact() {
  local repository=$1 commit=$2 directory=$3
  mkdir -p "$directory"
  git -C "$directory" init --quiet
  git -C "$directory" remote add origin "$repository"
  git -C "$directory" fetch --quiet --depth 1 origin "$commit"
  git -C "$directory" checkout --detach FETCH_HEAD >/dev/null
  [[ "$(git -C "$directory" rev-parse HEAD)" == "$commit" ]] || {
    echo "source checkout differs: $repository" >&2
    exit 1
  }
}

mapfile -t ampack_source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ampack;
  console.log(value.repository); console.log(value.commit);
' "$root/config/burn-tooling.json")
ampack_src="$tmp/ampack"
checkout_exact "${ampack_source[0]}" "${ampack_source[1]}" "$ampack_src"
cargo build --quiet --release --manifest-path "$ampack_src/Cargo.toml"
ampack="$ampack_src/target/release/ampack"
"$ampack" verify "$image" >/dev/null
"$ampack" unpack "$image" "$tmp/unpack" >/dev/null

for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION boot.PARTITION data.PARTITION meson1.dtb; do
  [[ -s "$tmp/unpack/$name" ]] || { echo "missing $name" >&2; exit 1; }
done
# 1.PARTITION 一并禁掉：store 按 meson1.dtb 的分区名查表，没有 "1" 这一项，
# 烧录会停在 [0x30402004]UBOOT/烧录分区 1/初始化分区/命令结果返回错误。
for name in 1.PARTITION env.PARTITION system.PARTITION vendor.PARTITION recovery.PARTITION \
  cache.PARTITION logo.PARTITION crypt.PARTITION misc.PARTITION; do
  [[ ! -e "$tmp/unpack/$name" ]] || {
    echo "prohibited Android partition payload: $name" >&2
    exit 1
  }
done
node "$root/scripts/burn-image.mjs" check-burn-partitions "$tmp/unpack" >/dev/null
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf meson1.dtb; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$tmp/unpack/$name" | sha256sum --check --status
done

root_uuid=$(node "$root/scripts/burn-image.mjs" sparse-ext4-uuid "$tmp/unpack/data.PARTITION")
node "$root/scripts/burn-image.mjs" check-emmc-chain \
  "$tmp/unpack/bootloader.PARTITION" "$tmp/unpack/boot.PARTITION" \
  "$tmp/unpack/data.PARTITION" > "$tmp/emmc-boot-contract.json"
[[ "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$tmp/emmc-boot-contract.json')).rootUuid)")" == "$root_uuid" ]] || {
  echo 'eMMC boot contract UUID differs from data.PARTITION' >&2
  exit 1
}
mcopy -i "$tmp/unpack/boot.PARTITION" \
  ::dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb "$tmp/linux.dtb"
node "$root/scripts/burn-image.mjs" check-standalone-dtb "$tmp/linux.dtb" >/dev/null
file "$tmp/unpack/data.PARTITION" | grep -q 'Android sparse' || {
  echo 'data.PARTITION is not Android sparse ext4' >&2
  exit 1
}

stock_fip_sha=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).stockFip.sha256)' \
  "$root/config/mainline-boot.json")
[[ "$(sha256sum "$tmp/unpack/bootloader.PARTITION" | awk '{print $1}')" != "$stock_fip_sha" ]] || {
  echo 'bootloader.PARTITION still contains the Android vendor BL33' >&2
  exit 1
}
mapfile -t gxlimg_source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).gxlimg;
  console.log(value.repository); console.log(value.commit);
' "$root/config/mainline-boot.json")
gxlimg_src="$tmp/gxlimg"
checkout_exact "${gxlimg_source[0]}" "${gxlimg_source[1]}" "$gxlimg_src"
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
make -C "$gxlimg_src" -j"$jobs" >/dev/null
mkdir "$tmp/components"
"$gxlimg_src/gxlimg" -e "$tmp/unpack/bootloader.PARTITION" "$tmp/components"
"$gxlimg_src/gxlimg" -t bl3x -d "$tmp/components/bl33.enc" "$tmp/u-boot.raw.bin"
node "$root/scripts/mainline-boot.mjs" fip-evidence \
  "$tmp/unpack/bootloader.PARTITION" "$tmp/components" "$tmp/u-boot.raw.bin" \
  > "$tmp/mainline-fip-contract.json"
node "$root/scripts/mainline-boot.mjs" check-evidence \
  "$tmp/mainline-fip-contract.json" >/dev/null
node -e '
  const fs = require("fs");
  const boot = fs.readFileSync(process.argv[1]);
  if (boot.includes(Buffer.from("ANDROID!"))) throw new Error("boot.PARTITION contains ANDROID!");
  const text = fs.readFileSync(process.argv[2], "latin1");
  for (const marker of ["storeboot", "imgread", "boot_android"]) {
    if (text.includes(marker)) throw new Error(`decrypted BL33 contains ${marker}`);
  }
' "$tmp/unpack/boot.PARTITION" "$tmp/u-boot.raw.bin"

mapfile -t capacity < <(node -e '
  const board = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const boot = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
  console.log(board.storageCapacityBytes);
  console.log(boot.root.startMiB);
  console.log(board.storageSafetyMarginBytes);
' "$root/config/board.json" "$root/config/mainline-boot.json")
node "$root/scripts/burn-image.mjs" check-sparse-capacity \
  "$tmp/unpack/data.PARTITION" "${capacity[0]}" "${capacity[1]}" "${capacity[2]}" \
  > "$tmp/rootfs-contract.json"

report_dir=$(cd -- "$(dirname -- "$report")" && pwd)
for name in emmc-boot-contract.json mainline-fip-contract.json rootfs-contract.json; do
  cmp --silent "$report_dir/$name" "$tmp/$name" || {
    echo "published $name differs from the unpacked burn image" >&2
    exit 1
  }
done
node "$root/scripts/burn-image.mjs" check-report "$report" "$image" "$raw" \
  "$tmp/emmc-boot-contract.json" "$tmp/mainline-fip-contract.json" \
  "$tmp/rootfs-contract.json" >/dev/null
magic=$(od -An -tx4 -j8 -N4 "$image" | tr -d ' ')
[[ "$magic" == 27b51956 ]] || {
  echo "unexpected Amlogic v2 version magic: $magic" >&2
  exit 1
}
echo 'format-valid / hardware-unverified'
