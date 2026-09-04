#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd -- "$script_dir/.." && pwd)
fixture_root=${B860_DEVICE_FIXTURE_ROOT:-}
non_interactive=false
release_metadata=''
output_dir=''
serial_log=''
health_endpoint=''
hdmi_visible=false
infrared_key_seen=false
usb_vendor_id=''
usb_product_id=''
usage() {
  echo "usage: $0 --release-metadata file --output dir --serial-log file [options]" >&2
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-metadata) release_metadata=${2:-}; shift 2 ;;
    --output) output_dir=${2:-}; shift 2 ;;
    --serial-log) serial_log=${2:-}; shift 2 ;;
    --health-endpoint) health_endpoint=${2:-}; shift 2 ;;
    --usb-vendor-id) usb_vendor_id=${2:-}; shift 2 ;;
    --usb-product-id) usb_product_id=${2:-}; shift 2 ;;
    --hdmi-visible) hdmi_visible=true; shift ;;
    --infrared-key-seen) infrared_key_seen=true; shift ;;
    --non-interactive) non_interactive=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[[ -f "$release_metadata" && -f "$serial_log" && -n "$output_dir" ]] || usage
if [[ -n "$fixture_root" && "$non_interactive" != true ]]; then
  echo 'fixture mode requires --non-interactive' >&2
  exit 1
