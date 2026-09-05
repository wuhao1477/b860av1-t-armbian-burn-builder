import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/apply-rootfs-defaults.sh');

// 镜像里钉死的 root 口令哈希，明文是 README 写的 password。重现：
//   openssl passwd -6 -salt b860burn password
const rootHash = '$6$b860burn$21d1hZz5IOJZocmktz6vVDYwbPhywU7WZtS.7vOC73/M5HGWXUs0SBGFcIbsgfQBh1MwgdtMvQyG8HO2lACOj/';

// meson-vdec 的微码在 board.json 里钉死（commit + sha256）。测试只用文件名，
// 内容随便 —— 真下载由 scripts/fetch-vdec-firmware.sh 负责，测试不联网。
const vdec = JSON.parse(fs.readFileSync(path.join(root, 'config/board.json'), 'utf8')).vdecFirmware;

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
  // 出厂 shadow：口令被锁（`!` 前缀）且第 3 字段是 0（下次登录强制改口令）——
  // 首登向导本来负责改掉它，删了标记就得我们自己钉。两样都要被覆盖。
  fs.writeFileSync(path.join(directory, 'etc/shadow'),
    'root:!$y$j9T$armbianfactory:0:0:99999:7:::\ndaemon:*:19000:0:99999:7:::\n', { mode: 0o640 });
  fs.writeFileSync(path.join(directory, 'root/.not_logged_in_yet'), '');
  fs.writeFileSync(path.join(directory, 'usr/bin/zsh'), '#!/bin/sh\n', { mode: 0o755 });
  for (const [unit, target] of [
    ['armbian-zram-config.service', 'sysinit.target'],
    ['NetworkManager-wait-online.service', 'network-online.target'],
  ]) fs.writeFileSync(path.join(directory, 'usr/lib/systemd/system', unit), `[Install]\nWantedBy=${target}\n`);
  fs.symlinkSync('/usr/lib/systemd/system/NetworkManager-wait-online.service',
    path.join(directory, 'etc/systemd/system/network-online.target.wants/NetworkManager-wait-online.service'));
  // 微码桩目录，见 apply()。放在 rootfs 树里但 §6 不看它，和 sudo-stub 一个套路。
  fs.mkdirSync(path.join(directory, 'vdec-stub'));
  for (const file of Object.keys(vdec.files)) {
    fs.writeFileSync(path.join(directory, 'vdec-stub', file), `stub ${file}\n`);
  }
  return directory;
}

function apply(directory, extra = {}) {
  // SUDO= 关掉 sudo：临时目录归当前用户，真跑时 rootfs 里的文件才需要 root。
  // VDEC_FIRMWARE_DIR 指到桩目录，否则每个测试都会去 git.kernel.org 下微码。
  return childProcess.spawnSync('bash', [script, directory], {
    encoding: 'utf8',
    env: {
      ...process.env, SUDO: '', VDEC_FIRMWARE_DIR: path.join(directory, 'vdec-stub'), ...extra,
    },
  });
}

const exists = (directory, relative) => fs.existsSync(path.join(directory, relative));

test('rootfs defaults make the flashed image usable without a first-login wizard', (context) => {
  const directory = fakeRootfs(context);

  const result = apply(directory);

  assert.equal(result.status, 0, result.stderr);
  // 首登向导的唯一触发条件就是这个文件。留着 = 每次重刷都要重设 shell/用户/密码。
  assert.ok(!exists(directory, 'root/.not_logged_in_yet'));
  assert.match(result.stdout, /已删除 \/root\/\.not_logged_in_yet/);
  const passwd = fs.readFileSync(path.join(directory, 'etc/passwd'), 'utf8').split('\n');
  assert.equal(passwd[0], 'root:x:0:0:root:/root:/usr/bin/zsh');
  assert.equal(passwd[1], 'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin', 'only root may be rewritten');
  // 删掉首登标记之后没人再设口令，所以口令必须由我们钉死，否则包的 root 口令
  // 就是上游出厂哈希 —— 实机 SSH 只会 Permission denied。
  const shadow = fs.readFileSync(path.join(directory, 'etc/shadow'), 'utf8').split('\n');
  assert.equal(shadow[0], `root:${rootHash}:20000:0:99999:7:::`);
  assert.equal(shadow[1], 'daemon:*:19000:0:99999:7:::', 'only root may be rewritten');
});

