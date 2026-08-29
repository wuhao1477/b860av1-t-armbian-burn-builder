#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 2 ]] || { echo "usage: $0 burn.img diagnostic-initramfs.cpio.gz" >&2; exit 2; }
image=$1
initramfs=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
report_dir=$(cd -- "$(dirname -- "$image")" && pwd)
tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
[[ -f "$image" && -f "$initramfs" ]] || { echo 'diagnostic validation input is missing' >&2; exit 1; }

ampack="$tmp/ampack-src"
mapfile -t ampack_source < <(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ampack;
  console.log(value.repository);
  console.log(value.commit);
' "$root/config/burn-tooling.json")
[[ ${#ampack_source[@]} -eq 2 && "${ampack_source[1]}" =~ ^[0-9a-f]{40}$ ]] || exit 1
git clone --filter=blob:none "${ampack_source[0]}" "$ampack" >/dev/null
git -C "$ampack" checkout --detach "${ampack_source[1]}" >/dev/null
[[ "$(git -C "$ampack" rev-parse HEAD)" == "${ampack_source[1]}" ]] || exit 1
cargo build --release --manifest-path "$ampack/Cargo.toml" >/dev/null
"$ampack/target/release/ampack" verify "$image" >/dev/null
"$ampack/target/release/ampack" unpack "$image" "$tmp/unpack" >/dev/null

for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION meson1.dtb logo.PARTITION boot.PARTITION; do
  [[ -s "$tmp/unpack/$name" ]] || { echo "diagnostic package is missing $name" >&2; exit 1; }
done
variant=${B860_DIAGNOSTIC_VARIANT:-console-beacon}
# env.PARTITION 一律禁止：原厂分区表没有 env 分区，写它必然触发
# [0x30402004] UBOOT/烧录分区 env/初始化分区/命令结果返回错误。
for prohibited in 1.PARTITION data.PARTITION env.PARTITION system.PARTITION \
  vendor.PARTITION recovery.PARTITION cache.PARTITION stock-boot.PARTITION; do
  [[ ! -e "$tmp/unpack/$prohibited" ]] || {
    echo "diagnostic package contains prohibited $prohibited" >&2
    exit 1
  }
done

for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf \
  bootloader.PARTITION meson1.dtb logo.PARTITION; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$tmp/unpack/$name" | sha256sum --check --status
done

node "$root/scripts/burn-image.mjs" check-stock-diagnostic-inputs \
  "$root/board-inputs" "$root/config/burn-inputs.json" \
  > "$tmp/diagnostic-inputs-contract.json"
node "$root/scripts/burn-image.mjs" check-diagnostic-initramfs "$initramfs" \
  > "$tmp/diagnostic-initramfs-contract.json"
node "$root/scripts/burn-image.mjs" check-stock-bootloader \
  "$tmp/unpack/bootloader.PARTITION" "$root/config/burn-inputs.json" \
  > "$tmp/stock-bootloader-contract.json"
contracts=(diagnostic-inputs-contract.json diagnostic-initramfs-contract.json
  stock-bootloader-contract.json diagnostic-boot-contract.json)
# 验证侧独立重推，不读发布的契约，再用 cmp 与发布件逐字节比对，
# 保持与构建侧互不信任。变体经同一个环境变量传入，两侧必须得出相同结论。
if [[ "$variant" == stock-control ]]; then
  node "$root/scripts/burn-image.mjs" check-stock-control-boot \
    "$root/board-inputs/stock-boot.PARTITION" "$tmp/unpack/boot.PARTITION" \
    "$root/config/burn-inputs.json" \
    > "$tmp/diagnostic-boot-contract.json"
else
  console_cmdline=()
  if [[ "${B860_DIAGNOSTIC_CONSOLE:-0}" == 1 ]]; then
    console_cmdline+=("$(node "$root/scripts/burn-image.mjs" diagnostic-console-cmdline \
      "$root/config/stock-environment.json")")
  fi
  node "$root/scripts/burn-image.mjs" check-stock-diagnostic-boot \
    "$root/board-inputs/stock-boot.PARTITION" "$tmp/unpack/boot.PARTITION" \
    "$initramfs" "$root/config/burn-inputs.json" "${console_cmdline[@]}" \
    > "$tmp/diagnostic-boot-contract.json"
  contracts+=(sd-handoff-contract.json)
  # 交接盘同样独立重推：引导镜像与 logo 都取自刚从 burn.img 解包出来的分区，
  # 而不是构建侧的中间产物，两条路径必须落到同一批字节。
  node "$root/scripts/burn-image.mjs" sd-handoff-kit \
    "$root/config/stock-environment.json" "$tmp/unpack/logo.PARTITION" \
    "$tmp/unpack/boot.PARTITION" "$tmp/sd-handoff" \
    > "$tmp/sd-handoff-contract.json"
  for name in handoff.cmd aml_autoscript b860boot.img b860run.bmp b860fail.bmp; do
    [[ -s "$report_dir/sd-handoff/$name" ]] || {
      echo "published SD handoff kit is missing $name" >&2
      exit 1
    }
    cmp --silent "$report_dir/sd-handoff/$name" "$tmp/sd-handoff/$name" || {
      echo "published SD handoff $name differs from the unpacked diagnostic image" >&2
      exit 1
    }
  done
  # recovery.img 这个名字会被原厂 recovery_from_sdcard 在 autoscr 之后带 wipeisb 再启动一次。
  for forbidden in aml_sdc_burn.ini recovery.img; do
    [[ ! -e "$report_dir/sd-handoff/$forbidden" ]] || {
      echo "published SD handoff kit contains $forbidden" >&2
      exit 1
    }
  done
  dumpimage -T script -p 0 -o "$tmp/published.payload" \
    "$report_dir/sd-handoff/aml_autoscript" >/dev/null
  node "$root/scripts/extract-uboot-script-payload.mjs" \
    "$report_dir/sd-handoff/aml_autoscript" "$tmp/published.payload" "$tmp/published.cmd"
  cmp -- "$report_dir/sd-handoff/handoff.cmd" "$tmp/published.cmd"
  # set -e 下 `grep -q ... && { exit 1; }` 在不匹配时会让整条命令返回 1 而不报错，
  # 所以这里用 if，别把「没有 sdc_burning」写成静默通过。
  if grep -q 'sdc_burn\|aml_sdc_burn' "$tmp/published.cmd"; then
    echo 'SD handoff script must not trigger sdc_burning' >&2
    exit 1
  fi
fi

for contract in "${contracts[@]}"; do
  cmp --silent "$report_dir/$contract" "$tmp/$contract" || {
    echo "published $contract differs from the unpacked diagnostic image" >&2
    exit 1
  }
done
magic=$(od -An -tx4 -j8 -N4 "$image" | tr -d ' ')
[[ "$magic" == 27b51956 ]] || { echo "unexpected Amlogic v2 version magic: $magic" >&2; exit 1; }
echo 'format-valid / diagnostic / hardware-unverified'
