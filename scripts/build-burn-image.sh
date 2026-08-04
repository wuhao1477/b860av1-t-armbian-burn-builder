#!/usr/bin/env bash
set -Eeuo pipefail
usage() { echo "usage: $0 raw-image.gz output-dir" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
raw=$1; out=$2; root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ -f "$raw" ]] || { echo "raw image not found" >&2; exit 1; }
mkdir -p "$out"; tmp=$(mktemp -d); loop=''; root_mount="$tmp/root"; boot_mount="$tmp/boot"
cleanup() { set +e; mountpoint -q "$root_mount" && sudo umount "$root_mount"; mountpoint -q "$boot_mount" && sudo umount "$boot_mount"; [[ -n "$loop" ]] && sudo losetup -d "$loop"; rm -rf "$tmp"; }
trap cleanup EXIT
gzip -dc "$raw" > "$tmp/raw.img"
loop=$(sudo losetup --find --show --partscan "$tmp/raw.img"); sudo udevadm settle
mapfile -t parts < <(lsblk --noheadings --list --output NAME,TYPE "$loop" | awk '$2=="part" {print "/dev/"$1}')
[[ ${#parts[@]} -ge 2 ]] || { echo 'raw image must have boot and root partitions' >&2; exit 1; }
boot_part=${parts[0]}; root_part=${parts[1]}; mkdir -p "$boot_mount" "$root_mount"
sudo mount -o ro "$boot_part" "$boot_mount"; sudo mount -o rw "$root_part" "$root_mount"
kernel=$(find "$boot_mount" -type f \( -name 'Image.gz' -o -name 'Image' -o -name 'zImage' \) | sort | head -n1); initrd=$(find "$boot_mount" -type f -name 'initrd*' | sort | head -n1); dtb=$(find "$boot_mount" -type f \( -name 'meson-gxl-s905x-p212-b860av11t.dtb' -o -name 'meson-gxl-s905x-p212.dtb' \) | sort | head -n1)
[[ -n "$kernel" && -n "$initrd" && -n "$dtb" ]] || { echo 'boot partition lacks Image, initrd, or p212 DTB' >&2; exit 1; }
cp "$kernel" "$tmp/kernel"; cp "$initrd" "$tmp/initrd"; cp "$dtb" "$tmp/dtb"
sudo sed -i '/^[[:space:]]*LABEL=BOOT[[:space:]]/d' "$root_mount/etc/fstab" 2>/dev/null || true
sudo umount "$boot_mount" "$root_mount"; root_size=$(sudo blockdev --getsize64 "$root_part"); sudo e2fsck -pf "$root_part" || true
package="$tmp/package"; mkdir -p "$package"
for name in DDR.USB UBOOT.USB aml_sdc_burn.UBOOT aml_sdc_burn.ini platform.conf bootloader.PARTITION meson1.dtb; do
  expected=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$root/config/burn-inputs.json')).files['$name'])")
  printf '%s  %s\n' "$expected" "$root/board-inputs/$name" | sha256sum --check --status
  cp "$root/board-inputs/$name" "$package/$name"
done
cmdline='blkdevparts=mmcblk2:4M@0(bootloader),64M@36M(reserved),768M@108M(cache),8M@884M(env),4M@900M(conf),32M@912M(logo),32M@952M(recovery),8M@992M(rsv),8M@1008M(tee),32M@1024M(crypt),32M@1064M(misc),32M@1104M(boot),1024M@1144M(system),-@2176M(data) root=LABEL=ROOTFS rw rootwait rootfstype=ext4 console=ttyAML0,115200n8 console=tty0 no_console_suspend consoleblank=0 fsck.fix=yes fsck.repair=yes net.ifnames=0 init=/sbin/init'
node "$root/scripts/burn-image.mjs" boot "$tmp/kernel" "$tmp/initrd" "$tmp/dtb" "$package/boot.PARTITION" "$cmdline"
dd if="$root_part" of="$tmp/rootfs.ext4" bs=4M status=none
node "$root/scripts/burn-image.mjs" sparse "$tmp/rootfs.ext4" "$package/data.PARTITION" "$root_size"
tmp_ampack="$tmp/ampack-src"
git clone --filter=blob:none --depth=1 https://github.com/7Ji/ampack.git "$tmp_ampack" >/dev/null
command -v cargo >/dev/null || { echo 'cargo is required' >&2; exit 1; }
cargo build --release --manifest-path "$tmp_ampack/Cargo.toml" >/dev/null
"$tmp_ampack/target/release/ampack" pack --verify "$package" "$out/burn.img" > "$out/ampack-pack.log"
"$tmp_ampack/target/release/ampack" verify "$out/burn.img" > "$out/ampack-verify.log"
cp "$package/data.PARTITION" "$out/data.PARTITION.sparse"; cp "$package/boot.PARTITION" "$out/boot.PARTITION"
(cd "$out" && sha256sum burn.img data.PARTITION.sparse boot.PARTITION > SHA256SUMS)
printf '{"status":"format-valid / hardware-unverified","board":"ZXV10 B860AV1.1-T","burnSha256":"%s","rawSource":"%s"}\n' "$(shasum -a 256 "$out/burn.img" | awk '{print $1}')" "$(basename "$raw")" > "$out/burn-report.json"
