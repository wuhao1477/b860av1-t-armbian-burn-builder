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
#   console-beacon  重打包 boot.PARTITION，替换 ramdisk 并写入 HDMI 控制台 cmdline
#   stock-control   boot.PARTITION 用原厂副本逐字节不改，作为对照实验
# 三版修改过 ramdisk 的镜像在实机上表现完全一致，说明我们改的内容可能从未被
# imgread 读取。对照包用来把「重打包被拒绝」与「env/打包层面问题」分开，
# 若它能正常进入 Android，也同时把 boot 分区恢复回原厂。
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
