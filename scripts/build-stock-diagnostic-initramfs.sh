#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 output-dir" >&2; exit 2; }
out=$1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

for command in aarch64-linux-gnu-gcc cpio git gzip make node qemu-aarch64-static; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mkdir -p "$out"
mapfile -t sources < <(node -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const name of ["busybox", "dropbear"]) {
    console.log(config.diagnosticSources[name].repository);
    console.log(config.diagnosticSources[name].commit);
  }
' "$root/config/burn-inputs.json")
[[ ${#sources[@]} -eq 4 ]] || { echo 'diagnostic source contract is incomplete' >&2; exit 1; }

busybox_src="$tmp/busybox"
dropbear_src="$tmp/dropbear"
git clone --filter=blob:none "${sources[0]}" "$busybox_src" >/dev/null
git -C "$busybox_src" checkout --detach "${sources[1]}" >/dev/null
git clone --filter=blob:none "${sources[2]}" "$dropbear_src" >/dev/null
git -C "$dropbear_src" checkout --detach "${sources[3]}" >/dev/null
[[ "$(git -C "$busybox_src" rev-parse HEAD)" == "${sources[1]}" ]] || exit 1
[[ "$(git -C "$dropbear_src" rev-parse HEAD)" == "${sources[3]}" ]] || exit 1

busybox_config="$root/config/stock-diagnostic-busybox.config"
dropbear_config="$root/config/stock-diagnostic-dropbear.h"
node "$root/scripts/burn-image.mjs" check-diagnostic-build-config \
  "$busybox_config" "$dropbear_config" >/dev/null
make -C "$busybox_src" allnoconfig >/dev/null
node "$root/scripts/burn-image.mjs" merge-busybox-config \
  "$busybox_src/.config" "$busybox_config" "$busybox_src/.config"
make -C "$busybox_src" oldconfig < <(yes '') >/dev/null
node "$root/scripts/burn-image.mjs" check-diagnostic-build-config \
  "$busybox_src/.config" "$dropbear_config" >/dev/null
grep -qx '# CONFIG_TC is not set' "$busybox_src/.config"
make -C "$busybox_src" -j"$(nproc)" CROSS_COMPILE=aarch64-linux-gnu- >/dev/null
rootfs="$tmp/rootfs"
make -C "$busybox_src" CROSS_COMPILE=aarch64-linux-gnu- CONFIG_PREFIX="$rootfs" install >/dev/null

cp -- "$dropbear_config" "$dropbear_src/localoptions.h"
(
  cd "$dropbear_src"
  ./configure --host=aarch64-linux-gnu --enable-static --disable-zlib --disable-syslog \
    --disable-lastlog --disable-utmp --disable-utmpx --disable-wtmp --disable-wtmpx \
    --disable-loginfunc --disable-pututline --disable-pututxline >/dev/null
  make -j"$(nproc)" PROGRAMS='dropbear dropbearkey' MULTI=1 >/dev/null
)
mkdir -p "$rootfs/usr/sbin" "$rootfs/usr/bin"
cp -- "$dropbear_src/dropbearmulti" "$rootfs/usr/sbin/dropbear"
ln -s ../sbin/dropbear "$rootfs/usr/bin/dropbearkey"

qemu-aarch64-static "$rootfs/bin/busybox" true
qemu-aarch64-static "$rootfs/usr/sbin/dropbear" -V >/dev/null

mkdir -p "$rootfs/etc" "$rootfs/root/.ssh" "$rootfs/usr/share/udhcpc" "$rootfs/www"
cp -- "$root/config/stock-diagnostic-init" "$rootfs/init"
cp -- "$root/config/diagnostic-udhcpc.script" "$rootfs/usr/share/udhcpc/diagnostic.script"
cp -- "$root/config/diagnostic-authorized_keys" "$rootfs/root/.ssh/authorized_keys"
chmod 0755 "$rootfs/init" "$rootfs/usr/share/udhcpc/diagnostic.script"
chmod 0600 "$rootfs/root/.ssh/authorized_keys"
printf 'root:x:0:0:root:/root:/bin/sh\n' > "$rootfs/etc/passwd"
printf 'root:!:20000:0:99999:7:::\n' > "$rootfs/etc/shadow"
printf 'root:x:0:\n' > "$rootfs/etc/group"
printf '/bin/sh\n' > "$rootfs/etc/shells"
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
