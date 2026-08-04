import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CAPABILITIES,
  MAX_DEVICE_LOG_BYTES,
  parseSerialLog,
  redactSensitiveText,
  safeEvidenceRelativePath,
  validateDeviceEvidence,
} from '../src/device-evidence.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const evidenceId = '0123456789abcdef';
const fingerprint = 'a'.repeat(64);
const kernelRelease = '5.10.260-ophub';
const challenge = `B860_DEVICE_READY ${evidenceId} ${fingerprint} ${kernelRelease}`;

function serialLog(lineEnding = '\n') {
  return [
    'U-Boot vendor environment mentions Android before handoff',
    `Linux version ${kernelRelease} (builder@runner)`,
    'Welcome to Armbian 26.08.0 Trixie',
    challenge,
    '',
  ].join(lineEnding);
}

function capabilities() {
  return {
    emmc: {
      passed: true,
      observations: {
        blockDevicePresent: true,
        rootSourceObserved: true,
        capacityBytes: 7_812_345_678,
        readOnlyProbeBytes: 4096,
      },
    },
    ethernet: {
      passed: true,
      observations: { carrier: true, connectivity: true },
    },
    hdmi: {
      passed: true,
      observations: {
        connectorConnected: true,
        edidSha256: 'b'.repeat(64),
        linuxDisplayVisible: true,
      },
    },
    infrared: {
      passed: true,
      observations: { inputDevicePresent: true, keyEventSeen: true, keyCode: 116 },
    },
    usb: {
      passed: true,
      observations: {
        hostPresent: true,
        hotplugSeen: true,
        vendorId: 'abcd',
        productId: '1234',
        readOnlyProbe: true,
      },
    },
    wifi: {
      passed: true,
      observations: {
        driver: '8189fs',
        interfacePresent: true,
        associated: true,
        connectivity: true,
      },
    },
  };
}

function evidence(overrides = {}) {
  const log = serialLog();
  return {
    schemaVersion: 1,
    status: 'passed',
    evidenceId,
    collectedAt: '2026-07-22T04:00:00Z',
    board: {
      profile: 'b860av1-t',
      declaredModel: 'ZXV10 B860AV1.1-T',
      observedModel: 'Amlogic Meson GXL P212 Development Board',
      compatible: ['amlogic,p212', 'amlogic,meson-gxl'],
    },
    release: {
      repository: 'wuhao1477/b860av1-t-armbian-builder',
      tag: 'armbian-26.08.0-debian-13.6-trixie-k5.10.260-build-36.1',
      image: 'Armbian_26.08.0_amlogic_b860av1-t_trixie_5.10.260_server_2026.07.22.img.gz',
      imageSha256: 'c'.repeat(64),
      rawSha256: 'd'.repeat(64),
      manifestFingerprint: fingerprint,
    },
    identity: {
      path: '/usr/lib/b860av1-t/image-identity.json',
      sha256: 'e'.repeat(64),
      manifestFingerprint: fingerprint,
      kernelVersion: '5.10.260',
      kernelRelease,
    },
    collector: {
      repository: 'wuhao1477/b860av1-t-armbian-builder',
      commit: 'f'.repeat(40),
      scriptPath: 'scripts/collect-device-evidence.sh',
      scriptSha256: '1'.repeat(64),
    },
    boot: {
      kernelRelease,
      components: [
        { role: 'kernel', path: 'zImage', sha256: '2'.repeat(64) },
        { role: 'initrd', path: 'uInitrd', sha256: '3'.repeat(64) },
        {
          role: 'dtb',
          path: 'dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb',
          sha256: '4'.repeat(64),
        },
        { role: 'boot-config', path: 'uEnv.txt', sha256: '5'.repeat(64) },
      ],
    },
    serial: {
      asset: 'device-serial.log',
      sha256: sha256(log),
      bootFromPowerOn: true,
      linuxReady: true,
      androidMarkersAbsent: true,
    },
    capabilities: capabilities(),
    ...overrides,
  };
}

