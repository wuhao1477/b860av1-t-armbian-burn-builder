import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  contentMarkers,
  magicMarkers,
  pathMarkers,
  scanInitrds,
  scanTree,
} from '../scripts/scan-mounted-image.mjs';

test('path scanner detects relocated and renamed Android payloads', () => {
  assert.ok(pathMarkers('/root', '/root/opt/android/system/build.prop').length > 0);
  assert.ok(pathMarkers('/root', '/root/opt/payload/renamed.apex').length > 0);
  assert.ok(pathMarkers('/root', '/root/vendor_boot.img').length > 0);
  assert.ok(pathMarkers('/root', '/root/init.amlogic.rc').length > 0);
  assert.ok(pathMarkers('/root', '/root/product/neutral.bin').length > 0);
  assert.ok(pathMarkers('/root', '/root/system_ext/neutral.bin').length > 0);
});

test('path scanner permits standard Linux Binder UAPI headers', () => {
  assert.deepEqual(pathMarkers('/root', '/root/usr/include/linux/android'), []);
  assert.deepEqual(pathMarkers('/root', '/root/usr/include/linux/android/binder.h'), []);
  assert.deepEqual(pathMarkers(
    '/root',
    '/root/usr/src/linux-headers-5.10.260-ophub/include/uapi/linux/android/binderfs.h',
  ), []);
  assert.ok(pathMarkers('/root', '/root/usr/include/linux/android/neutral.h').length > 0);
});

test('magic scanner detects Android boot, sparse, AVB and renamed APK data', () => {
  assert.ok(magicMarkers('boot.bin', Buffer.from('ANDROID!'), Buffer.alloc(0)).length > 0);
  assert.ok(magicMarkers('sparse.bin', Buffer.from('3aff26ed', 'hex'), Buffer.alloc(0)).length > 0);
  assert.ok(magicMarkers('vbmeta.bin', Buffer.from('AVB0payload'), Buffer.alloc(0)).length > 0);
  assert.ok(magicMarkers('vbmeta.bin', Buffer.alloc(8), Buffer.from('AVBf')).length > 0);
  assert.ok(magicMarkers('renamed.bin', Buffer.from('VNDRBOOTpayload'), Buffer.alloc(0)).length > 0);
  assert.ok(magicMarkers('renamed.bin', Buffer.from('d7b7ab1e', 'hex'), Buffer.alloc(0)).length > 0);
  assert.ok(magicMarkers('renamed.bin', Buffer.from('CrAUpayload'), Buffer.alloc(0)).length > 0);
  assert.ok(magicMarkers(
    'renamed.zip',
    Buffer.from('PK\x03\x04'),
    Buffer.from('AndroidManifest.xml classes.dex'),
  ).length > 0);
});

test('text scanner detects Android bootargs and DTB partition names', () => {
  assert.ok(contentMarkers('uEnv.txt', Buffer.from('APPEND=androidboot.hardware=amlogic')).length > 0);
  assert.ok(contentMarkers('board.dts', Buffer.from('partition-name = "vendor_boot";')).length > 0);
  assert.ok(contentMarkers('init.rc', Buffer.from('service zygote /system/bin/app_process64')).length > 0);
  assert.deepEqual(contentMarkers('uEnv.txt', Buffer.from('APPEND=root=UUID=abc console=ttyAML0')), []);
  assert.deepEqual(contentMarkers('uEnv.txt', Buffer.from('APPEND=init=/initramfs')), []);
  assert.deepEqual(
    contentMarkers('platform.py', Buffer.from('release = getprop("ro.build.version.release", release)')),
    [],
  );
});

test('text scanner reads complete text files and scans extracted initrds', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-android-scan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'root');
  const initrds = path.join(directory, 'initrds');
  const initrdLayer = path.join(initrds, 'uInitrd', 'main');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(initrdLayer, { recursive: true });
  const prefix = 'x'.repeat((1024 * 1024) - 5);
  const suffix = 'x'.repeat(1024 * 1024);
  fs.writeFileSync(path.join(root, 'neutral.conf'), `${prefix}\nro.build.version.sdk=35${suffix}`);
  fs.writeFileSync(path.join(initrdLayer, 'neutral.conf'), 'androidboot.hardware=amlogic\n');
  fs.mkdirSync(path.join(initrdLayer, 'vendor'));
  fs.symlinkSync('/does-not-exist', path.join(initrdLayer, 'system'));
  fs.symlinkSync('/bin/sh', path.join(initrdLayer, 'init'));
  fs.symlinkSync('/usr/lib/systemd/system/example.service', path.join(initrdLayer, 'neutral-link'));
  fs.symlinkSync('/system/bin/init', path.join(initrdLayer, 'android-link'));

  assert.ok(scanTree(root, true).findings.some((finding) => finding.includes('neutral.conf')));
  const findings = scanInitrds(initrds).findings;
  assert.ok(findings.some((finding) => finding.includes('neutral.conf')));
  assert.ok(findings.some((finding) => finding.includes('vendor')));
  assert.ok(findings.some((finding) => finding.includes('system')));
  assert.ok(findings.some((finding) => finding.includes('android-link: Android symlink target')));
  assert.ok(!findings.some((finding) => finding.includes('neutral-link: Android symlink target')));
  assert.ok(!findings.some((finding) => finding.endsWith(': init: Android root entry')));
});
