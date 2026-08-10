#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 output-dir" >&2; exit 2; }
out=$1
mkdir -p "$out"
out=$(cd -- "$out" && pwd -P)
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

for command in aarch64-linux-gnu-gcc cpio git gzip make node qemu-aarch64-static; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mapfile -t sources < <(node -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const name of ["busybox"]) {
    console.log(config.diagnosticSources[name].repository);
    console.log(config.diagnosticSources[name].commit);
  }
' "$root/config/burn-inputs.json")
[[ ${#sources[@]} -eq 2 ]] || { echo 'diagnostic source contract is incomplete' >&2; exit 1; }

busybox_src="$tmp/busybox"
git clone --filter=blob:none "${sources[0]}" "$busybox_src" >/dev/null
git -C "$busybox_src" checkout --detach "${sources[1]}" >/dev/null
[[ "$(git -C "$busybox_src" rev-parse HEAD)" == "${sources[1]}" ]] || exit 1

busybox_config="$root/config/stock-diagnostic-busybox.config"
node "$root/scripts/burn-image.mjs" check-diagnostic-build-config \
  "$busybox_config" >/dev/null
make -C "$busybox_src" allnoconfig >/dev/null
node "$root/scripts/burn-image.mjs" merge-busybox-config \
  "$busybox_src/.config" "$busybox_config" "$busybox_src/.config"
make -C "$busybox_src" oldconfig < <(yes '') >/dev/null
node "$root/scripts/burn-image.mjs" check-diagnostic-build-config \
  "$busybox_src/.config" >/dev/null
grep -qx '# CONFIG_TC is not set' "$busybox_src/.config"
make -C "$busybox_src" -j"$(nproc)" CROSS_COMPILE=aarch64-linux-gnu- >/dev/null
rootfs="$tmp/rootfs"
make -C "$busybox_src" CROSS_COMPILE=aarch64-linux-gnu- CONFIG_PREFIX="$rootfs" install >/dev/null

qemu-aarch64-static "$rootfs/bin/busybox" true

mkdir -p "$rootfs/etc" "$rootfs/usr/share/udhcpc" "$rootfs/www"
cp -- "$root/config/stock-diagnostic-init" "$rootfs/init"
cp -- "$root/config/diagnostic-udhcpc.script" "$rootfs/usr/share/udhcpc/diagnostic.script"
chmod 0755 "$rootfs/init" "$rootfs/usr/share/udhcpc/diagnostic.script"
printf 'B860_STOCK_KERNEL_DIAGNOSTIC=1\n' > "$rootfs/etc/b860-diagnostic-release"
printf 'nameserver 192.168.1.1\n' > "$rootfs/etc/resolv.conf"
printf 'B860 diagnostic is running. See /index.txt.\n' > "$rootfs/www/index.html"

(
  cd "$rootfs"
  find . -print0 | LC_ALL=C sort -z \
    | cpio --null --create --format=newc --owner=0:0 --quiet \
    | gzip -9n > "$out/diagnostic-initramfs.cpio.gz"
)
node "$root/scripts/burn-image.mjs" check-diagnostic-initramfs \
  "$out/diagnostic-initramfs.cpio.gz" > "$out/diagnostic-initramfs-contract.json"
