#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

usage() {
  echo "usage: $0 manifest.json output-dir" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
manifest=$1
output_dir=$2
[[ -f "$manifest" ]] || { echo "manifest not found: $manifest" >&2; exit 1; }
mkdir -p "$output_dir"

tmp_dir=$(mktemp -d)
image_loop=''
image_root_mount="$tmp_dir/image-root"
cleanup() {
  set +e
  mountpoint -q "$image_root_mount" && sudo umount "$image_root_mount"
  [[ -n "$image_loop" ]] && sudo losetup --detach "$image_loop"
  sudo rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

mapfile -t source_values < <(node - "$manifest" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = manifest.sources?.base;
const kernel = manifest.sources?.kernel;
const builder = manifest.sources?.builder;
const board = manifest.board;
if (![4, 5].includes(manifest.schemaVersion) || board?.ubootOverloadBuild?.reproducibleFromSource !== true) {
  throw new Error('manifest must use the source-built U-Boot schema');
}
const required = [
  base?.url ?? base?.browser_download_url,
  base?.digest,
  base?.name,
  kernel?.url ?? kernel?.browser_download_url,
  kernel?.digest,
  kernel?.version,
  builder?.repository ?? 'https://github.com/ophub/amlogic-s9xxx-armbian.git',
  builder?.commit,
  board?.profile,
  board?.memoryLimitMiB,
  board?.ubootOverload,
  board?.dtb,
];
for (const [index, value] of required.entries()) {
  if (index === 9) {
    if (!Number.isInteger(value)) throw new Error('manifest memory limit is required');
    console.log(value);
  } else {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`manifest source ${index} is required`);
    console.log(value.replace(/^sha256:/i, ''));
  }
}
NODE
)
[[ ${#source_values[@]} -eq 12 ]] || { echo "manifest source extraction failed" >&2; exit 1; }
base_url=${source_values[0]}
base_digest=${source_values[1]}
base_name=${source_values[2]}
kernel_url=${source_values[3]}
kernel_digest=${source_values[4]}
kernel_version=${source_values[5]}
builder_repository=${source_values[6]}
builder_commit=${source_values[7]}
board_profile=${source_values[8]}
memory_limit_mib=${source_values[9]}
allowed_overload=${source_values[10]}
board_dtb=${source_values[11]}
for digest in "$base_digest" "$kernel_digest"; do
  [[ "$digest" =~ ^[[:xdigit:]]{64}$ ]] || { echo "invalid SHA-256 digest" >&2; exit 1; }
done
for commit in "$builder_commit"; do
  [[ "$commit" =~ ^[[:xdigit:]]{40}$ ]] || { echo "invalid source commit" >&2; exit 1; }
done
[[ "$board_profile" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || { echo "invalid board profile" >&2; exit 1; }
[[ "$allowed_overload" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "invalid allowed U-Boot overload name" >&2
  exit 1
}
[[ "$board_dtb" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.dtb$ ]] || {
  echo "invalid board DTB name" >&2
  exit 1
}
[[ "$memory_limit_mib" =~ ^[0-9]+$ && "$memory_limit_mib" -ge 256 && "$memory_limit_mib" -le 4096 ]] || {
  echo 'invalid memory limit' >&2
  exit 1
}

download_and_verify() {
  local url=$1 digest=$2 output=$3
  curl --fail --location --retry 3 --retry-delay 2 --output "$output" "$url"
  printf '%s  %s\n' "$digest" "$output" | sha256sum --check --status
}

base_download="$tmp_dir/base.download"
download_and_verify "$base_url" "$base_digest" "$base_download"
kernel_download="$tmp_dir/kernel.tar.gz"
download_and_verify "$kernel_url" "$kernel_digest" "$kernel_download"

clone_exact() {
  local repository=$1 commit=$2 destination=$3
  case "$repository" in
    https://*|http://*|git@*|file://*) ;;
    */*) repository="https://github.com/${repository}.git" ;;
    *) echo "unsupported repository identifier: $repository" >&2; exit 1 ;;
  esac
  git clone --filter=blob:none --no-checkout --quiet "$repository" "$destination"
  git -C "$destination" fetch --quiet --depth=1 origin "$commit"
  git -C "$destination" checkout --detach --quiet "$commit"
  [[ "$(git -C "$destination" rev-parse HEAD)" == "$commit" ]] || {
    echo "exact checkout failed for $repository" >&2
    exit 1
  }
}

tree_digest() {
  local path=$1
  LC_ALL=C find "$path" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
}

builder_dir="$tmp_dir/builder"
clone_exact "$builder_repository" "$builder_commit" "$builder_dir"
[[ -x "$builder_dir/rebuild" ]] || { echo "ophub rebuild script is missing" >&2; exit 1; }
node "$script_dir/disable-binary-dependency-downloads.mjs" "$builder_dir/rebuild"

firmware_target="$builder_dir/build-armbian/armbian-files/common-files/usr/lib/firmware"
mkdir -p "$builder_dir/build-armbian/u-boot/amlogic/overload" "$firmware_target"
model_database="$builder_dir/build-armbian/armbian-files/common-files/etc/model_database.conf"
node "$script_dir/install-board-profile.mjs" "$model_database" "$script_dir/../config/b860av1-t-model.conf"
platform_bootfs="$builder_dir/build-armbian/armbian-files/platform-files/amlogic/bootfs"
source_built_dtb_dir="$tmp_dir/source-built-dtb"
"$script_dir/build-board-dtb.sh" "$manifest" "$source_built_dtb_dir"
platform_dtb_dir="$platform_bootfs/dtb/amlogic"
mkdir -p "$platform_dtb_dir"
install -m 0644 -- "$source_built_dtb_dir/$board_dtb" "$platform_dtb_dir/$board_dtb"
for boot_config in "$platform_bootfs/uEnv.txt" "$platform_bootfs/extlinux/extlinux.conf.bak"; do
  [[ -f "$boot_config" ]] || continue
  node "$script_dir/patch-boot-config.mjs" "$boot_config" "$memory_limit_mib"
done
pure_boot_script="$script_dir/../config/s905-autoscript.cmd"
pure_installer_script="$script_dir/../config/aml-autoscript.cmd"
[[ -s "$pure_boot_script" && -s "$pure_installer_script" ]] || {
  echo 'repository-owned U-Boot script source is missing' >&2
  exit 1
}
command -v mkimage >/dev/null || { echo 'mkimage is required to build s905_autoscript' >&2; exit 1; }
command -v dumpimage >/dev/null || { echo 'dumpimage is required to verify s905_autoscript' >&2; exit 1; }
install -m 0644 -- "$pure_boot_script" "$platform_bootfs/s905_autoscript.cmd"
SOURCE_DATE_EPOCH=0 mkimage -C none -A arm -T script -d "$pure_boot_script" "$platform_bootfs/s905_autoscript" >/dev/null
decoded_boot_script="$tmp_dir/s905_autoscript.cmd"
dumpimage_payload="$tmp_dir/s905_autoscript.payload"
dumpimage -T script -p 0 -o "$dumpimage_payload" "$platform_bootfs/s905_autoscript" >/dev/null
node "$script_dir/extract-uboot-script-payload.mjs" \
  "$platform_bootfs/s905_autoscript" "$dumpimage_payload" "$decoded_boot_script"
cmp -- "$pure_boot_script" "$decoded_boot_script"
node "$script_dir/validate-boot-script.mjs" s905 "$decoded_boot_script"
install -m 0644 -- "$pure_installer_script" "$platform_bootfs/aml_autoscript.cmd"
SOURCE_DATE_EPOCH=0 mkimage -C none -A arm -T script -d "$pure_installer_script" "$platform_bootfs/aml_autoscript" >/dev/null
decoded_installer_script="$tmp_dir/aml_autoscript.cmd"
installer_script_payload="$tmp_dir/aml_autoscript.payload"
dumpimage -T script -p 0 -o "$installer_script_payload" "$platform_bootfs/aml_autoscript" >/dev/null
node "$script_dir/extract-uboot-script-payload.mjs" \
  "$platform_bootfs/aml_autoscript" "$installer_script_payload" "$decoded_installer_script"
cmp -- "$pure_installer_script" "$decoded_installer_script"
node "$script_dir/validate-boot-script.mjs" aml "$decoded_installer_script"
for legacy_payload in u-boot.sd u-boot.usb; do
  rm -f -- "$platform_bootfs/$legacy_payload"
done
bootloader_dir="$builder_dir/build-armbian/u-boot/amlogic/bootloader"
overload_dir="$builder_dir/build-armbian/u-boot/amlogic/overload"

dependency_file="$builder_dir/compile-kernel/tools/script/ubuntu2404-build-armbian-depends"
[[ -f "$dependency_file" ]] || {
  echo "builder dependency manifest is missing: $dependency_file" >&2
  exit 1
}
xargs -r sudo apt-get install --yes < "$dependency_file"

source_built_dir="$tmp_dir/source-built-uboot"
"$script_dir/build-uboot-overload.sh" "$manifest" "$source_built_dir"
source_built_overload="$source_built_dir/$allowed_overload"
[[ -s "$source_built_overload" ]] || { echo 'source-built overload is missing' >&2; exit 1; }
cp -- "$source_built_overload" "$overload_dir/$allowed_overload"
install -m 0644 -- "$source_built_overload" "$platform_bootfs/u-boot.ext"
rm -rf -- "$bootloader_dir"
find "$overload_dir" -mindepth 1 -maxdepth 1 ! -name "$allowed_overload" -exec rm -rf -- {} +
mapfile -t overload_entries < <(find "$overload_dir" -mindepth 1 -maxdepth 1 -print)
[[ ${#overload_entries[@]} -eq 1 && "$(basename "${overload_entries[0]}")" == "$allowed_overload" ]] || {
  echo 'U-Boot overload whitelist was not applied' >&2
  exit 1
}
uboot_tree_before=$(tree_digest "$builder_dir/build-armbian/u-boot")
firmware_tree_before=$(tree_digest "$firmware_target")

kernel_dir="$builder_dir/build-armbian/kernel/stable"
mkdir -p "$kernel_dir"
tar --extract --gzip --file "$kernel_download" --directory "$kernel_dir"
[[ -d "$kernel_dir/$kernel_version" ]] || {
  echo "locked kernel archive lacks $kernel_version directory" >&2
  exit 1
}

image_dir="$builder_dir/build/output/images"
mkdir -p "$image_dir"
rm -f "$image_dir"/*.img "$image_dir"/*.img.gz
[[ "$base_name" == *.img.gz ]] || {
  echo "resolved base asset is not a gzip raw image: $base_name" >&2
  exit 1
}
base_image="$image_dir/${base_name%.gz}"
case "$base_name" in
  *.img.gz) gzip --decompress --stdout "$base_download" > "$base_image" ;;
  *.img.xz) xz --decompress --stdout "$base_download" > "$base_image" ;;
  *) cp -- "$base_download" "$base_image" ;;
esac
[[ -s "$base_image" ]] || { echo "decompressed base image is empty" >&2; exit 1; }

pushd "$builder_dir" >/dev/null
sudo ./rebuild -b "$board_profile" -k "$kernel_version" -a false -t ext4 -s 512/3000
popd >/dev/null
[[ "$(tree_digest "$builder_dir/build-armbian/u-boot")" == "$uboot_tree_before" ]] || {
  echo 'locked U-Boot tree changed during rebuild' >&2
  exit 1
}
[[ "$(tree_digest "$firmware_target")" == "$firmware_tree_before" ]] || {
  echo 'offline firmware guard tree changed during rebuild' >&2
  exit 1
}
mapfile -t built_images < <(find "$image_dir" -maxdepth 1 -type f -name '*.img.gz' -print | sort)
[[ ${#built_images[@]} -eq 1 ]] || {
  printf 'expected one rebuilt image, found %s\n' "${#built_images[@]}" >&2
  printf '%s\n' "${built_images[@]}" >&2
  exit 1
}

image_name="$(basename "${built_images[0]}")"
sanitized_raw="$tmp_dir/${image_name%.gz}"
gzip --decompress --stdout "${built_images[0]}" > "$sanitized_raw"
image_loop=$(sudo losetup --find --show --partscan "$sanitized_raw")
sudo udevadm settle
mapfile -t image_partitions < <(
  lsblk --noheadings --list --output NAME,TYPE "$image_loop" |
    awk '$2 == "part" {print "/dev/" $1}'
)
[[ ${#image_partitions[@]} -eq 2 ]] || {
  echo "expected two rebuilt image partitions, found ${#image_partitions[@]}" >&2
  exit 1
}
root_partition=${image_partitions[1]}
[[ "$(sudo blkid -s TYPE -o value "$root_partition")" == ext4 ]] || {
  echo 'rebuilt image root partition is not ext4' >&2
  exit 1
}
mkdir -p "$image_root_mount"
sudo mount -o rw "$root_partition" "$image_root_mount"
mapfile -t kernel_configs < <(
  sudo find "$image_root_mount/usr/src" -type f \
    -path "*/linux-headers-${kernel_version}-*/include/config/auto.conf" -print | sort
)
[[ ${#kernel_configs[@]} -eq 1 ]] || {
  echo "expected one installed kernel config, found ${#kernel_configs[@]}" >&2
  exit 1
}
kernel_header_root=${kernel_configs[0]%/include/config/auto.conf}
kernel_release=${kernel_header_root##*/linux-headers-}
[[ "$kernel_release" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$ ]] || {
  echo "invalid installed kernel release: $kernel_release" >&2
  exit 1
}
sudo env "PATH=$PATH" node "$script_dir/write-image-identity.mjs" \
  "$image_root_mount" "$manifest" "$kernel_release" > "$tmp_dir/image-identity.json"
sudo test -s "$image_root_mount/usr/lib/b860av1-t/image-identity.json"
sudo umount "$image_root_mount"
set +e
sudo e2fsck -fy "$root_partition"
e2fsck_status=$?
set -e
[[ "$e2fsck_status" -le 1 ]] || { echo 'rebuilt rootfs check failed' >&2; exit 1; }
sudo losetup --detach "$image_loop"
image_loop=''
node "$script_dir/sanitize-raw-image.mjs" "$sanitized_raw" "$manifest"
gzip --no-name --stdout "$sanitized_raw" > "$output_dir/$image_name"
gzip -t "$output_dir/$image_name"
cp -- "$manifest" "$output_dir/resolved-sources.json"
node "$script_dir/write-build-input-heads.mjs" "$manifest" "$output_dir/build-input-heads.json"
(
  cd "$output_dir"
  sha256sum -- "$image_name" > SHA256SUMS
)
printf '%s\n' "$output_dir/$image_name"
