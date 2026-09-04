import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const collector = path.resolve('scripts/collect-device-evidence.sh');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function put(root, relative, value) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

async function fakeCommand(directory, name, body) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
}

test('collects six fixture capabilities without block-device writes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'b860-device-collector-'));
  try {
    const fixture = path.join(temporary, 'fixture');
    const fakeBin = path.join(temporary, 'bin');
    const output = path.join(temporary, 'output');
    const commandLog = path.join(temporary, 'commands.log');
    await mkdir(fakeBin, { recursive: true });
    await put(fixture, 'proc/device-tree/model', 'Amlogic Meson GXL P212 Development Board\0');
    await put(fixture, 'proc/device-tree/compatible', 'amlogic,p212\0amlogic,meson-gxl\0');
    await put(fixture, 'proc/sys/kernel/osrelease', '5.10.260-ophub\n');
    await put(fixture, 'sys/block/mmcblk0/size', '1525848745\n');
    await put(fixture, 'sys/class/net/eth0/carrier', '1\n');
    await put(fixture, 'sys/class/net/eth0/operstate', 'up\n');
    await put(fixture, 'sys/class/net/wlan0/operstate', 'up\n');
    await put(fixture, 'sys/class/drm/card0-HDMI-A-1/status', 'connected\n');
    await put(fixture, 'sys/class/drm/card0-HDMI-A-1/edid', 'fixture-edid\n');
    await put(fixture, 'sys/class/rc/rc0/name', 'meson-ir\n');
    await put(fixture, 'sys/class/input/event0/name', 'meson-ir\n');
    await put(fixture, 'sys/bus/usb/devices/1-1/idVendor', 'abcd\n');
    await put(fixture, 'sys/bus/usb/devices/1-1/idProduct', '1234\n');
    await mkdir(path.join(fixture, 'sys/module/8189fs'), { recursive: true });
    await mkdir(path.join(fixture, 'dev'), { recursive: true });
    await writeFile(path.join(fixture, 'dev/mmcblk0'), Buffer.alloc(64 * 1024, 7));
    await put(fixture, 'boot/zImage', 'fixture-kernel\n');
    await put(fixture, 'boot/uInitrd', 'fixture-initrd\n');
    await put(fixture, 'boot/uEnv.txt', 'FDT=/dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb\n');
    await put(fixture, 'boot/dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb', 'fixture-dtb\n');
    const identity = {
      schemaVersion: 1,
      boardProfile: 'b860av1-t',
      manifestFingerprint: 'a'.repeat(64),
      kernelVersion: '5.10.260',
      kernelRelease: '5.10.260-ophub',
      identityPath: '/usr/lib/b860av1-t/image-identity.json',
    };
    const identityText = `${JSON.stringify(identity, null, 2)}\n`;
    await put(fixture, 'usr/lib/b860av1-t/image-identity.json', identityText);
    const metadata = {
      repository: 'wuhao1477/b860av1-t-armbian-burn-builder',
      tag: 'armbian-26.08.0-debian-13.6-trixie-k5.10.260-build-36.1',
      image: 'Armbian_26.08.0_amlogic_b860av1-t_trixie_5.10.260_server_2026.07.22.img.gz',
      imageSha256: 'c'.repeat(64),
      rawSha256: 'd'.repeat(64),
      manifestFingerprint: 'a'.repeat(64),
      kernelVersion: '5.10.260',
      kernelRelease: '5.10.260-ophub',
      identitySha256: sha256(identityText),
    };
    const metadataPath = path.join(temporary, 'release-metadata.json');
    const serialPath = path.join(temporary, 'uart.log');
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    await writeFile(serialPath, 'U-Boot vendor Android text\nLinux version 5.10.260-ophub (builder)\nWelcome to Armbian 26.08.0\n');
    await fakeCommand(fakeBin, 'findmnt', `printf '%s\\n' "$*" >> "$B860_COMMAND_LOG"; printf '/dev/mmcblk0\\n'`);
    await fakeCommand(fakeBin, 'blockdev', `printf '%s\\n' "$*" >> "$B860_COMMAND_LOG"; printf '7812345678\\n'`);
    await fakeCommand(fakeBin, 'ip', `printf '%s\\n' "$*" >> "$B860_COMMAND_LOG"; printf 'default via 192.0.2.1 dev eth0\\n'`);
    await fakeCommand(fakeBin, 'iw', `printf '%s\\n' "$*" >> "$B860_COMMAND_LOG"; printf 'Connected\\n'`);
    await fakeCommand(fakeBin, 'curl', `printf '%s\\n' "$*" >> "$B860_COMMAND_LOG"; exit 0`);
    await fakeCommand(fakeBin, 'dd', `printf '%s\\n' "$*" >> "$B860_COMMAND_LOG"; output=''; for arg in "$@"; do case "$arg" in of=*) output=\${arg#of=} ;; esac; done; test -n "$output"; /bin/dd if=/dev/zero of="$output" bs=512 count=8 2>/dev/null`);
    const environment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      B860_DEVICE_FIXTURE_ROOT: fixture,
      B860_COMMAND_LOG: commandLog,
    };
    await execFileAsync(collector, [
      '--release-metadata', metadataPath,
      '--output', output,
      '--serial-log', serialPath,
      '--non-interactive',
      '--hdmi-visible',
      '--infrared-key-seen',
      '--usb-vendor-id', 'abcd',
      '--usb-product-id', '1234',
      '--health-endpoint', 'https://example.invalid/health',
    ], { env: environment });
    const report = JSON.parse(await readFile(path.join(output, 'device-validation.json'), 'utf8'));
    assert.equal(report.status, 'passed');
    assert.deepEqual(Object.keys(report.capabilities).sort(), ['emmc', 'ethernet', 'hdmi', 'infrared', 'usb', 'wifi']);
    assert.equal((await readFile(path.join(output, 'device-serial.log'), 'utf8')).includes('B860_DEVICE_READY'), true);
    const commands = await readFile(commandLog, 'utf8');
    assert.doesNotMatch(commands, /of=\/dev\//);
    assert.doesNotMatch(commands, /--(?:write|format|erase)/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
