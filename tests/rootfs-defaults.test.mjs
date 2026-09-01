import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/apply-rootfs-defaults.sh');

// 造一个刚好够 apply-rootfs-defaults.sh 认得出来的 rootfs：
// 上游 Armbian 里这几个文件的位置和 [Install] 段都是实机确认过的。
function fakeRootfs(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-rootfs-defaults-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const relative of [
    'etc/systemd/system/network-online.target.wants',
    'usr/lib/systemd/system', 'usr/local/sbin', 'usr/bin', 'root',
  ]) fs.mkdirSync(path.join(directory, relative), { recursive: true });
  fs.writeFileSync(path.join(directory, 'etc/passwd'),
    'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n');
  fs.writeFileSync(path.join(directory, 'root/.not_logged_in_yet'), '');
  fs.writeFileSync(path.join(directory, 'usr/bin/zsh'), '#!/bin/sh\n', { mode: 0o755 });
  for (const [unit, target] of [
    ['armbian-zram-config.service', 'sysinit.target'],
    ['NetworkManager-wait-online.service', 'network-online.target'],
  ]) fs.writeFileSync(path.join(directory, 'usr/lib/systemd/system', unit), `[Install]\nWantedBy=${target}\n`);
  fs.symlinkSync('/usr/lib/systemd/system/NetworkManager-wait-online.service',
    path.join(directory, 'etc/systemd/system/network-online.target.wants/NetworkManager-wait-online.service'));
  return directory;
}

function apply(directory) {
  // SUDO= 关掉 sudo：临时目录归当前用户，真跑时 rootfs 里的文件才需要 root。
  return childProcess.spawnSync('bash', [script, directory], {
    encoding: 'utf8', env: { ...process.env, SUDO: '' },
  });
}

const exists = (directory, relative) => fs.existsSync(path.join(directory, relative));

test('rootfs defaults make the flashed image usable without a first-login wizard', (context) => {
  const directory = fakeRootfs(context);

  const result = apply(directory);

  assert.equal(result.status, 0, result.stderr);
  // 首登向导的唯一触发条件就是这个文件。留着 = 每次重刷都要重设 shell/用户/密码。
  assert.ok(!exists(directory, 'root/.not_logged_in_yet'));
  const passwd = fs.readFileSync(path.join(directory, 'etc/passwd'), 'utf8').split('\n');
  assert.equal(passwd[0], 'root:x:0:0:root:/root:/usr/bin/zsh');
  assert.equal(passwd[1], 'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin', 'only root may be rewritten');
});

test('rootfs defaults flip the boot-time services measured on hardware', (context) => {
  const directory = fakeRootfs(context);

  assert.equal(apply(directory).status, 0);

  assert.equal(
    fs.readlinkSync(path.join(directory, 'etc/systemd/system/sysinit.target.wants/armbian-zram-config.service')),
    '/usr/lib/systemd/system/armbian-zram-config.service',
  );
  assert.equal(
    fs.readlinkSync(path.join(directory, 'etc/systemd/system/multi-user.target.wants/b860-expand-rootfs.service')),
    '/etc/systemd/system/b860-expand-rootfs.service',
  );
  // 实测这条服务占开机 6 s，而这块板从来不需要等网络就绪。
  assert.ok(!exists(directory, 'etc/systemd/system/network-online.target.wants/NetworkManager-wait-online.service'));
});

test('rootfs defaults expand the filesystem without touching the Amlogic partition table', (context) => {
  const directory = fakeRootfs(context);

  assert.equal(apply(directory).status, 0);

  const expand = fs.readFileSync(path.join(directory, 'usr/local/sbin/b860-expand-rootfs'), 'utf8');
  // parted 对这块盘报 "unrecognised disk label"（分区表来自 DTB 的 /partitions），
  // 所以 armbian-resize-filesystem 用不了，我们这份只准跑 resize2fs。
  // 去掉注释再断言 —— 注释里正要解释为什么不碰 parted。
  const code = expand.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.match(code, /resize2fs/);
  assert.doesNotMatch(code, /parted|sfdisk|fdisk/);
  assert.match(code, /rm -f \/etc\/systemd\/system\/multi-user\.target\.wants\/b860-expand-rootfs\.service/);
  assert.ok((fs.statSync(path.join(directory, 'usr/local/sbin/b860-expand-rootfs')).mode & 0o111) !== 0);
});

test('rootfs defaults refuse a rootfs where the Armbian resizer is enabled', (context) => {
  const directory = fakeRootfs(context);
  fs.mkdirSync(path.join(directory, 'etc/systemd/system/basic.target.wants'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'etc/systemd/system/basic.target.wants/armbian-resize-filesystem.service'), '',
  );

  const result = apply(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /armbian-resize-filesystem must stay disabled/);
});

test('rootfs defaults are idempotent and ship no credentials by default', (context) => {
  const directory = fakeRootfs(context);

  assert.equal(apply(directory).status, 0);
  const second = apply(directory);

  assert.equal(second.status, 0, second.stderr);
  // WiFi 密码只能来自本地 gitignore 的 board-inputs/wifi.env；CI 上没有这个文件，
  // 所以公开发布的包里绝不会有任何凭据。
  assert.ok(!fs.existsSync(path.join(root, 'board-inputs/wifi.env')), 'wifi.env must never be committed');
  assert.match(second.stdout, /跳过 WiFi 预置/);
  assert.ok(!exists(directory, 'etc/NetworkManager/system-connections'));
});

test('rootfs defaults reject a directory that is not a rootfs', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-not-a-rootfs-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = apply(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not look like a rootfs/);
});
