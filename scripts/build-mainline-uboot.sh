#!/usr/bin/env bash
set -Eeuo pipefail

usage() { echo "usage: $0 output-dir root-uuid fit-bytes" >&2; exit 2; }
[[ $# -eq 3 ]] || usage
out=$1
root_uuid=$2
fit_bytes=$3
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
recipe="$root/config/mainline-boot.json"
cross=${CROSS_COMPILE:-aarch64-linux-gnu-}
tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$out"

for command in git jq make node sha256sum "${cross}gcc"; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mapfile -t source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const item of [
    value.uboot.repository, value.uboot.commit, value.uboot.defconfig,
    value.uboot.patch.path, value.uboot.patch.sha256,
    value.uboot.emmcPatch.path, value.uboot.emmcPatch.sha256,
    value.gxlimg.repository, value.gxlimg.commit,
    value.stockFip.path, value.stockFip.sha256,
  ]) console.log(item);
' "$recipe")
[[ ${#source[@]} -eq 11 ]] || { echo 'mainline boot recipe is incomplete' >&2; exit 1; }
uboot_repo=${source[0]}
uboot_commit=${source[1]}
defconfig=${source[2]}
patch_path="$root/${source[3]}"
patch_sha=${source[4]}
emmc_patch_path="$root/${source[5]}"
emmc_patch_sha=${source[6]}
gxlimg_repo=${source[7]}
gxlimg_commit=${source[8]}
stock_fip="$root/${source[9]}"
stock_sha=${source[10]}

printf '%s  %s\n' "$patch_sha" "$patch_path" | sha256sum --check --status
printf '%s  %s\n' "$emmc_patch_sha" "$emmc_patch_path" | sha256sum --check --status
printf '%s  %s\n' "$stock_sha" "$stock_fip" | sha256sum --check --status

checkout_exact() {
  local repository=$1 commit=$2 directory=$3
  mkdir -p "$directory"
  git -C "$directory" init --quiet
  git -C "$directory" remote add origin "$repository"
  git -C "$directory" fetch --quiet --depth 1 origin "$commit"
  git -C "$directory" checkout --quiet --detach FETCH_HEAD
  [[ "$(git -C "$directory" rev-parse HEAD)" == "$commit" ]] || {
    echo "source checkout differs: $repository" >&2
    exit 1
  }
}

uboot_src="$tmp/u-boot"
uboot_build="$tmp/u-boot-build"
checkout_exact "$uboot_repo" "$uboot_commit" "$uboot_src"
git -C "$uboot_src" apply --check "$patch_path"
git -C "$uboot_src" apply "$patch_path"
git -C "$uboot_src" apply --check "$emmc_patch_path"
git -C "$uboot_src" apply "$emmc_patch_path"
make -C "$uboot_src" O="$uboot_build" CROSS_COMPILE="$cross" "$defconfig"
boot_command=$(node "$root/scripts/mainline-boot.mjs" boot-command "$root_uuid" "$fit_bytes")
"$uboot_src/scripts/config" --file "$uboot_build/.config" \
  --enable ENV_IS_NOWHERE \
  --enable VIDEO \
  --enable VIDEO_MESON \
  --enable VIDEO_DT_SIMPLEFB \
  --set-str BOOTCOMMAND "$boot_command" \
  --set-val BOOTDELAY 0
make -C "$uboot_src" O="$uboot_build" CROSS_COMPILE="$cross" olddefconfig

grep -qx 'CONFIG_ENV_IS_NOWHERE=y' "$uboot_build/.config" || {
  echo 'mainline U-Boot must ignore the stock persistent environment' >&2
  exit 1
}
for option in CONFIG_VIDEO CONFIG_VIDEO_MESON CONFIG_VIDEO_DT_SIMPLEFB; do
  grep -qx "$option=y" "$uboot_build/.config" || {
    echo "mainline U-Boot HDMI option is not enabled: $option" >&2
    exit 1
  }
done

jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
SOURCE_DATE_EPOCH=0 KBUILD_BUILD_USER=github-actions KBUILD_BUILD_HOST=b860-builder \
  make -C "$uboot_src" O="$uboot_build" CROSS_COMPILE="$cross" -j"$jobs"
[[ -s "$uboot_build/u-boot.bin" ]] || { echo 'mainline U-Boot output is missing' >&2; exit 1; }
cp -- "$uboot_build/u-boot.bin" "$out/u-boot.compiled.bin"
cp -- "$uboot_build/.config" "$out/u-boot.config"

gxlimg_src="$tmp/gxlimg"
checkout_exact "$gxlimg_repo" "$gxlimg_commit" "$gxlimg_src"
make -C "$gxlimg_src" -j"$jobs"
gxlimg="$gxlimg_src/gxlimg"
[[ -x "$gxlimg" ]] || { echo 'gxlimg build output is missing' >&2; exit 1; }

stock_components="$tmp/stock-components"
mkdir -p "$stock_components"
"$gxlimg" -e "$stock_fip" "$stock_components"
for item in bl2:bl2.sign bl30:bl30.enc bl301:bl301.enc bl31:bl31.enc bl33:bl33.enc; do
  key=${item%%:*}
  file=${item#*:}
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).stockFip.components['$key'])" "$recipe")
  printf '%s  %s\n' "$expected" "$stock_components/$file" | sha256sum --check --status
done

"$gxlimg" -t bl3x -c "$out/u-boot.compiled.bin" "$tmp/bl33.enc"
[[ "$(sha256sum "$tmp/bl33.enc" | awk '{print $1}')" != "$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).stockFip.components.bl33)" "$recipe")" ]] || {
  echo 'new BL33 still matches the Android vendor BL33' >&2
  exit 1
}
"$gxlimg" -t fip --bl2 "$stock_components/bl2.sign" --bl30 "$stock_components/bl30.enc" \
  --bl301 "$stock_components/bl301.enc" --bl31 "$stock_components/bl31.enc" \
  --bl33 "$tmp/bl33.enc" "$out/bootloader.PARTITION"

fip_size=$(stat --format='%s' "$out/bootloader.PARTITION")
[[ "$fip_size" -gt 0 && "$fip_size" -le 4194304 ]] || {
  echo "persistent FIP does not fit the 4 MiB bootloader partition: $fip_size" >&2
  exit 1
}
mkdir -p "$out/components"
"$gxlimg" -e "$out/bootloader.PARTITION" "$out/components"
"$gxlimg" -t bl3x -d "$out/components/bl33.enc" "$out/u-boot.raw.bin"

for file in bl2.sign bl30.enc bl301.enc bl31.enc; do
  cmp -- "$stock_components/$file" "$out/components/$file"
done
node "$root/scripts/mainline-boot.mjs" fip-evidence \
  "$out/bootloader.PARTITION" "$out/components" "$out/u-boot.raw.bin" \
  > "$out/mainline-fip-contract.json"

jq -n \
  --arg status 'format-valid / hardware-unverified' \
  --arg ubootCommit "$uboot_commit" \
  --arg gxlimgCommit "$gxlimg_commit" \
  --arg fipSha256 "$(sha256sum "$out/bootloader.PARTITION" | awk '{print $1}')" \
  --arg rawSha256 "$(sha256sum "$out/u-boot.raw.bin" | awk '{print $1}')" \
  '{schemaVersion:1,status:$status,ubootCommit:$ubootCommit,gxlimgCommit:$gxlimgCommit,fipSha256:$fipSha256,rawSha256:$rawSha256}' \
  > "$out/u-boot-build.json"