fi
if [[ -z "$health_endpoint" || ! "$health_endpoint" =~ ^https:// ]]; then
  echo 'an HTTPS --health-endpoint is required' >&2
  exit 1
fi
[[ "$usb_vendor_id" =~ ^[0-9a-fA-F]{4}$ && "$usb_product_id" =~ ^[0-9a-fA-F]{4}$ ]] || {
  echo 'USB vendor and product IDs are required' >&2
  exit 1
}
usb_vendor_id=$(printf '%s' "$usb_vendor_id" | tr 'A-F' 'a-f')
usb_product_id=$(printf '%s' "$usb_product_id" | tr 'A-F' 'a-f')
[[ "$hdmi_visible" == true && "$infrared_key_seen" == true ]] || {
  echo 'HDMI and infrared observations are required' >&2
  exit 1
}
for required in node git sha256sum dd findmnt blockdev ip iw curl; do
  command -v "$required" >/dev/null || { echo "$required is required" >&2; exit 1; }
done
tmp_dir=$(mktemp -d)
cleanup() { rm -rf -- "$tmp_dir"; }
trap cleanup EXIT
umask 077
metadata_values=()
metadata_lines="$tmp_dir/release-metadata.lines"
node - "$release_metadata" > "$metadata_lines" <<'NODE'
import fs from 'node:fs';
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fields = [
  'repository', 'tag', 'image', 'imageSha256', 'rawSha256', 'manifestFingerprint',
  'kernelVersion', 'kernelRelease', 'identitySha256',
];
const required = {
  repository: /^wuhao1477\/b860av1-t-armbian-burn-builder$/,
  tag: /^armbian-[A-Za-z0-9._+-]+-debian-[A-Za-z0-9._+-]+-k\d+\.\d+\.\d+-build-\d+\.\d+$/,
  image: /^Armbian_[A-Za-z0-9._+-]+\.img\.gz$/,
  imageSha256: /^[0-9a-f]{64}$/,
  rawSha256: /^[0-9a-f]{64}$/,
  manifestFingerprint: /^[0-9a-f]{64}$/,
  kernelVersion: /^\d+\.\d+\.\d+$/,
  kernelRelease: /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/,
  identitySha256: /^[0-9a-f]{64}$/,
};
for (const field of fields) {
  if (typeof value[field] !== 'string' || !required[field].test(value[field])) {
    throw new Error(`invalid release metadata ${field}`);
  }
  process.stdout.write(`${value[field]}\n`);
}
if (!value.kernelRelease.startsWith(`${value.kernelVersion}-`)) {
  throw new Error('release metadata kernel binding is invalid');
}
NODE
while IFS= read -r value; do metadata_values+=("$value"); done < "$metadata_lines"
[[ ${#metadata_values[@]} -eq 9 ]] || { echo 'release metadata is incomplete' >&2; exit 1; }
repository=${metadata_values[0]}
tag=${metadata_values[1]}
image_name=${metadata_values[2]}
image_sha256=${metadata_values[3]}
raw_sha256=${metadata_values[4]}
manifest_fingerprint=${metadata_values[5]}
kernel_version=${metadata_values[6]}
kernel_release=${metadata_values[7]}
identity_sha256=${metadata_values[8]}
root_path() {
  local absolute=$1
  if [[ -n "$fixture_root" ]]; then
    printf '%s%s\n' "$fixture_root" "$absolute"
  else
    printf '%s\n' "$absolute"
  fi
}
sys_root=$(root_path /sys)
proc_root=$(root_path /proc)
boot_root=$(root_path /boot)
identity_path=$(root_path /usr/lib/b860av1-t/image-identity.json)
[[ -f "$identity_path" ]] || { echo 'image identity is missing from the running rootfs' >&2; exit 1; }
actual_identity_sha256=$(sha256sum -- "$identity_path" | awk '{print $1}')
[[ "$actual_identity_sha256" == "$identity_sha256" ]] || {
  echo 'image identity digest does not match release metadata' >&2
  exit 1
}
running_kernel=$(cat "$proc_root/sys/kernel/osrelease" 2>/dev/null || uname -r)
[[ "$running_kernel" == "$kernel_release" ]] || {
  echo 'running kernel release does not match release metadata' >&2
  exit 1
}
model_file=$(root_path /proc/device-tree/model)
compatible_file=$(root_path /proc/device-tree/compatible)
[[ -s "$model_file" && -s "$compatible_file" ]] || { echo 'device-tree identity is missing' >&2; exit 1; }
observed_model=$(tr -d '\000\n' < "$model_file")
compatible=$(tr '\000' ' ' < "$compatible_file" | tr '\n' ' ' | xargs)
emmc_dir=''
for candidate in "$sys_root"/block/mmcblk*; do
  if [[ -d "$candidate" ]]; then emmc_dir=$candidate; break; fi
done
[[ -n "$emmc_dir" ]] || { echo 'eMMC block device is missing' >&2; exit 1; }
root_source=$(findmnt -no SOURCE / | head -n 1)
[[ -n "$root_source" ]] || { echo 'root source cannot be identified' >&2; exit 1; }
emmc_device=$root_source
if [[ -n "$fixture_root" && "$emmc_device" == /dev/* ]]; then emmc_device=$(root_path "$emmc_device"); fi
[[ -e "$emmc_device" ]] || emmc_device=$(root_path /dev/mmcblk0)
capacity_bytes=$(blockdev --getsize64 "$emmc_device")
[[ "$capacity_bytes" =~ ^[0-9]+$ && "$capacity_bytes" -gt 0 ]] || { echo 'eMMC capacity is invalid' >&2; exit 1; }
emmc_probe="$tmp_dir/emmc-read.bin"
dd if="$emmc_device" of="$emmc_probe" iflag=direct bs=512 count=8 status=none
read_only_probe_bytes=$(wc -c < "$emmc_probe" | tr -d ' ')
[[ "$read_only_probe_bytes" =~ ^[0-9]+$ && "$read_only_probe_bytes" -gt 0 ]] || { echo 'eMMC read-only probe failed' >&2; exit 1; }
ethernet=''
for candidate in "$sys_root"/class/net/*; do
  [[ -d "$candidate" ]] || continue
  interface=${candidate##*/}
  [[ "$interface" == wlan* ]] && continue
  [[ "$(cat "$candidate/carrier" 2>/dev/null || true)" == 1 ]] || continue
  [[ "$(cat "$candidate/operstate" 2>/dev/null || true)" == up ]] || continue
  ethernet=$interface
  break
done
[[ -n "$ethernet" ]] || { echo 'Ethernet carrier is not present' >&2; exit 1; }
ip route show default | grep -q "dev $ethernet" || { echo 'Ethernet route is missing' >&2; exit 1; }
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "$health_endpoint" >/dev/null
hdmi_connector=''
for candidate in "$sys_root"/class/drm/*; do
  [[ -f "$candidate/status" ]] || continue
  [[ "$(tr -d '[:space:]' < "$candidate/status")" == connected ]] || continue
  hdmi_connector=$candidate
  break
done
[[ -n "$hdmi_connector" && "$hdmi_visible" == true ]] || { echo 'HDMI observation is incomplete' >&2; exit 1; }
[[ -f "$hdmi_connector/edid" ]] || { echo 'HDMI EDID is missing' >&2; exit 1; }
edid_sha256=$(sha256sum -- "$hdmi_connector/edid" | awk '{print $1}')
ir_device=''
for candidate in "$sys_root"/class/rc/* "$sys_root"/class/input/*; do
  [[ -e "$candidate" ]] || continue
  ir_device=$candidate
  break
done
[[ -n "$ir_device" && "$infrared_key_seen" == true ]] || { echo 'infrared observation is incomplete' >&2; exit 1; }
usb_device=''
for candidate in "$sys_root"/bus/usb/devices/*; do
  [[ -f "$candidate/idVendor" && -f "$candidate/idProduct" ]] || continue
  [[ "$(tr -d '[:space:]' < "$candidate/idVendor")" == "$usb_vendor_id" ]] || continue
  [[ "$(tr -d '[:space:]' < "$candidate/idProduct")" == "$usb_product_id" ]] || continue
  usb_device=$candidate
  break
done
[[ -n "$usb_device" ]] || { echo 'USB hotplug descriptor is missing' >&2; exit 1; }
wifi=''
for candidate in "$sys_root"/class/net/*; do
  [[ -d "$candidate" ]] || continue
  interface=${candidate##*/}
  [[ "$interface" == wlan* ]] || continue
  [[ -d "$sys_root/module/8189fs" ]] || continue
  [[ "$(iw dev "$interface" link 2>/dev/null || true)" == *Connected* ]] || continue
  wifi=$interface
  break
done
[[ -n "$wifi" ]] || { echo '8189fs Wi-Fi association is missing' >&2; exit 1; }
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "$health_endpoint" >/dev/null
kernel_path=''
for candidate in "$boot_root/zImage" "$boot_root/Image"; do
  if [[ -s "$candidate" ]]; then kernel_path=$candidate; break; fi
done
initrd_path="$boot_root/uInitrd"
config_path="$boot_root/uEnv.txt"
dtb_path="$boot_root/dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb"
[[ -s "$kernel_path" && -s "$initrd_path" && -s "$config_path" && -s "$dtb_path" ]] || {
  echo 'active boot components are incomplete' >&2
  exit 1
}
kernel_relative=${kernel_path#"$boot_root/"}
initrd_relative=${initrd_path#"$boot_root/"}
config_relative=${config_path#"$boot_root/"}
dtb_relative=${dtb_path#"$boot_root/"}
kernel_component_sha=$(sha256sum -- "$kernel_path" | awk '{print $1}')
initrd_component_sha=$(sha256sum -- "$initrd_path" | awk '{print $1}')
config_component_sha=$(sha256sum -- "$config_path" | awk '{print $1}')
dtb_component_sha=$(sha256sum -- "$dtb_path" | awk '{print $1}')
collector_commit=$(git -C "$project_root" rev-parse HEAD)
[[ "$collector_commit" =~ ^[0-9a-fA-F]{40}$ ]] || { echo 'collector commit is invalid' >&2; exit 1; }
collector_script_sha=$(sha256sum -- "$script_dir/collect-device-evidence.sh" | awk '{print $1}')
evidence_id=$(od -An -N8 -tx1 /dev/urandom | tr -d '[:space:]')
[[ "$evidence_id" =~ ^[0-9a-f]{16}$ ]] || { echo 'evidence id generation failed' >&2; exit 1; }
collected_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
challenge="B860_DEVICE_READY $evidence_id $manifest_fingerprint $kernel_release"
serial_work="$tmp_dir/device-serial.log"
cp -- "$serial_log" "$serial_work"
console_path=${B860_DEVICE_CONSOLE:-/dev/console}
if [[ -n "$fixture_root" ]]; then console_path="$tmp_dir/console"; fi
printf '%s\n' "$challenge" | tee -a "$serial_work" > "$console_path"
payload="$tmp_dir/payload.json"
node - "$payload" "$release_metadata" "$identity_path" "$observed_model" "$compatible" \
  "$collector_commit" "$collector_script_sha" "$running_kernel" \
  "$kernel_relative" "$kernel_component_sha" "$initrd_relative" "$initrd_component_sha" \
  "$dtb_relative" "$dtb_component_sha" "$config_relative" "$config_component_sha" \
  "$capacity_bytes" "$read_only_probe_bytes" "$edid_sha256" "$usb_vendor_id" "$usb_product_id" \
  "$evidence_id" "$collected_at" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const [payloadPath, metadataPath, identityPath, model, compatible, commit, scriptSha,
  kernelRelease, kernelPath, kernelSha, initrdPath, initrdSha, dtbPath, dtbSha,
  configPath, configSha, capacity, probeBytes, edidSha, vendorId, productId,
  evidenceId, collectedAt] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const payload = {
  schemaVersion: 1,
  status: 'passed',
  evidenceId,
  collectedAt,
  board: {
    profile: 'b860av1-t',
    declaredModel: 'ZXV10 B860AV1.1-T',
    observedModel: model,
    compatible: compatible.split(/\s+/).filter(Boolean),
  },
  release: {
    repository: metadata.repository,
    tag: metadata.tag,
    image: metadata.image,
    imageSha256: metadata.imageSha256,
    rawSha256: metadata.rawSha256,
    manifestFingerprint: metadata.manifestFingerprint,
  },
  identity: {
    path: identity.identityPath,
    sha256: sha(fs.readFileSync(identityPath)),
    manifestFingerprint: identity.manifestFingerprint,
    kernelVersion: identity.kernelVersion,
    kernelRelease: identity.kernelRelease,
  },
  collector: {
    repository: metadata.repository,
    commit,
    scriptPath: 'scripts/collect-device-evidence.sh',
    scriptSha256: scriptSha,
  },
  boot: {
    kernelRelease,
    components: [
      { role: 'kernel', path: kernelPath, sha256: kernelSha },
      { role: 'initrd', path: initrdPath, sha256: initrdSha },
      { role: 'dtb', path: dtbPath, sha256: dtbSha },
      { role: 'boot-config', path: configPath, sha256: configSha },
    ],
  },
  capabilities: {
    emmc: { passed: true, observations: { blockDevicePresent: true, rootSourceObserved: true, capacityBytes: Number(capacity), readOnlyProbeBytes: Number(probeBytes) } },
    ethernet: { passed: true, observations: { carrier: true, connectivity: true } },
    hdmi: { passed: true, observations: { connectorConnected: true, edidSha256: edidSha, linuxDisplayVisible: true } },
    infrared: { passed: true, observations: { inputDevicePresent: true, keyEventSeen: true, keyCode: 116 } },
    usb: { passed: true, observations: { hostPresent: true, hotplugSeen: true, vendorId, productId, readOnlyProbe: true } },
    wifi: { passed: true, observations: { driver: '8189fs', interfacePresent: true, associated: true, connectivity: true } },
  },
};
fs.writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
NODE
node "$script_dir/render-device-evidence.mjs" "$payload" "$serial_work" "$output_dir"
printf '%s\n' "$output_dir/device-validation.json"