test('validates a complete device report and all six capabilities', () => {
  const value = evidence();
  assert.deepEqual(CAPABILITIES, ['emmc', 'ethernet', 'hdmi', 'infrared', 'usb', 'wifi']);
  assert.equal(validateDeviceEvidence(value, { serialLog: serialLog() }), value);
});

test('redacts network, storage, USB, and secret identifiers', () => {
  const source = [
    'ip=192.0.2.10 ipv6=2001:db8::1 mac=02:00:00:00:00:01',
    'ssid=PrivateNetwork UUID=550e8400-e29b-41d4-a716-446655440000',
    'cid=1b534d303030303010abcdef12345678 serialNumber=USB-PRIVATE',
    'TOKEN=top-secret PASSWORD=other-secret',
  ].join('\r\n');
  const redacted = redactSensitiveText(source);

  for (const secret of [
    '192.0.2.10', '2001:db8::1', '02:00:00:00:00:01', 'PrivateNetwork',
    '550e8400-e29b-41d4-a716-446655440000', '1b534d303030303010abcdef12345678',
    'USB-PRIVATE', 'top-secret', 'other-secret',
  ]) assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(redacted, /\[REDACTED\]/);
  assert.doesNotMatch(redacted, /\r/);
});

test('rejects control characters and oversized logs', () => {
  assert.throws(() => redactSensitiveText('valid\u0000invalid'), /control character/i);
  assert.throws(() => redactSensitiveText('x'.repeat(MAX_DEVICE_LOG_BYTES + 1)), /2 MiB|size/i);
});

test('parses CR, LF, and CRLF serial logs with one bound challenge', () => {
  for (const ending of ['\r', '\n', '\r\n']) {
    const result = parseSerialLog(serialLog(ending), { evidenceId, manifestFingerprint: fingerprint, kernelRelease });
    assert.equal(result.markers.challenge, challenge);
    assert.equal(result.markers.kernelRelease, kernelRelease);
    assert.equal(result.warnings.preHandoffVendorText, true);
  }
});

test('rejects a duplicate challenge or post-handoff Android execution', () => {
  assert.throws(
    () => parseSerialLog(`${serialLog()}${challenge}\n`, {
      evidenceId, manifestFingerprint: fingerprint, kernelRelease,
    }),
    /exactly one.*challenge/i,
  );
  assert.throws(
    () => parseSerialLog(`${serialLog()}boot_android\n`, {
      evidenceId, manifestFingerprint: fingerprint, kernelRelease,
    }),
    /Android|stock fallback/i,
  );
});

test('rejects incomplete capabilities, unexpected fields, and sensitive JSON', () => {
  const missingWifi = evidence();
  delete missingWifi.capabilities.wifi;
  assert.throws(() => validateDeviceEvidence(missingWifi, { serialLog: serialLog() }), /capabilities.*keys/i);

  const failedUsb = evidence();
  failedUsb.capabilities.usb.passed = false;
  assert.throws(() => validateDeviceEvidence(failedUsb, { serialLog: serialLog() }), /usb.*passed/i);

  assert.throws(
    () => validateDeviceEvidence({ ...evidence(), unexpected: true }, { serialLog: serialLog() }),
    /unexpected keys/i,
  );

  const leaked = evidence();
  leaked.board.observedModel = 'device at 192.0.2.15';
  assert.throws(() => validateDeviceEvidence(leaked, { serialLog: serialLog() }), /sensitive|redact/i);
});

test('accepts only safe evidence-relative paths', () => {
  assert.equal(safeEvidenceRelativePath('dtb/amlogic/board.dtb'), true);
  assert.equal(safeEvidenceRelativePath('/etc/passwd'), false);
  assert.equal(safeEvidenceRelativePath('../escape'), false);
  assert.equal(safeEvidenceRelativePath('path with spaces'), false);
});
