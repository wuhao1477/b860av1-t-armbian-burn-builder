#!/usr/bin/env bash
set -Eeuo pipefail

# 独立复核交付的 burn.img：解包后按包里的字节重算证据，和随包发布的
# ophub-boot-contract.json 逐字节对比。build 脚本算的是打包前的载荷，
# 这一步证明打进容器的就是同一批字节。

usage() { echo "usage: $0 burn.img ophub-boot-contract.json" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
image=$1
contract=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
gxlimg=${GXLIMG:-gxlimg}
ampack=${AMPACK:-ampack}
[[ -f "$image" && -f "$contract" ]] || { echo 'validation input is missing' >&2; exit 1; }
for command in node sha256sum "$gxlimg" "$ampack"; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

"$ampack" verify "$image" >/dev/null
"$ampack" unpack "$image" "$tmp/unpack" >/dev/null

for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf meson1.dtb \
  bootloader.PARTITION data.PARTITION; do
  [[ -s "$tmp/unpack/$name" ]] || { echo "missing $name" >&2; exit 1; }
done
# 这套布局只写 bootloader 与 data。boot/1/env 一律禁掉：store 按 meson1.dtb 的
# 分区名查表，没有 "1" 也没有 "env"，写它们必然停在
# [0x30402004]UBOOT/烧录分区 N/初始化分区/命令结果返回错误。
for name in 1.PARTITION env.PARTITION boot.PARTITION system.PARTITION vendor.PARTITION \
  recovery.PARTITION cache.PARTITION logo.PARTITION crypt.PARTITION misc.PARTITION; do
  [[ ! -e "$tmp/unpack/$name" ]] || { echo "prohibited partition payload: $name" >&2; exit 1; }
done
node "$root/scripts/burn-image.mjs" check-ophub-partitions "$tmp/unpack" >/dev/null
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf meson1.dtb; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$tmp/unpack/$name" | sha256sum --check --status
done

components="$tmp/components"
mkdir -p "$components"
"$gxlimg" -e "$tmp/unpack/bootloader.PARTITION" "$components"
"$gxlimg" -t bl3x -d "$components/bl33.enc" "$tmp/bl33.raw.bin"
# 解回来的 BL33 带块对齐填充，截回证据里的长度再核摘要。
bl33_bytes=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).uboot.size)' "$contract")
node -e '
  const fs = require("node:fs");
  const [, source, target, size] = process.argv;
  fs.writeFileSync(target, fs.readFileSync(source).subarray(0, Number(size)));
' "$tmp/bl33.raw.bin" "$tmp/bl33.trimmed.bin" "$bl33_bytes"
node "$root/scripts/burn-image.mjs" check-ophub-chain \
  "$tmp/unpack/bootloader.PARTITION" "$tmp/unpack/data.PARTITION" "$components" \
  "$tmp/bl33.trimmed.bin" > "$tmp/recomputed.json"
node -e '
  const fs = require("node:fs");
  const [, published, recomputed] = process.argv;
  const load = (file) => JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")));
  if (load(published) !== load(recomputed)) {
    throw new Error("published ophub-boot-contract.json differs from the unpacked burn image");
  }
' "$contract" "$tmp/recomputed.json"
echo 'ophub burn image matches its published contract'
