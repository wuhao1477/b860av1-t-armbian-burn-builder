#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

usage() {
  echo "usage: $0 image.img.gz report.json resolved-sources.json uboot-build.json" >&2
  exit 2
}

[[ $# -eq 4 ]] || usage
image=$1
report=$2
manifest=$3
uboot_build=$4
[[ -f "$image" ]] || { echo "image not found: $image" >&2; exit 1; }
[[ -f "$manifest" ]] || { echo "manifest not found: $manifest" >&2; exit 1; }
[[ -f "$uboot_build" ]] || { echo "U-Boot build evidence not found: $uboot_build" >&2; exit 1; }
mkdir -p "$(dirname "$report")"
evidence_dir=$(cd -- "$(dirname "$report")" && pwd)
filesystem_manifest="$evidence_dir/filesystem-manifest.sha256"
boot_components="$evidence_dir/boot-components.json"
third_party_sources="$evidence_dir/THIRD_PARTY_SOURCES.md"
source_built_dtb_evidence="$evidence_dir/source-built-dtb.json"
device_tree_source="$evidence_dir/device-tree-source.dts"
qemu_system_smoke="$evidence_dir/qemu-system-smoke.json"
qemu_system_console="$evidence_dir/qemu-system-smoke.log"
rtl8189fs_evidence="$evidence_dir/rtl8189fs-driver.json"
hardware_capabilities_evidence="$evidence_dir/hardware-capabilities.json"
install -m 0644 -- "$script_dir/../THIRD_PARTY_SOURCES.md" "$third_party_sources"
gzip -t "$image"

dtb_name='meson-gxl-s905x-p212-b860av11t.dtb'
uboot_name='u-boot-s905x-s912.bin'
bootloader_gap_mib=4
mapfile -t board_values < <(BOARD_LIMIT_MODULE="$script_dir/../src/board-limits.mjs" IMAGE_IDENTITY_MODULE="$script_dir/../src/image-identity.mjs" node --input-type=module - "$manifest" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const { imageSizeLimit } = await import(pathToFileURL(process.env.BOARD_LIMIT_MODULE).href);
const { requiresImageIdentity } = await import(pathToFileURL(process.env.IMAGE_IDENTITY_MODULE).href);
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const board = manifest.board;
if (typeof board?.dtb !== 'string' || typeof board?.ubootOverload !== 'string') {
  throw new Error('manifest board boot files are required');
}
if (typeof board.distribution !== 'string' || !/^[a-z]+$/.test(board.distribution)) {
  throw new Error('manifest board distribution is invalid');
}
if (typeof board.distributionVersion !== 'string' || !/^[1-9][0-9]*$/.test(board.distributionVersion)) {
  throw new Error('manifest board distribution version is invalid');
}
if (!Number.isInteger(board.memoryLimitMiB)) throw new Error('manifest memory limit is required');
if (!Number.isInteger(board.bootloaderGapMiB)) throw new Error('manifest bootloader gap is required');
if (typeof manifest.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.fingerprint)) {
  throw new Error('manifest fingerprint is required');
}
if (typeof manifest.sources?.kernel?.version !== 'string'
  || !/^\d+\.\d+\.\d+$/.test(manifest.sources.kernel.version)) {
  throw new Error('manifest kernel version is invalid');
}
console.log(board.dtb);
console.log(board.ubootOverload);
console.log(board.bootloaderGapMiB);
console.log(manifest.fingerprint);
console.log(board.memoryLimitMiB);
console.log(board.distribution);
console.log(board.distributionVersion);
console.log(imageSizeLimit(board));
console.log(manifest.sources.kernel.version);
console.log(requiresImageIdentity(manifest) ? 'true' : 'false');
NODE
)
[[ ${#board_values[@]} -eq 10 ]] || { echo 'manifest board extraction failed' >&2; exit 1; }
dtb_name=${board_values[0]}
uboot_name=${board_values[1]}
bootloader_gap_mib=${board_values[2]}
manifest_fingerprint=${board_values[3]}
memory_limit_mib=${board_values[4]}
debian_codename=${board_values[5]}
debian_major_version=${board_values[6]}
max_image_bytes=${board_values[7]}
kernel_version=${board_values[8]}
image_identity_required=${board_values[9]}
mapfile -t uboot_values < <(node "$script_dir/validate-uboot-build.mjs" "$manifest" "$uboot_build")
[[ ${#uboot_values[@]} -eq 3 ]] || { echo 'U-Boot build evidence extraction failed' >&2; exit 1; }
[[ "${uboot_values[0]}" == "$uboot_name" ]] || { echo 'U-Boot evidence name mismatch' >&2; exit 1; }
uboot_overload_sha256=${uboot_values[1]}
uboot_overload_size=${uboot_values[2]}
[[ "$dtb_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo 'invalid DTB name' >&2; exit 1; }
[[ "$uboot_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo 'invalid U-Boot name' >&2; exit 1; }
[[ "$bootloader_gap_mib" =~ ^[0-9]+$ && "$bootloader_gap_mib" -ge 1 && "$bootloader_gap_mib" -le 16 ]] || {
  echo 'invalid bootloader gap size' >&2
  exit 1
}
[[ "$memory_limit_mib" =~ ^[0-9]+$ && "$memory_limit_mib" -ge 256 && "$memory_limit_mib" -le 4096 ]] || {
  echo 'invalid memory limit' >&2
  exit 1
}

tmp_dir=$(mktemp -d)
loop=''
boot_mount="$tmp_dir/boot"
root_mount="$tmp_dir/root"
cleanup() {
  set +e
  mountpoint -q "$boot_mount" && umount "$boot_mount"
  mountpoint -q "$root_mount" && umount "$root_mount"
  [[ -n "$loop" ]] && losetup --detach "$loop"
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

raw="$tmp_dir/image.img"
gzip --decompress --stdout "$image" > "$raw"
raw_size=$(stat -c %s "$raw")
[[ "$raw_size" -le "$max_image_bytes" ]] || {
  echo "image exceeds the board storage limit: $raw_size > $max_image_bytes" >&2
  exit 1
}
sfdisk --verify "$raw"
partition_json=$(sfdisk --json "$raw")
mapfile -t layout_values < <(PARTITION_JSON="$partition_json" node - <<'NODE'
const table = JSON.parse(process.env.PARTITION_JSON).partitiontable;
if (table?.label !== 'dos' || table.unit !== 'sectors' || table.sectorsize !== 512) {
  throw new Error('expected a 512-byte-sector DOS partition table');
}
if (!Array.isArray(table.partitions) || table.partitions.length !== 2) {
  throw new Error('expected exactly two partitions');
}
const starts = table.partitions.map((partition) => partition?.start);
if (starts.some((value) => !Number.isSafeInteger(value) || value <= 1)) {
  throw new Error('invalid partition start');
}
const start = Math.min(...starts);
if (!Number.isSafeInteger(start) || start <= 1) throw new Error('invalid first partition start');
console.log(start);
NODE
)
[[ ${#layout_values[@]} -eq 1 ]] || { echo 'partition layout extraction failed' >&2; exit 1; }
first_partition_start=${layout_values[0]}
expected_partition_start=$((bootloader_gap_mib * 2048))
[[ "$first_partition_start" -eq "$expected_partition_start" ]] || {
  echo "unexpected first partition start: $first_partition_start" >&2
  exit 1
}
mbr_bootstrap_sha256=$(dd if="$raw" bs=1 count=440 status=none | sha256sum | awk '{print $1}')
empty_mbr_bootstrap_sha256=$(head -c 440 /dev/zero | sha256sum | awk '{print $1}')
[[ "$mbr_bootstrap_sha256" == "$empty_mbr_bootstrap_sha256" ]] || {
  echo "MBR bootstrap is not empty: $mbr_bootstrap_sha256" >&2
  exit 1
}
mbr_reserved_sha256=$(dd if="$raw" bs=1 skip=444 count=2 status=none | sha256sum | awk '{print $1}')
empty_mbr_reserved_sha256=$(head -c 2 /dev/zero | sha256sum | awk '{print $1}')
[[ "$mbr_reserved_sha256" == "$empty_mbr_reserved_sha256" ]] || {
  echo 'MBR reserved bytes are not empty' >&2
  exit 1
}
bootloader_region_blocks=$((first_partition_start - 1))
bootloader_region_bytes=$((bootloader_region_blocks * 512))
region_sha256=$(dd if="$raw" bs=512 skip=1 count="$bootloader_region_blocks" status=none | sha256sum | awk '{print $1}')
empty_region_sha256=$(head -c "$bootloader_region_bytes" /dev/zero | sha256sum | awk '{print $1}')
[[ "$region_sha256" == "$empty_region_sha256" ]] || {
  echo 'embedded Amlogic bootloader data found before the boot partition' >&2
  exit 1
}
sfdisk --dump "$raw" | grep -Fx 'label: dos'
loop=$(losetup --find --show --partscan "$raw")
mapfile -t partitions < <(lsblk --noheadings --list --output NAME,TYPE "$loop" | awk '$2 == "part" {print "/dev/" $1}')
[[ ${#partitions[@]} -eq 2 ]] || { echo "expected exactly boot and root partitions" >&2; exit 1; }

boot_partition=${partitions[0]}
root_partition=${partitions[1]}
boot_type=$(blkid -s TYPE -o value "$boot_partition" 2>/dev/null || true)
[[ "$boot_type" == vfat ]] || {
  echo "boot partition is not FAT" >&2
  exit 1
}
fsck.vfat -n "$boot_partition"
root_type=$(blkid -s TYPE -o value "$root_partition" 2>/dev/null || true)
[[ "$root_type" == ext4 ]] || {
  echo "root partition is not ext4" >&2
  exit 1
}
root_label=$(blkid -s LABEL -o value "$root_partition" 2>/dev/null || true)
[[ "$root_label" == ROOTFS ]] || { echo "unexpected rootfs label: $root_label" >&2; exit 1; }
root_uuid=$(blkid -s UUID -o value "$root_partition" 2>/dev/null || true)
[[ "$root_uuid" =~ ^[0-9A-Fa-f-]{36}$ ]] || { echo 'invalid rootfs UUID' >&2; exit 1; }
e2fsck -fn "$root_partition"
mkdir -p "$boot_mount" "$root_mount"
mount -o ro "$boot_partition" "$boot_mount"
mount -o ro,noload "$root_partition" "$root_mount"

image_identity="$root_mount/usr/lib/b860av1-t/image-identity.json"
identity_kernel_release=''
if [[ "$image_identity_required" == true ]]; then
  [[ -s "$image_identity" ]] || { echo 'required image identity is missing' >&2; exit 1; }
  identity_kernel_release=$(IMAGE_IDENTITY_MODULE="$script_dir/../src/image-identity.mjs" \
    node --input-type=module - "$image_identity" "$manifest" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const { validateImageIdentity } = await import(pathToFileURL(process.env.IMAGE_IDENTITY_MODULE).href);
const identity = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const manifest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
validateImageIdentity(identity, {
  boardProfile: manifest.board?.profile,
  manifestFingerprint: manifest.fingerprint,
  kernelVersion: manifest.sources?.kernel?.version,
});
process.stdout.write(identity.kernelRelease);
NODE
  )
fi

grep --fixed-strings --line-regexp 'ID=debian' "$root_mount/etc/os-release"
grep -Eq "^VERSION_CODENAME=\"?${debian_codename}\"?$" "$root_mount/etc/os-release"
grep -Eq "^VERSION_ID=\"?${debian_major_version}(\.[0-9]+)*\"?$" "$root_mount/etc/os-release"
[[ -s "$root_mount/etc/armbian-release" ]] || { echo 'missing /etc/armbian-release' >&2; exit 1; }
[[ -s "$root_mount/etc/armbian-image-release" ]] || { echo 'missing /etc/armbian-image-release' >&2; exit 1; }
[[ -x "$root_mount/sbin/init" ]] || { echo 'missing executable /sbin/init' >&2; exit 1; }
if [[ ! -s "$boot_mount/uEnv.txt" && ! -s "$boot_mount/extlinux/extlinux.conf" ]]; then
  echo 'missing uEnv.txt or extlinux.conf' >&2
  exit 1
fi
check_boot_config() {
  local path=$1 kind=$2
  if [[ "$kind" == extlinux ]]; then
    grep -Eq '^[[:space:]]*kernel[[:space:]]+/zImage[[:space:]]*$' "$path"
    grep -Eq '^[[:space:]]*initrd[[:space:]]+/uInitrd[[:space:]]*$' "$path"
    grep -Fq "fdt /dtb/amlogic/$dtb_name" "$path"
    grep -Eq "^[[:space:]]*append[[:space:]]+root=UUID=${root_uuid}([[:space:]]|$).*([[:space:]])mem=${memory_limit_mib}M([[:space:]]|$)" "$path"
  else
    grep -Fxq 'LINUX=/zImage' "$path"
    grep -Fxq 'INITRD=/uInitrd' "$path"
    grep -Fxq "FDT=/dtb/amlogic/$dtb_name" "$path"
    grep -Eq "^APPEND=root=UUID=${root_uuid}([[:space:]]|$).*([[:space:]])mem=${memory_limit_mib}M([[:space:]]|$)" "$path"
  fi
}
[[ ! -s "$boot_mount/extlinux/extlinux.conf" ]] || check_boot_config "$boot_mount/extlinux/extlinux.conf" extlinux
[[ ! -s "$boot_mount/uEnv.txt" ]] || check_boot_config "$boot_mount/uEnv.txt" uenv
resolve_active_boot_file() {
  local relative=$1 label=$2
  [[ "$relative" == /* && "$relative" != *..* && "$relative" != *$'\r'* ]] || {
    echo "invalid active $label path: $relative" >&2
    exit 1
  }
  printf '%s/%s\n' "$boot_mount" "${relative#/}"
}
if [[ -s "$boot_mount/uEnv.txt" ]]; then
  active_kernel_rel=$(awk -F= '$1 == "LINUX" {print $2; exit}' "$boot_mount/uEnv.txt")
  active_initrd_rel=$(awk -F= '$1 == "INITRD" {print $2; exit}' "$boot_mount/uEnv.txt")
else
  active_kernel_rel=$(awk '$1 == "kernel" {print $2; exit}' "$boot_mount/extlinux/extlinux.conf")
  active_initrd_rel=$(awk '$1 == "initrd" {print $2; exit}' "$boot_mount/extlinux/extlinux.conf")
fi
active_kernel_file=$(resolve_active_boot_file "$active_kernel_rel" kernel)
active_initrd_file=$(resolve_active_boot_file "$active_initrd_rel" initrd)
[[ -f "$active_kernel_file" ]] || { echo "active kernel is missing: $active_kernel_file" >&2; exit 1; }
[[ -f "$active_initrd_file" ]] || { echo "active initrd is missing: $active_initrd_file" >&2; exit 1; }
stock_boot_script="$boot_mount/s905_autoscript"
[[ -s "$stock_boot_script" ]] || { echo 'missing stock U-Boot entry script: s905_autoscript' >&2; exit 1; }
decoded_stock_script="$tmp_dir/s905_autoscript.cmd"
stock_script_payload="$tmp_dir/s905_autoscript.payload"
dumpimage -T script -p 0 -o "$stock_script_payload" "$stock_boot_script" >/dev/null
node "$script_dir/extract-uboot-script-payload.mjs" \
  "$stock_boot_script" "$stock_script_payload" "$decoded_stock_script"
[[ -s "$decoded_stock_script" ]] || { echo 'empty decoded s905_autoscript' >&2; exit 1; }
cmp -- "$script_dir/../config/s905-autoscript.cmd" "$decoded_stock_script"
if grep -Eiq 'android' "$decoded_stock_script"; then
  echo 'Android fallback found in decoded s905_autoscript' >&2
  exit 1
fi
node "$script_dir/validate-boot-script.mjs" s905 "$decoded_stock_script"
installer_boot_script="$boot_mount/aml_autoscript"
[[ -s "$installer_boot_script" ]] || { echo 'missing pure Armbian installer script: aml_autoscript' >&2; exit 1; }
decoded_aml_script="$tmp_dir/aml_autoscript.cmd"
aml_script_payload="$tmp_dir/aml_autoscript.payload"
dumpimage -T script -p 0 -o "$aml_script_payload" "$installer_boot_script" >/dev/null
node "$script_dir/extract-uboot-script-payload.mjs" \
  "$installer_boot_script" "$aml_script_payload" "$decoded_aml_script"
node "$script_dir/validate-boot-script.mjs" aml "$decoded_aml_script"
if grep -Eiq 'android|storeboot|start_emmc_autoscript' "$decoded_aml_script"; then
  echo 'non-Armbian fallback found in decoded aml_autoscript' >&2
  exit 1
fi
kernel_file="$active_kernel_file"
mapfile -t initrd_files < <(find "$boot_mount" -type f \( -name 'initrd.img' -o -name 'initrd.img-*' -o -name 'uInitrd' \) -print | sort)
[[ ${#initrd_files[@]} -gt 0 ]] || { echo 'missing initrd image' >&2; exit 1; }
dtb_file="$boot_mount/dtb/amlogic/$dtb_name"
[[ -f "$dtb_file" ]] || { echo "missing active target device tree: dtb/amlogic/$dtb_name" >&2; exit 1; }
expected_dtb_dir="$tmp_dir/source-built-dtb"
"$script_dir/build-board-dtb.sh" "$manifest" "$expected_dtb_dir"
expected_dtb="$expected_dtb_dir/$dtb_name"
cmp -- "$expected_dtb" "$dtb_file"
install -m 0644 -- "$expected_dtb_dir/source-built-dtb.json" "$source_built_dtb_evidence"
install -m 0644 -- "$expected_dtb_dir/device-tree-source.dts" "$device_tree_source"
uboot_file=$(find "$boot_mount" -type f -name "$uboot_name" -print -quit)
[[ -n "$uboot_file" ]] || { echo "missing U-Boot overload: $uboot_name" >&2; exit 1; }
printf '%s  %s\n' "$uboot_overload_sha256" "$uboot_file" | sha256sum --check --status
[[ "$(stat -c %s "$uboot_file")" -eq "$uboot_overload_size" ]] || {
  echo 'U-Boot overload size does not match provenance' >&2
  exit 1
}
derived_uboot="$boot_mount/u-boot.ext"
[[ -s "$derived_uboot" ]] || { echo 'missing source-built u-boot.ext' >&2; exit 1; }
printf '%s  %s\n' "$uboot_overload_sha256" "$derived_uboot" | sha256sum --check --status
[[ "$(stat -c %s "$derived_uboot")" -eq "$uboot_overload_size" ]] || {
  echo 'u-boot.ext size does not match the independent source build' >&2
  exit 1
}
if find "$root_mount/usr/lib/u-boot" -type f -print -quit 2>/dev/null | grep -q .; then
  echo 'unexpected U-Boot file found in rootfs' >&2
  exit 1
fi
while IFS= read -r uboot_file; do
  case "$(basename "$uboot_file")" in
    "$uboot_name" | u-boot.ext) ;;
    *) echo "unexpected U-Boot file found in boot partition: $uboot_file" >&2; exit 1 ;;
  esac
done < <(find "$boot_mount" -type f \( -name 'u-boot*' -o -name '*-u-boot*.bin*' -o -name '*-bootloader.img' \) -print)
for legacy_payload in u-boot.sd u-boot.usb; do
  if find "$boot_mount" "$root_mount" -xdev -type f -name "$legacy_payload" -print -quit | grep -q .; then
    echo "prohibited legacy U-Boot payload found: $legacy_payload" >&2
    exit 1
  fi
done
while IFS= read -r boot_binary; do
  case "$(basename "$boot_binary")" in
    "$uboot_name" | initrd.img | initrd.img-*) ;;
    *.bin | *.img | *.itb | *.fip | *.elf | bl2* | bl30* | bl31* | bl32* | *bootloader*)
      echo "unexpected boot binary found: $boot_binary" >&2
      exit 1
      ;;
  esac
done < <(find "$boot_mount" -type f \( \
  -name '*.bin' -o -name '*.img' -o -name '*.itb' -o -name '*.fip' -o -name '*.elf' \
  -o -iname 'bl2*' -o -iname 'bl30*' -o -iname 'bl31*' -o -iname 'bl32*' -o -iname '*bootloader*' \
\) -print)

kernel_check="$tmp_dir/kernel.image"
if [[ "$kernel_file" == *.gz ]]; then gzip -dc "$kernel_file" > "$kernel_check"; else cp -- "$kernel_file" "$kernel_check"; fi
file "$kernel_check" | grep -Eiq 'aarch64|arm64'
fdtget "$dtb_file" / compatible | node "$script_dir/validate-dtb-compatible.mjs" amlogic,p212
systemctl --root="$root_mount" list-unit-files ssh.service --no-legend | grep -q '^ssh.service'
proot -q /usr/bin/qemu-aarch64-static -R "$root_mount" /bin/sh -ec \
  'test -x /usr/lib/systemd/systemd; /usr/lib/systemd/systemd --version >/dev/null; test -x /usr/sbin/sshd'
package_state_output="$tmp_dir/package-state.txt"
proot -q /usr/bin/qemu-aarch64-static -R "$root_mount" /usr/bin/dpkg-query \
  --show "--showformat=\${binary:Package}\t\${Status}\n" |
  awk '$3 != "ok" || ($4 != "installed" && $4 != "config-files") {print}' > "$package_state_output"
[[ ! -s "$package_state_output" ]] || {
  cat "$package_state_output" >&2
  exit 1
}

for prohibited in system vendor recovery product odm system_ext apex vendor_dlkm odm_dlkm; do
  [[ ! -e "$root_mount/$prohibited" && ! -L "$root_mount/$prohibited" ]] || {
    echo "prohibited Android path: /$prohibited" >&2
    exit 1
  }
done
[[ ! -e "$root_mount/init" && ! -L "$root_mount/init" ]] || {
  echo 'prohibited Android root entry: /init' >&2
  exit 1
}
if find "$root_mount" -xdev -type f \( -name 'build.prop' -o -name '*.apk' -o -name 'launcher*.apk' \) -print -quit | grep -q .; then
  echo 'prohibited Android userspace file found' >&2
  exit 1
fi
for artifact in boot.img logo.img recovery.img system.img vendor_boot.img super.img dtbo.img vbmeta.img payload.bin; do
  if find "$boot_mount" "$root_mount" -xdev -type f -name "$artifact" -print -quit | grep -q .; then
    echo "prohibited Android image artifact found: $artifact" >&2
    exit 1
  fi
done

dtb_source="$tmp_dir/device-tree.dts"
dtc -I dtb -O dts -o "$dtb_source" "$dtb_file"
initrd_root="$tmp_dir/initrds"
mkdir -p "$initrd_root"
for initrd_file in "${initrd_files[@]}"; do
  initrd_name=$(basename "$initrd_file")
  initrd_dir="$initrd_root/$initrd_name"
  initrd_payload="$tmp_dir/$initrd_name.payload"
  mkdir -p "$initrd_dir"
  if [[ "$initrd_name" == uInitrd ]]; then
    dumpimage -T ramdisk -p 0 -o "$initrd_payload" "$initrd_file"
  else
    cp -- "$initrd_file" "$initrd_payload"
  fi
  lsinitramfs -l "$initrd_payload" >/dev/null
  unmkinitramfs "$initrd_payload" "$initrd_dir"
done
qemu_initrd_payload="$tmp_dir/$(basename "$active_initrd_file").payload"
[[ -f "$qemu_initrd_payload" ]] || { echo "active initrd payload is missing: $qemu_initrd_payload" >&2; exit 1; }
"$script_dir/qemu-system-smoke.sh" \
  "$raw" \
  "${active_kernel_rel#/}" "$active_kernel_file" "$kernel_check" \
  "${active_initrd_rel#/}" "$active_initrd_file" "$qemu_initrd_payload" \
  "$root_uuid" "$manifest" "$qemu_system_smoke"
[[ -s "$qemu_system_smoke" && -s "$qemu_system_console" ]] || {
  echo 'QEMU system smoke evidence is incomplete' >&2
  exit 1
}
kernel_release=$(node - "$qemu_system_smoke" "$kernel_version" <<'NODE'
const fs = require('node:fs');
const smoke = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const kernelVersion = process.argv[3];
if (typeof smoke.kernelRelease !== 'string'
  || !/^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(smoke.kernelRelease)
  || !smoke.kernelRelease.startsWith(`${kernelVersion}-`)) {
  throw new Error('QEMU kernel release evidence is invalid');
}
process.stdout.write(smoke.kernelRelease);
NODE
)
if [[ "$image_identity_required" == true && "$identity_kernel_release" != "$kernel_release" ]]; then
  echo 'image identity kernel release does not match the booted kernel' >&2
  exit 1
fi
node "$script_dir/validate-rtl8189fs.mjs" "$root_mount" "$kernel_release" > "$rtl8189fs_evidence"
[[ -s "$rtl8189fs_evidence" ]] || { echo 'RTL8189FS validation evidence is empty' >&2; exit 1; }

node "$script_dir/scan-mounted-image.mjs" \
  --root "$root_mount" \
  --boot "$boot_mount" \
  --initrd-root "$initrd_root" \
  --dtb-source "$dtb_source" \
  --dtb-name "$dtb_name" \
  --uboot-name "$uboot_name" \
  --expected-codename "$debian_codename" \
  --expected-major-version "$debian_major_version" \
  --output "$tmp_dir/content-scan.json" \
  --boot-components "$boot_components"

(
  cd "$root_mount"
  LC_ALL=C find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
) > "$filesystem_manifest"
[[ -s "$filesystem_manifest" ]] || { echo 'filesystem manifest is empty' >&2; exit 1; }
if [[ "$image_identity_required" == true ]]; then
  image_identity_sha256=$(sha256sum "$image_identity" | awk '{print $1}')
  identity_manifest_line="$image_identity_sha256  ./usr/lib/b860av1-t/image-identity.json"
  [[ "$(grep -Fxc -- "$identity_manifest_line" "$filesystem_manifest")" -eq 1 ]] || {
    echo 'image identity is not uniquely bound to the filesystem manifest' >&2
    exit 1
  }
fi

node "$script_dir/validate-hardware-capabilities.mjs" \
  --root "$root_mount" \
  --dtb "$dtb_file" \
  --dtb-path "dtb/amlogic/$dtb_name" \
  --kernel-release "$kernel_release" \
  --manifest "$manifest" \
  --filesystem-manifest "$filesystem_manifest" \
  --boot-components "$boot_components" \
  --rtl8189fs "$rtl8189fs_evidence" \
  --recipe "$script_dir/../config/hardware-capabilities.json" \
  --output "$hardware_capabilities_evidence"
[[ -s "$hardware_capabilities_evidence" ]] || {
  echo 'hardware capability validation evidence is empty' >&2
  exit 1
}

image_sha256=$(sha256sum "$image" | awk '{print $1}')
raw_sha256=$(sha256sum "$raw" | awk '{print $1}')
filesystem_manifest_sha256=$(sha256sum "$filesystem_manifest" | awk '{print $1}')
boot_components_sha256=$(sha256sum "$boot_components" | awk '{print $1}')
uboot_build_sha256=$(sha256sum "$uboot_build" | awk '{print $1}')
uboot_source_archive="$(dirname "$uboot_build")/u-boot-source.tar.gz"
[[ -s "$uboot_source_archive" ]] || { echo 'U-Boot source archive is missing' >&2; exit 1; }
uboot_source_archive_sha256=$(sha256sum "$uboot_source_archive" | awk '{print $1}')
third_party_sources_sha256=$(sha256sum "$third_party_sources" | awk '{print $1}')
source_built_dtb_evidence_sha256=$(sha256sum "$source_built_dtb_evidence" | awk '{print $1}')
device_tree_source_sha256=$(sha256sum "$device_tree_source" | awk '{print $1}')
qemu_system_smoke_sha256=$(sha256sum "$qemu_system_smoke" | awk '{print $1}')
qemu_system_console_sha256=$(sha256sum "$qemu_system_console" | awk '{print $1}')
rtl8189fs_evidence_sha256=$(sha256sum "$rtl8189fs_evidence" | awk '{print $1}')
hardware_capabilities_sha256=$(sha256sum "$hardware_capabilities_evidence" | awk '{print $1}')
IMAGE_SHA256="$image_sha256" RAW_SHA256="$raw_sha256" MANIFEST_FINGERPRINT="$manifest_fingerprint" REPORT="$report" IMAGE="$image" FILESYSTEM_MANIFEST_SHA256="$filesystem_manifest_sha256" BOOT_COMPONENTS_SHA256="$boot_components_sha256" UBOOT_BUILD_SHA256="$uboot_build_sha256" UBOOT_SOURCE_ARCHIVE_SHA256="$uboot_source_archive_sha256" THIRD_PARTY_SOURCES_SHA256="$third_party_sources_sha256" SOURCE_BUILT_DTB_EVIDENCE_SHA256="$source_built_dtb_evidence_sha256" DEVICE_TREE_SOURCE_SHA256="$device_tree_source_sha256" QEMU_SYSTEM_SMOKE_SHA256="$qemu_system_smoke_sha256" QEMU_SYSTEM_CONSOLE_SHA256="$qemu_system_console_sha256" RTL8189FS_EVIDENCE_SHA256="$rtl8189fs_evidence_sha256" HARDWARE_CAPABILITIES_SHA256="$hardware_capabilities_sha256" IMAGE_IDENTITY_REQUIRED="$image_identity_required" CONTENT_SCAN="$tmp_dir/content-scan.json" node - <<'NODE'
const fs = require('node:fs');
const androidScan = JSON.parse(fs.readFileSync(process.env.CONTENT_SCAN, 'utf8'));
const requiredScanChecks = [
  'debianIdentity',
  'debianStableRelease',
  'armbianIdentity',
  'knownAndroidMarkersAbsent',
  'initrdKnownAndroidMarkersAbsent',
  'bootConfigKnownAndroidMarkersAbsent',
  'dtbKnownAndroidMarkersAbsent',
];
for (const check of requiredScanChecks) {
  if (androidScan.checks?.[check] !== true) throw new Error(`content scan check failed: ${check}`);
}
const result = {
  schemaVersion: 8,
  status: 'container-valid / hardware-unverified',
  image: process.env.IMAGE,
  imageSha256: process.env.IMAGE_SHA256,
  rawSha256: process.env.RAW_SHA256,
  manifestFingerprint: process.env.MANIFEST_FINGERPRINT,
  evidence: {
    filesystemManifest: 'filesystem-manifest.sha256',
    filesystemManifestSha256: process.env.FILESYSTEM_MANIFEST_SHA256,
    bootComponents: 'boot-components.json',
    bootComponentsSha256: process.env.BOOT_COMPONENTS_SHA256,
    ubootBuild: 'uboot-build.json',
    ubootBuildSha256: process.env.UBOOT_BUILD_SHA256,
    ubootSourceArchive: 'u-boot-source.tar.gz',
    ubootSourceArchiveSha256: process.env.UBOOT_SOURCE_ARCHIVE_SHA256,
    thirdPartySources: 'THIRD_PARTY_SOURCES.md',
    thirdPartySourcesSha256: process.env.THIRD_PARTY_SOURCES_SHA256,
    sourceBuiltDeviceTree: {
      build: 'source-built-dtb.json',
      buildSha256: process.env.SOURCE_BUILT_DTB_EVIDENCE_SHA256,
      source: 'device-tree-source.dts',
      sourceSha256: process.env.DEVICE_TREE_SOURCE_SHA256,
    },
    qemuSystemSmoke: 'qemu-system-smoke.json',
    qemuSystemSmokeSha256: process.env.QEMU_SYSTEM_SMOKE_SHA256,
    qemuSystemConsole: 'qemu-system-smoke.log',
    qemuSystemConsoleSha256: process.env.QEMU_SYSTEM_CONSOLE_SHA256,
    rtl8189fsDriver: 'rtl8189fs-driver.json',
    rtl8189fsDriverSha256: process.env.RTL8189FS_EVIDENCE_SHA256,
    hardwareCapabilities: 'hardware-capabilities.json',
    hardwareCapabilitiesSha256: process.env.HARDWARE_CAPABILITIES_SHA256,
  },
  androidScan: {
    schemaVersion: androidScan.schemaVersion,
    findings: androidScan.findings,
  },
  checks: {
    gzip: true,
    partitionTable: true,
    fatBoot: true,
    ext4Rootfs: true,
    debianStableRelease: androidScan.checks.debianStableRelease,
    debianIdentity: androidScan.checks.debianIdentity,
    armbianIdentity: androidScan.checks.armbianIdentity,
    bootFiles: true,
    memoryLimitApplied: true,
    stockBootScriptStaticPathValid: true,
    primaryBootScriptAndroidFallbackAbsent: true,
    installerBootScriptAndroidFallbackAbsent: true,
    kernelArchitecture: true,
    dtbCompatible: true,
    rootfsLabel: true,
    userspaceSmoke: true,
    packageState: true,
    sshUnit: true,
    imageFits8GB: true,
    mbrBootstrapEmpty: true,
    mbrReservedBytesEmpty: true,
    partitionStartMatchesManifest: true,
    persistentBootloaderAbsent: true,
    bootloaderPayloadsExcluded: true,
    legacyUbootPayloadsAbsent: true,
    knownAndroidMarkersAbsent: androidScan.checks.knownAndroidMarkersAbsent,
    initrdKnownAndroidMarkersAbsent: androidScan.checks.initrdKnownAndroidMarkersAbsent,
    bootConfigKnownAndroidMarkersAbsent: androidScan.checks.bootConfigKnownAndroidMarkersAbsent,
    dtbKnownAndroidMarkersAbsent: androidScan.checks.dtbKnownAndroidMarkersAbsent,
    filesystemManifestCreated: true,
    bootComponentsRecorded: true,
    ubootOverloadProvenance: true,
    sourceBuiltUbootOverload: true,
    sourceBuiltDeviceTree: true,
    qemuSystemBootSmoke: true,
      rtl8189fsDriver: true,
      hardwareCapabilities: true,
      ...(process.env.IMAGE_IDENTITY_REQUIRED === 'true' ? { imageIdentity: true } : {}),
    },
};
fs.writeFileSync(process.env.REPORT, `${JSON.stringify(result, null, 2)}\n`);
NODE
