import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as burnImage from '../scripts/burn-image.mjs';

const REQUIRED_BUSYBOX = [
  'STATIC', 'SH_IS_ASH', 'CAT', 'ECHO', 'HEAD', 'MKDIR', 'SLEEP', 'TRUE', 'UNAME',
  'AWK', 'MOUNT', 'SETSID', 'CTTYHACK', 'MDEV', 'HOSTNAME', 'IP',
  'FEATURE_IP_ADDRESS', 'FEATURE_IP_LINK', 'IFCONFIG', 'ROUTE', 'UDHCPC', 'HTTPD',
];

function busyboxConfig() {
  return REQUIRED_BUSYBOX.map((name) => `CONFIG_${name}=y`).join('\n');
}

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-diagnostic-config-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('diagnostic build accepts a minimal public-key-only runtime configuration', () => {
  const dropbear = [
    '#define DROPBEAR_SVR_PASSWORD_AUTH 0',
    '#define DROPBEAR_SVR_PAM_AUTH 0',
    '#define DROPBEAR_SVR_PUBKEY_AUTH 1',
  ].join('\n');

  assert.deepEqual(
    burnImage.validateDiagnosticBuildConfiguration(busyboxConfig(), dropbear),
    { passwordAuthentication: false, publicKeyAuthentication: true },
  );
});

test('diagnostic build rejects Dropbear password authentication', () => {
  const dropbear = [
    '#define DROPBEAR_SVR_PASSWORD_AUTH 1',
    '#define DROPBEAR_SVR_PAM_AUTH 0',
    '#define DROPBEAR_SVR_PUBKEY_AUTH 1',
  ].join('\n');

  assert.throws(
    () => burnImage.validateDiagnosticBuildConfiguration(busyboxConfig(), dropbear),
    /public-key-only server authentication/,
  );
});

test('repository diagnostic tool configuration satisfies the runtime contract', () => {
  const busyboxPath = new URL('../config/stock-diagnostic-busybox.config', import.meta.url);
  const dropbearPath = new URL('../config/stock-diagnostic-dropbear.h', import.meta.url);
  assert.equal(fs.existsSync(busyboxPath), true, 'missing BusyBox diagnostic configuration');
  assert.equal(fs.existsSync(dropbearPath), true, 'missing Dropbear diagnostic configuration');

  assert.deepEqual(
    burnImage.validateDiagnosticBuildConfiguration(
      fs.readFileSync(busyboxPath, 'utf8'),
      fs.readFileSync(dropbearPath, 'utf8'),
    ),
    { passwordAuthentication: false, publicKeyAuthentication: true },
  );
});

test('BusyBox fragment enables only requested symbols in an allnoconfig baseline', () => {
  const baseline = [
    '# CONFIG_STATIC is not set',
    'CONFIG_SH_IS_ASH=y',
    '# CONFIG_IP is not set',
    '# CONFIG_TC is not set',
    '',
  ].join('\n');
  const fragment = ['CONFIG_STATIC=y', 'CONFIG_SH_IS_ASH=y', 'CONFIG_IP=y', ''].join('\n');

  assert.equal(
    burnImage.mergeBusyboxConfig(baseline, fragment),
    ['CONFIG_STATIC=y', 'CONFIG_SH_IS_ASH=y', 'CONFIG_IP=y', '# CONFIG_TC is not set', ''].join('\n'),
  );
});

test('BusyBox config merge CLI writes the resolved configuration', (context) => {
  const directory = fixture(context);
  const baseline = path.join(directory, 'baseline.config');
  const fragment = path.join(directory, 'fragment.config');
  const output = path.join(directory, 'resolved.config');
  fs.writeFileSync(baseline, '# CONFIG_STATIC is not set\n# CONFIG_IP is not set\n');
  fs.writeFileSync(fragment, 'CONFIG_STATIC=y\nCONFIG_IP=y\n');

  const result = childProcess.spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/burn-image.mjs', import.meta.url)),
    'merge-busybox-config', baseline, fragment, output,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'CONFIG_STATIC=y\nCONFIG_IP=y\n');
});

test('diagnostic build config CLI validates repository tool configuration', () => {
  const result = childProcess.spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/burn-image.mjs', import.meta.url)),
    'check-diagnostic-build-config',
    fileURLToPath(new URL('../config/stock-diagnostic-busybox.config', import.meta.url)),
    fileURLToPath(new URL('../config/stock-diagnostic-dropbear.h', import.meta.url)),
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    passwordAuthentication: false,
    publicKeyAuthentication: true,
  });
});