test('rootfs defaults fail loudly when the root password hash does not stick', (context) => {
  // 静默跳过这一步 = 发一个谁也进不去的包。用一个「假装写了但不写」的 sudo 桩
  // （只吞 cp，rm 照常执行，好让首登标记那一段先过去）逼后置断言开火。
  const directory = fakeRootfs(context);
  const stub = path.join(directory, 'sudo-stub');
  fs.writeFileSync(stub, '#!/bin/sh\n[ "$1" = cp ] && exit 0\nexec "$@"\n', { mode: 0o755 });

  const result = apply(directory, { SUDO: stub });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root password hash was not applied/);
});

test('rootfs defaults fail loudly when the first-login marker survives', (context) => {
  // rootfs 里的 /root 是 0700 root，构建机上跑脚本的是普通用户 —— 一旦回退成
  // `[[ -f ]]` 判断，这个检查恒为假，标记会被静默留在包里（build-45.1 就是这么
  // 漏出去的）。这里用一个「假装删了但不删」的 sudo 桩，逼后置断言必须开火。
  const directory = fakeRootfs(context);
  const stub = path.join(directory, 'sudo-stub');
  fs.writeFileSync(stub, '#!/bin/sh\n[ "$1" = rm ] && exit 0\nexec "$@"\n', { mode: 0o755 });

  const result = apply(directory, { SUDO: stub });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /first-login marker survived/);
  assert.ok(exists(directory, 'root/.not_logged_in_yet'));
});

test('rootfs defaults flip the boot-time services measured on hardware', (context) => {
  const directory = fakeRootfs(context);

  assert.equal(apply(directory).status, 0);

  // 主力机制是 drop-in 常规文件。build-47.1 实机证明 *.wants 符号链接进不了镜像
  // （同一毫秒写的常规文件全在，两条链接都没了，见 docs/known-issues.md 第 8 条），
  // 所以这一条不能退回成只建链接。
  const dropin = fs.readFileSync(
    path.join(directory, 'etc/systemd/system/sysinit.target.d/10-b860-armbian-zram-config.conf'), 'utf8',
  );
  assert.match(dropin, /^Wants=armbian-zram-config\.service$/m);
  assert.match(dropin, /^\[Unit\]$/m);
  // 链接照旧建一条，好让实机上 systemctl is-enabled 显示 enabled。
  assert.equal(
    fs.readlinkSync(path.join(directory, 'etc/systemd/system/sysinit.target.wants/armbian-zram-config.service')),
    '/usr/lib/systemd/system/armbian-zram-config.service',
  );
  // 实测这条服务占开机 6 s，而这块板从来不需要等网络就绪。
  assert.ok(!exists(directory, 'etc/systemd/system/network-online.target.wants/NetworkManager-wait-online.service'));
});

