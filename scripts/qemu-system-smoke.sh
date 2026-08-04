#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: $0 raw-image kernel-path kernel-source kernel-image initrd-path initrd-source initrd-image root-uuid manifest.json output.json" >&2
  exit 2
}

[[ $# -eq 10 ]] || usage
raw_image=$1
kernel_path=$2
kernel_source=$3
kernel_image=$4
initrd_path=$5
initrd_source=$6
initrd_image=$7
root_uuid=$8
manifest=$9
output=${10}

for path in "$raw_image" "$kernel_source" "$kernel_image" "$initrd_source" "$initrd_image" "$manifest"; do
  [[ -f "$path" ]] || { echo "required file is missing: $path" >&2; exit 1; }
done
[[ "$root_uuid" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] \
  || { echo 'invalid root filesystem UUID' >&2; exit 1; }
command -v qemu-system-aarch64 >/dev/null || { echo 'qemu-system-aarch64 is required' >&2; exit 1; }
command -v expect >/dev/null || { echo 'expect is required' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required' >&2; exit 1; }

mkdir -p "$(dirname "$output")"
console_log="${output%.json}.log"
raw_before=$(sha256sum "$raw_image" | awk '{print $1}')
kernel_source_sha256=$(sha256sum "$kernel_source" | awk '{print $1}')
kernel_sha256=$(sha256sum "$kernel_image" | awk '{print $1}')
initrd_source_sha256=$(sha256sum "$initrd_source" | awk '{print $1}')
initrd_sha256=$(sha256sum "$initrd_image" | awk '{print $1}')
qemu_version=$(qemu-system-aarch64 --version)
qemu_version=${qemu_version%%$'\n'*}
kernel_release_nonce=$(printf '%s' "$raw_before-$$-$(date +%s%N)" | sha256sum | cut -c1-32)
kernel_release_marker="B860_QEMU_KERNEL_RELEASE_$kernel_release_nonce"

export QEMU_RAW_IMAGE="$raw_image"
export QEMU_KERNEL_IMAGE="$kernel_image"
export QEMU_INITRD_IMAGE="$initrd_image"
export QEMU_ROOT_UUID="$root_uuid"
export QEMU_KERNEL_RELEASE_MARKER="$kernel_release_marker"

if ! expect <<'EXPECT' >"$console_log" 2>&1
log_user 1
set timeout 180
set append "root=UUID=$env(QEMU_ROOT_UUID) rootwait rootfstype=ext4 rw console=ttyAMA0,115200 earlycon=pl011,0x09000000 loglevel=7 init=/bin/sh"
spawn qemu-system-aarch64 \
  -M virt,gic-version=2 \
  -cpu cortex-a53 \
  -m 1024 \
  -smp 4 \
  -nographic \
  -monitor none \
  -serial stdio \
  -nic none \
  -no-reboot \
  -kernel $env(QEMU_KERNEL_IMAGE) \
  -initrd $env(QEMU_INITRD_IMAGE) \
  -append $append \
  -drive "if=none,file=$env(QEMU_RAW_IMAGE),format=raw,snapshot=on,id=rootdisk" \
  -device virtio-blk-device,drive=rootdisk
set qemu_pid [exp_pid]
proc stop_qemu {pid} {
  catch {exec kill -TERM $pid}
  after 250
  catch {exec kill -KILL $pid}
  catch {close}
  catch {wait}
}
expect {
  -re {(?m)^# ?$} {
    send -- "printf '$env(QEMU_KERNEL_RELEASE_MARKER)_%s\\n' \"\$(uname -r)\"; if test -s /etc/armbian-release && grep -q '^ID=debian' /etc/os-release && grep -q ' / ext4 ' /proc/mounts; then printf 'B860_QEMU_SYSTEM_SMOKE_%s\\n' OK; else printf 'B860_QEMU_SYSTEM_SMOKE_%s\\n' FAIL; fi\r"
  }
  timeout { stop_qemu $qemu_pid; exit 10 }
  eof { exit 11 }
}
expect {
  -re {(?m)^B860_QEMU_SYSTEM_SMOKE_OK\r*$} {
    send -- "sync; poweroff -f\r"
    set timeout 20
    expect {
      eof { exit 0 }
      timeout { stop_qemu $qemu_pid; exit 0 }
    }
  }
  -re {(?m)^B860_QEMU_SYSTEM_SMOKE_FAIL\r*$} { stop_qemu $qemu_pid; exit 12 }
  timeout { stop_qemu $qemu_pid; exit 13 }
  eof { exit 14 }
}
EXPECT
then
  echo 'QEMU system smoke test failed; console log follows' >&2
  sed -n '1,260p' "$console_log" >&2 || true
  exit 1
fi

raw_after=$(sha256sum "$raw_image" | awk '{print $1}')
[[ "$raw_before" == "$raw_after" ]] || {
  echo 'QEMU changed the source raw image despite snapshot mode' >&2
  exit 1
}
console_sha256=$(sha256sum "$console_log" | awk '{print $1}')
kernel_release=$(CONSOLE_LOG="$console_log" KERNEL_RELEASE_MARKER="$kernel_release_marker" \
  MANIFEST="$manifest" node - <<'NODE'
const fs = require('node:fs');
const consoleLog = fs.readFileSync(process.env.CONSOLE_LOG, 'utf8');
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST, 'utf8'));
const kernelVersion = manifest.sources?.kernel?.version;
if (typeof kernelVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(kernelVersion)) {
  throw new Error('manifest kernel version is invalid');
}
const marker = process.env.KERNEL_RELEASE_MARKER;
if (!/^B860_QEMU_KERNEL_RELEASE_[0-9a-f]{32}$/.test(marker ?? '')) {
  throw new Error('QEMU kernel release marker is invalid');
}
const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const releaseSource = '[0-9]+\\.[0-9]+\\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*';
const matches = [...consoleLog.matchAll(new RegExp(`^${escapedMarker}_(${releaseSource})\\r?$`, 'gm'))];
if (matches.length !== 1) throw new Error('QEMU kernel release marker is missing or duplicated');
const kernelRelease = matches[0][1];
if (!kernelRelease.startsWith(`${kernelVersion}-`)) {
  throw new Error('QEMU kernel release does not match manifest kernel version');
}
process.stdout.write(kernelRelease);
NODE
)
manifest_fingerprint=$(node - "$manifest" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!/^[0-9a-f]{64}$/.test(manifest.fingerprint ?? '')) throw new Error('manifest fingerprint is invalid');
process.stdout.write(manifest.fingerprint);
NODE
)
RAW_SHA256="$raw_before" KERNEL_SOURCE_SHA256="$kernel_source_sha256" \
  KERNEL_SHA256="$kernel_sha256" INITRD_SOURCE_SHA256="$initrd_source_sha256" \
  INITRD_SHA256="$initrd_sha256" CONSOLE_SHA256="$console_sha256" \
  KERNEL_PATH="$kernel_path" INITRD_PATH="$initrd_path" \
  MANIFEST_FINGERPRINT="$manifest_fingerprint" ROOT_UUID="$root_uuid" \
  KERNEL_RELEASE="$kernel_release" KERNEL_RELEASE_MARKER="$kernel_release_marker" \
  QEMU_VERSION="$qemu_version" CONSOLE_LOG="$(basename "$console_log")" \
  OUTPUT="$output" node - <<'NODE'
const fs = require('node:fs');
const required = [
  'RAW_SHA256',
  'KERNEL_SOURCE_SHA256',
  'KERNEL_SHA256',
  'INITRD_SOURCE_SHA256',
  'INITRD_SHA256',
  'CONSOLE_SHA256',
  'KERNEL_PATH',
  'INITRD_PATH',
  'MANIFEST_FINGERPRINT',
  'ROOT_UUID',
  'QEMU_VERSION',
  'CONSOLE_LOG',
  'KERNEL_RELEASE',
  'KERNEL_RELEASE_MARKER',
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`missing evidence value: ${key}`);
}
const result = {
  schemaVersion: 2,
  status: 'passed',
  machine: 'virt',
  cpu: 'cortex-a53',
  manifestFingerprint: process.env.MANIFEST_FINGERPRINT,
  rawSha256: process.env.RAW_SHA256,
  kernelPath: process.env.KERNEL_PATH,
  kernelSourceSha256: process.env.KERNEL_SOURCE_SHA256,
  kernelSha256: process.env.KERNEL_SHA256,
  kernelRelease: process.env.KERNEL_RELEASE,
  kernelReleaseMarker: process.env.KERNEL_RELEASE_MARKER,
  initrdPath: process.env.INITRD_PATH,
  initrdSourceSha256: process.env.INITRD_SOURCE_SHA256,
  initrdSha256: process.env.INITRD_SHA256,
  rootUuid: process.env.ROOT_UUID.toLowerCase(),
  qemuVersion: process.env.QEMU_VERSION,
  consoleLog: process.env.CONSOLE_LOG,
  consoleLogSha256: process.env.CONSOLE_SHA256,
};
fs.writeFileSync(process.env.OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
NODE
