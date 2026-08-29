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
# 变体选择：
#   console-beacon   重打包 boot.PARTITION，替换 ramdisk 并写入 HDMI 控制台 cmdline
#   stock-control    boot.PARTITION 用原厂副本逐字节不改，作为对照实验
#
# 对照实验已证明 boot.PARTITION 的内容与现象无关：逐字节原厂副本与三版改过
# ramdisk 的镜像表现完全一致。
#
# 曾尝试过 stock-env-reset 变体(写 env.PARTITION 复位 upgrade_step)，已证伪并移除：
# 原厂 meson1.dtb 的 7 个 sub-DTB 分区表一律是
#   conf logo recovery rsv tee crypt misc boot system cache data
# 根本没有 env 分区，U-Boot 环境由 rsv 内部管理。烧录工具因此必然返回
#   [0x30402004] UBOOT/烧录分区 env/初始化分区/命令结果返回错误
# 该断言由 tests/stock-kernel-diagnostic.test.mjs 直接对 board-inputs/meson1.dtb
# 复核，防止再次被加回来。
variant=${B860_DIAGNOSTIC_VARIANT:-console-beacon}
case "$variant" in
  console-beacon|stock-control) ;;
  *) echo "unknown diagnostic variant: $variant" >&2; exit 1 ;;
esac

if [[ "$variant" == stock-control ]]; then
  cp -- "$root/board-inputs/stock-boot.PARTITION" "$package/boot.PARTITION"
  node "$root/scripts/burn-image.mjs" check-stock-control-boot \
    "$root/board-inputs/stock-boot.PARTITION" "$package/boot.PARTITION" \
    "$root/config/burn-inputs.json" \
    > "$out/diagnostic-boot-contract.json"
else
  # 写入值记录在 diagnostic-boot-contract.json 的 consoleCmdline 里，无需单独产物。
  console_cmdline=()
  if [[ "${B860_DIAGNOSTIC_CONSOLE:-0}" == 1 ]]; then
    console_cmdline+=("$(node "$root/scripts/burn-image.mjs" diagnostic-console-cmdline \
      "$root/config/stock-environment.json")")
  fi
  node "$root/scripts/burn-image.mjs" replace-stock-ramdisk \
    "$root/board-inputs/stock-boot.PARTITION" "$initramfs" "$package/boot.PARTITION" \
    "${console_cmdline[@]}" >/dev/null
  node "$root/scripts/burn-image.mjs" check-stock-diagnostic-boot \
    "$root/board-inputs/stock-boot.PARTITION" "$package/boot.PARTITION" \
    "$initramfs" "$root/config/burn-inputs.json" "${console_cmdline[@]}" \
    > "$out/diagnostic-boot-contract.json"

  # 免刷机的 SD 卡交接盘，与 burn.img 一起发布：原厂 recovery_from_sdcard 会把 FAT 卡上的
  # aml_autoscript 交给 autoscr 执行，整条路不写 eMMC，可以反复试。
  # boot.PARTITION 直接复用成卡上的 b860boot.img —— 同一份镜像，两条独立的送入路径。
  rm -rf "$out/sd-handoff"
  node "$root/scripts/burn-image.mjs" sd-handoff-kit \
    "$root/config/stock-environment.json" "$root/board-inputs/logo.PARTITION" \
    "$package/boot.PARTITION" "$out/sd-handoff" \
    > "$out/sd-handoff-contract.json"
  # 用 mkimage 交叉验证自写的 uImage：两个独立实现必须逐字节一致，
  # 头 CRC 错的脚本会被 U-Boot 静默忽略，而那正是最难与「没进 update」区分的失败。
  command -v mkimage >/dev/null || { echo 'mkimage is required to cross-check aml_autoscript' >&2; exit 1; }
  command -v dumpimage >/dev/null || { echo 'dumpimage is required to verify aml_autoscript' >&2; exit 1; }
  SOURCE_DATE_EPOCH=0 mkimage -C none -A arm -T script -n b860-sd-handoff \
    -d "$out/sd-handoff/handoff.cmd" "$tmp/mkimage-autoscript" >/dev/null
  cmp -- "$tmp/mkimage-autoscript" "$out/sd-handoff/aml_autoscript"
  dumpimage -T script -p 0 -o "$tmp/autoscript.payload" "$out/sd-handoff/aml_autoscript" >/dev/null
  node "$root/scripts/extract-uboot-script-payload.mjs" \
    "$out/sd-handoff/aml_autoscript" "$tmp/autoscript.payload" "$tmp/autoscript.cmd"
  cmp -- "$out/sd-handoff/handoff.cmd" "$tmp/autoscript.cmd"
  # sdc_burning 在 update 里排在 recovery_from_sdcard 之前，卡上一旦有这个文件，
  # 烧录会抢先开始写 eMMC —— 交接盘的全部价值就是不写 eMMC。
  # recovery.img 同理禁止：原厂在 autoscr 之后自己还会 fatload 一次这个名字并带 wipeisb 启动。
  for forbidden in aml_sdc_burn.ini recovery.img; do
    [[ ! -e "$out/sd-handoff/$forbidden" ]] || {
      echo "SD handoff kit must never contain $forbidden" >&2
      exit 1
    }
  done
fi

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
