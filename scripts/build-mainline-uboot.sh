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

for command in curl dd git jq make node sha256sum stat "${cross}gcc"; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mapfile -t source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const item of [
    value.uboot.repository, value.uboot.tag, value.uboot.commit, value.uboot.defconfig,
    value.uboot.referenceRelease.tag,
    value.uboot.referenceRelease.rawBl33Name,
    value.uboot.referenceRelease.rawBl33Size,
    value.uboot.referenceRelease.rawBl33Sha256,
    value.uboot.referenceRelease.emmcImageName,
    value.uboot.referenceRelease.emmcImageSize,
    value.uboot.referenceRelease.emmcImageSha256,
    value.uboot.referenceRelease.emmcFipOffsetBytes,
    value.uboot.referenceRelease.emmcFipSize,
    value.uboot.referenceRelease.emmcFipSha256,
    value.gxlimg.repository, value.gxlimg.commit,
    value.stockFip.path, value.stockFip.sha256,
  ]) console.log(item);
' "$recipe")
[[ ${#source[@]} -eq 18 ]] || { echo 'mainline boot recipe is incomplete' >&2; exit 1; }
uboot_repo=${source[0]}
uboot_tag=${source[1]}
uboot_commit=${source[2]}
defconfig=${source[3]}
reference_tag=${source[4]}
reference_raw_name=${source[5]}
reference_raw_size=${source[6]}
reference_raw_sha=${source[7]}
reference_emmc_name=${source[8]}
reference_emmc_size=${source[9]}
reference_emmc_sha=${source[10]}
reference_fip_offset=${source[11]}
reference_fip_size=${source[12]}
reference_fip_sha=${source[13]}
gxlimg_repo=${source[14]}
gxlimg_commit=${source[15]}
stock_fip="$root/${source[16]}"
stock_sha=${source[17]}

for size in "$reference_raw_size" "$reference_emmc_size" "$reference_fip_offset" "$reference_fip_size"; do
  [[ "$size" =~ ^[0-9]+$ ]] || { echo 'reference release size is invalid' >&2; exit 1; }
done
[[ "$reference_tag" == "$uboot_tag" && $((reference_fip_offset % 512)) -eq 0 ]] || {
  echo 'reference release tag or FIP offset is invalid' >&2
  exit 1
}
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
tag_commit=$(git ls-remote "$uboot_repo" "refs/tags/$uboot_tag" | awk 'NR == 1 { print $1 }')
[[ "$tag_commit" == "$uboot_commit" ]] || { echo 'U-Boot tag differs from the pinned commit' >&2; exit 1; }
checkout_exact "$uboot_repo" "$uboot_commit" "$uboot_src"
make -C "$uboot_src" O="$uboot_build" CROSS_COMPILE="$cross" "$defconfig"
boot_command=$(node "$root/scripts/mainline-boot.mjs" boot-command "$root_uuid" "$fit_bytes")
"$uboot_src/scripts/config" --file "$uboot_build/.config" \
  --enable ENV_IS_NOWHERE \
  --disable ENV_IS_IN_MMC \
  --enable FIT \
  --enable CMD_BOOTM \
  --disable VIDEO \
  --set-str BOOTCOMMAND "$boot_command" \
  --set-val BOOTDELAY 0
make -C "$uboot_src" O="$uboot_build" CROSS_COMPILE="$cross" olddefconfig

grep -qx 'CONFIG_ENV_IS_NOWHERE=y' "$uboot_build/.config" || {
  echo 'mainline U-Boot must ignore the stock persistent environment' >&2
  exit 1
}
for option in CONFIG_FIT CONFIG_CMD_BOOTM; do
  grep -qx "$option=y" "$uboot_build/.config" || {
    echo "mainline U-Boot boot option is not enabled: $option" >&2
    exit 1
  }
done
grep -qx '# CONFIG_VIDEO is not set' "$uboot_build/.config" || {
  echo 'R3300L reference build must not initialize U-Boot video' >&2
  exit 1
}

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

reference_base="${uboot_repo%.git}/releases/download/$reference_tag"
reference_raw="$tmp/$reference_raw_name"
reference_emmc="$tmp/$reference_emmc_name"
curl --fail --location --retry 3 --output "$reference_raw" "$reference_base/$reference_raw_name"
curl --fail --location --retry 3 --output "$reference_emmc" "$reference_base/$reference_emmc_name"
[[ "$(stat --format='%s' "$reference_raw")" == "$reference_raw_size" ]] || {
  echo 'R3300L reference raw BL33 size differs' >&2
  exit 1
}
[[ "$(stat --format='%s' "$reference_emmc")" == "$reference_emmc_size" ]] || {
  echo 'R3300L reference eMMC image size differs' >&2
  exit 1
}
printf '%s  %s\n' "$reference_raw_sha" "$reference_raw" | sha256sum --check --status
printf '%s  %s\n' "$reference_emmc_sha" "$reference_emmc" | sha256sum --check --status

reference_fip="$tmp/reference-fip.bin"
dd if="$reference_emmc" of="$reference_fip" bs=512 \
  skip="$((reference_fip_offset / 512))" status=none
[[ "$(stat --format='%s' "$reference_fip")" == "$reference_fip_size" ]] || {
  echo 'R3300L reference FIP size differs' >&2
  exit 1
}
printf '%s  %s\n' "$reference_fip_sha" "$reference_fip" | sha256sum --check --status
reference_components="$tmp/reference-components"
mkdir -p "$reference_components"
"$gxlimg" -e "$reference_fip" "$reference_components"
for file in bl2.sign bl30.enc bl301.enc bl31.enc; do
  cmp -- "$stock_components/$file" "$reference_components/$file"
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
  --arg ubootRepository "$uboot_repo" \
  --arg ubootTag "$uboot_tag" \
  --arg ubootCommit "$uboot_commit" \
  --arg defconfig "$defconfig" \
  --arg gxlimgCommit "$gxlimg_commit" \
  --arg referenceTag "$reference_tag" \
  --arg referenceRawName "$reference_raw_name" \
  --argjson referenceRawSize "$reference_raw_size" \
  --arg referenceRawSha256 "$reference_raw_sha" \
  --arg referenceEmmcName "$reference_emmc_name" \
  --argjson referenceEmmcSize "$reference_emmc_size" \
  --arg referenceEmmcSha256 "$reference_emmc_sha" \
  --argjson referenceFipSize "$reference_fip_size" \
  --arg referenceFipSha256 "$reference_fip_sha" \
  --arg fipSha256 "$(sha256sum "$out/bootloader.PARTITION" | awk '{print $1}')" \
  --arg rawSha256 "$(sha256sum "$out/u-boot.raw.bin" | awk '{print $1}')" \
  '{schemaVersion:2,status:$status,
    source:{repository:$ubootRepository,tag:$ubootTag,commit:$ubootCommit,defconfig:$defconfig},
    referenceRelease:{tag:$referenceTag,
      rawBl33:{name:$referenceRawName,size:$referenceRawSize,sha256:$referenceRawSha256},
      emmcImage:{name:$referenceEmmcName,size:$referenceEmmcSize,sha256:$referenceEmmcSha256},
      emmcFip:{size:$referenceFipSize,sha256:$referenceFipSha256}},
    gxlimgCommit:$gxlimgCommit,fipSha256:$fipSha256,rawSha256:$rawSha256}' \
  > "$out/u-boot-build.json"