test('rootfs defaults grow the rootfs into the data partition on boot', (context) => {
  // data 分区在 DTB 里是 size = <0xffffffff 0xffffffff>（剩下全给我），实际大小取决于
  // 板上 eMMC，构建时算不出来 —— 只能在板上 resize2fs。build-48.1 实机刷完根分区就是
  // raw 镜像那 768000 块（2.9G），而 p14 有 1351680 块；build-47.1 上看到的 5.1G 是
  // 当时手工跑过 resize2fs，不是「有别的东西会撑」。所以这套东西必须进包。
  const directory = fakeRootfs(context);

  assert.equal(apply(directory).status, 0);

  const helper = path.join(directory, 'usr/local/sbin/b860-expand-rootfs');
  // 不带尺寸 = 撑满所在分区；已经满了会 Nothing to do! + exit 0，所以幂等、不用标记。
  assert.match(fs.readFileSync(helper, 'utf8'), /resize2fs "\$\(findmnt -no SOURCE \/\)"/);
  assert.ok(fs.statSync(helper).mode & 0o111, 'helper must be executable');
  const unit = fs.readFileSync(path.join(directory, 'etc/systemd/system/b860-expand-rootfs.service'), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/local\/sbin\/b860-expand-rootfs$/m);
  // 和 zram 同一个坑：*.wants 链接进不了镜像，drop-in 常规文件才是主力。
  const dropin = fs.readFileSync(
    path.join(directory, 'etc/systemd/system/multi-user.target.d/10-b860-expand-rootfs.conf'), 'utf8',
  );
  assert.match(dropin, /^Wants=b860-expand-rootfs\.service$/m);
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

test('rootfs defaults install the meson-vdec firmware that hardware decode needs', (context) => {
  // 实机对照过两遍：上游镜像里 /lib/firmware/meson/ 整个目录都没有，所以 /dev/video0
  // 在、格式也枚举得出 H264，一 VIDIOC_STREAMON 就 -EINVAL（dmesg: firmware load for
  // meson/vdec/gxl_h264.bin failed with error -2）。补上 gxl_h264.bin 后 1280x720 的
  // 20 帧全解出来，把它挪走立刻退回 -EINVAL。
  const directory = fakeRootfs(context);

  assert.equal(apply(directory).status, 0);

  assert.match(vdec.installPath, /^\/lib\/firmware\//);
  for (const file of Object.keys(vdec.files)) {
    const blob = path.join(directory, vdec.installPath.replace(/^\//, ''), file);
    assert.ok(fs.existsSync(blob), `${file} must land in the rootfs`);
    assert.equal(fs.statSync(blob).mode & 0o777, 0o644);
  }
});

test('rootfs defaults fail loudly when no vdec firmware is available', (context) => {
  // 空目录静默通过 = 发一个硬解不能用的包，而实机上看起来像驱动坏了。
  const directory = fakeRootfs(context);
  const empty = path.join(directory, 'vdec-empty');
  fs.mkdirSync(empty);

  const result = apply(directory, { VDEC_FIRMWARE_DIR: empty });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no vdec firmware in/);
});

test('the packager verifies the preseed on the image it is about to sparse', () => {
  // 「脚本打印了启用」和「字节真的在包里」是两件事，build-47.1 就是在这里出事的。
  // 所以 dd 之后必须用 debugfs 复查一遍 drop-in，缺了让构建红。
  const packager = fs.readFileSync(path.join(root, 'scripts/build-burn-payloads.sh'), 'utf8');
  const dd = packager.indexOf('dd if="$root_part"');
  const sparse = packager.indexOf('burn-image.mjs" sparse');
  assert.ok(dd > 0 && sparse > dd);
  const between = packager.slice(dd, sparse);
  assert.match(between, /debugfs -R "stat \$dropin"/);
  assert.match(between, /drop-in is missing from the packaged rootfs/);
  assert.match(packager, /zram_dropin=\/etc\/systemd\/system\/sysinit\.target\.d\/10-b860-armbian-zram-config\.conf/);
  assert.match(packager, /expand_dropin=\/etc\/systemd\/system\/multi-user\.target\.d\/10-b860-expand-rootfs\.conf/);
  // 微码走同一个 debugfs 循环：清单从 board.json 读，加第四个文件不用改脚本。
  assert.match(between, /for dropin in "\$zram_dropin" "\$expand_dropin" "\$\{vdec_blobs\[@\]\}"/);
  assert.match(between, /vdecFirmware/);
});

test('rootfs defaults reject a directory that is not a rootfs', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-not-a-rootfs-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = apply(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not look like a rootfs/);
});
