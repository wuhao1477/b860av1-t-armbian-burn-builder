import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_RTL8189FS_ALIAS,
  EXPECTED_RTL8189FS_MODULE_PATH,
  validateRtl8189fsMetadata,
} from '../src/rtl8189fs.mjs';

function validMetadata() {
  return {
    kernelRelease: '5.10.260-ophub',
    modulePath: EXPECTED_RTL8189FS_MODULE_PATH,
    moduleFileType: 'ELF 64-bit LSB relocatable, ARM aarch64, version 1 (SYSV)',
    moduleName: '8189fs',
    vermagic: '5.10.260-ophub SMP preempt mod_unload aarch64',
    aliases: [EXPECTED_RTL8189FS_ALIAS],
    aliasDatabase: `alias ${EXPECTED_RTL8189FS_ALIAS} 8189fs`,
    dependencies: 'kernel/drivers/net/wireless/realtek/rtl8189fs/8189fs.ko: kernel/net/wireless/cfg80211.ko kernel/net/rfkill/rfkill.ko',
    moduleSha256: '1'.repeat(64),
    modulesAliasSha256: '2'.repeat(64),
    modulesDepSha256: '3'.repeat(64),
  };
}

test('RTL8189FS metadata accepts the B860 SDIO driver contract', () => {
  assert.equal(validateRtl8189fsMetadata(validMetadata()), true);
});

test('RTL8189FS metadata rejects a missing module', () => {
  const metadata = validMetadata();
  metadata.modulePath = 'kernel/drivers/net/wireless/rtl8189fs.ko';
  assert.throws(() => validateRtl8189fsMetadata(metadata), /module path/i);
});

test('RTL8189FS metadata rejects a non-ARM64 module', () => {
  const metadata = validMetadata();
  metadata.moduleFileType = 'ELF 64-bit LSB relocatable, x86-64';
  assert.throws(() => validateRtl8189fsMetadata(metadata), /ARM64|aarch64/i);
});

test('RTL8189FS metadata rejects a mismatched kernel vermagic', () => {
  const metadata = validMetadata();
  metadata.vermagic = '5.10.259-ophub SMP preempt mod_unload aarch64';
  assert.throws(() => validateRtl8189fsMetadata(metadata), /vermagic/i);
});

test('RTL8189FS metadata rejects missing B860 SDIO alias and dependencies', () => {
  const metadata = validMetadata();
  metadata.aliases = [];
  metadata.dependencies = 'kernel/drivers/net/wireless/realtek/rtl8189fs/8189fs.ko:';
  assert.throws(() => validateRtl8189fsMetadata(metadata), /SDIO alias|dependencies/i);
});

test('RTL8189FS metadata rejects .ko.invalid dependency tokens', () => {
  const metadata = validMetadata();
  metadata.dependencies = `${EXPECTED_RTL8189FS_MODULE_PATH}: kernel/net/wireless/cfg80211.ko.invalid kernel/net/rfkill/rfkill.ko`;
  assert.throws(() => validateRtl8189fsMetadata(metadata), /dependencies/i);
});

test('RTL8189FS metadata rejects a module name or autoload database mismatch', () => {
  const metadata = validMetadata();
  metadata.moduleName = 'wrong-driver';
  assert.throws(() => validateRtl8189fsMetadata(metadata), /module name/i);

  const missingAlias = validMetadata();
  missingAlias.aliasDatabase = '';
  assert.throws(() => validateRtl8189fsMetadata(missingAlias), /autoload alias/i);
});

test('RTL8189FS CLI validates a mounted image root with host inspection tools', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl8189fs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'root');
  const bin = path.join(directory, 'bin');
  const release = '5.10.260-ophub';
  const moduleDirectory = path.join(root, 'usr/lib/modules', release);
  const module = path.join(moduleDirectory, EXPECTED_RTL8189FS_MODULE_PATH);
  fs.mkdirSync(path.dirname(module), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(module, 'module fixture');
  fs.writeFileSync(
    path.join(moduleDirectory, 'modules.alias'),
    `alias ${EXPECTED_RTL8189FS_ALIAS} 8189fs\n`,
  );
  fs.writeFileSync(
    path.join(moduleDirectory, 'modules.dep'),
    `${EXPECTED_RTL8189FS_MODULE_PATH}: kernel/net/wireless/cfg80211.ko kernel/net/rfkill/rfkill.ko\n`,
  );
  fs.writeFileSync(
    path.join(bin, 'file'),
    '#!/bin/sh\nprintf "%s\\n" "ELF 64-bit LSB relocatable, ARM aarch64, version 1 (SYSV)"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'modinfo'),
    `#!/bin/sh\ncase "$2" in\n  name) printf '%s\\n' 8189fs ;;\n  vermagic) printf '%s\\n' '${release} SMP preempt mod_unload aarch64' ;;\n  alias) printf '%s\\n' '${EXPECTED_RTL8189FS_ALIAS}' ;;\n  *) exit 2 ;;\nesac\n`,
    { mode: 0o755 },
  );

  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/validate-rtl8189fs.mjs', import.meta.url)), root, release],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  const result = JSON.parse(output);
  assert.equal(result.kernelRelease, release);
  assert.equal(result.modulePath, EXPECTED_RTL8189FS_MODULE_PATH);
  assert.equal(result.sdioAlias, EXPECTED_RTL8189FS_ALIAS);
  assert.equal(result.vermagic, `${release} SMP preempt mod_unload aarch64`);
  assert.match(result.moduleFileType, /ARM aarch64/);
  assert.match(result.moduleSha256, /^[0-9a-f]{64}$/);
  assert.match(result.modulesAliasSha256, /^[0-9a-f]{64}$/);
  assert.match(result.modulesDepSha256, /^[0-9a-f]{64}$/);
});
