#!/usr/bin/env bash
set -Eeuo pipefail

# 把「开箱即用」的默认值写进已经挂载好的 rootfs。由 build-burn-payloads.sh 在
# rootfs 还是 rw 挂载状态时调用。
#
# 之前这几项都是刷完机再手工改的，每次重刷全丢（见 docs/known-issues.md 第 7 条）。
#
# 开关 unit 不用 systemctl --root：构建机（CI runner / 本地 Docker）不一定装了
# systemd。开一个 unit 会写两样东西 —— 一个 <target>.d drop-in（常规文件）加一条
# 传统 *.wants 符号链接，为什么要两样见 §4 和 docs/known-issues.md 第 8 条。

usage() { echo "usage: $0 root-mount" >&2; exit 2; }
[[ $# -eq 1 ]] || usage
root_mount=$1
[[ -d "$root_mount/etc/systemd/system" && -f "$root_mount/etc/passwd" \
   && -f "$root_mount/etc/shadow" ]] || {
  echo 'root-mount does not look like a rootfs' >&2
  exit 1
}

# root 的登录 shell。上游镜像本来就是 zsh（5.9 + oh-my-zsh 都已装好），这里只是
# 钉死，免得首登向导问「1) bash 2) zsh」。要换 bash 改这一行即可。
root_shell=/usr/bin/zsh

# root 口令的 SHA-512 crypt 哈希，明文就是 README 写的 password。重现：
#   openssl passwd -6 -salt b860burn password
#
# 这一步必须自己做：镜像里唯一会**设**口令的东西就是首登向导，上面把它的触发
# 标记删掉之后，留在 /etc/shadow 里的是 Armbian 的出厂哈希（向导本来会强制改掉
# 它）—— 不钉死就等于发一个口令未知的包，实机 SSH 只会 Permission denied。
# 单引号是必须的，$6 会被 shell 当变量。
root_password_hash='$6$b860burn$21d1hZz5IOJZocmktz6vVDYwbPhywU7WZtS.7vOC73/M5HGWXUs0SBGFcIbsgfQBh1MwgdtMvQyG8HO2lACOj/'

# 要开/要关的 unit，写成 "unit:WantedBy 目标"。开 = drop-in + 链接，关 = 删链接。
enable_units=(
  'armbian-zram-config.service:sysinit.target'    # 1 GB 内存的板子，没 swap 很难受
  'b860-expand-rootfs.service:multi-user.target'  # §3 装的，撑满 data 分区
)
disable_units=(
  'NetworkManager-wait-online.service:network-online.target'  # 实测省 6 s 开机
)

say() { echo "  rootfs: $*"; }

# 真跑时要 sudo（rootfs 里的文件属 root）；测试时用 SUDO= 关掉。
sudo=${SUDO-sudo}

# ---- 1. 关掉首登向导 ----------------------------------------------------
# armbian-firstlogin 的触发条件就是这个文件存在（且是 tty 登录）。它会依次问
# shell、用户名、密码、真名、locale、时区、WiFi —— 每次重刷都要重来一遍。
# root 密码在镜像里已经是设好的 yescrypt 哈希，删掉标记不会让账号失去密码。
#
# 必须用 `$sudo test`，不能用 `[[ -f ]]`：rootfs 里的 /root 是 0700 root，而构建
# 机上跑这个脚本的是普通用户，stat 不进去 —— 用 [[ -f ]] 判断在 CI 上恒为假，
# 标记会被静默留在包里（build-45.1 就是这么漏出去的）。
marker="$root_mount/root/.not_logged_in_yet"
if $sudo test -f "$marker"; then
  $sudo rm -f "$marker"
  say '已删除 /root/.not_logged_in_yet（跳过首登向导）'
else
  say '/root/.not_logged_in_yet 本来就不在'
fi
# 后置断言：静默跳过是这一条最容易犯的错，宁可让构建红。
$sudo test ! -e "$marker" || {
  echo 'first-login marker survived: the flashed image would still run the wizard' >&2
  exit 1
}

# ---- 2. 钉住 root 的登录 shell 和口令 -----------------------------------
# 用 awk 不用 sed -i：BSD sed 的 -i 要单独带备份后缀参数，同一行命令在 macOS 上
# 会把 -E 吃成后缀，本地自测直接失败。
if ! grep -q "^root:.*:${root_shell}\$" "$root_mount/etc/passwd"; then
  [[ -x "$root_mount${root_shell}" ]] || { echo "shell not in rootfs: $root_shell" >&2; exit 1; }
  passwd_tmp=$(mktemp)
  awk -F: -v OFS=: -v shell="$root_shell" '$1 == "root" { $7 = shell } { print }' \
    "$root_mount/etc/passwd" > "$passwd_tmp"
  $sudo cp "$passwd_tmp" "$root_mount/etc/passwd"
  rm -f "$passwd_tmp"
fi
say "root shell = $root_shell"

# /etc/shadow 是 0640 root:shadow，读它也要走 $sudo —— 普通用户 awk 会直接
# Permission denied（和上面首登标记同一个坑，只是这次会报错而不是静默）。
root_hash_now() { $sudo awk -F: '$1 == "root" { print $2 }' "$root_mount/etc/shadow"; }
if [[ "$(root_hash_now)" != "$root_password_hash" ]]; then
  shadow_tmp=$(mktemp)
  # 第 3 个字段（上次改口令距 epoch 的天数）一起写成固定值：上游留的可能是 0，
  # 那是「下次登录强制改口令」，SSH 进去照样被拦一次，等于没做到开箱即用。
  # 20000 = 2024-10-04，配合 max 99999 就是「已设好、不过期」。
  $sudo awk -F: -v OFS=: -v hash="$root_password_hash" \
    '$1 == "root" { $2 = hash; $3 = 20000 } { print }' \
    "$root_mount/etc/shadow" > "$shadow_tmp"
  # cp 到已存在的文件是写进原 inode，0640 root:shadow 不变。
  $sudo cp "$shadow_tmp" "$root_mount/etc/shadow"
  rm -f "$shadow_tmp"
fi
# 后置断言，同 §1：口令没钉上就是发了个进不去的包，宁可让构建红。
[[ "$(root_hash_now)" == "$root_password_hash" ]] || {
  echo 'root password hash was not applied: the flashed image would have an unknown password' >&2
  exit 1
}
say 'root 口令 = 已钉死的 $6$ 哈希（明文见 README）'

# ---- 3. 开机把根文件系统撑满 data 分区 ----------------------------------
# data 分区在 DTB 里是 size = <0xffffffff 0xffffffff>（「剩下全给我」），所以它的
# 实际大小取决于板上 eMMC 有多大，构建时算不出来 —— 只能在板上读。8 GB 那批是
# 5,536,481,280 字节，而从 raw 镜像抠出来的 ext4 只有 768000 块（3.0 GiB），
# 差 2.1 GiB 全是白扔的。
#
# 所以装一个 oneshot：resize2fs 不带尺寸就是「撑满所在分区」，在线 resize 实测 8 s
# 内完成（768000 → 1351680 块）。已经满了它打印 Nothing to do! 并 exit 0，
# 每次开机跑一遍没有副作用，不需要一次性标记。
#
# 别用 Armbian 自带的 armbian-resize-filesystem：它先用 parted 重算分区边界，
# 而这块板的分区表来自 DTB 的 /partitions（Amlogic 私有格式），parted 直接
# unrecognised disk label，脚本在找 partstart 时 return 1。§4 末尾有断言盯着它。
#
# 单独一个脚本文件而不是把命令写进 ExecStart=，是为了躲开 systemd 对 $ 的转义规则。
$sudo mkdir -p "$root_mount/usr/local/sbin"
$sudo tee "$root_mount/usr/local/sbin/b860-expand-rootfs" >/dev/null <<'EXPAND'
#!/bin/sh
# 由 scripts/apply-rootfs-defaults.sh 写入镜像。手工跑也可以，幂等。
set -e
exec resize2fs "$(findmnt -no SOURCE /)"
EXPAND
$sudo chmod 0755 "$root_mount/usr/local/sbin/b860-expand-rootfs"
$sudo tee "$root_mount/etc/systemd/system/b860-expand-rootfs.service" >/dev/null <<'UNIT'
[Unit]
Description=Grow the B860 rootfs to fill the Amlogic data partition
Documentation=https://github.com/wuhao1477/b860av1-t-armbian-burn-builder
After=local-fs.target
ConditionPathIsReadWrite=/

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/b860-expand-rootfs
UNIT
say '已装 b860-expand-rootfs.service（开机 resize2fs 撑满 data 分区）'

# ---- 4. 开关 unit -------------------------------------------------------
# unit 文件可能在 /usr/lib（发行版自带）也可能在 /etc（我们自己装的），都要能找到。
unit_path() {
  local unit=$1 base
  for base in usr/lib etc; do
    if [[ -f "$root_mount/$base/systemd/system/$unit" ]]; then
      printf '/%s/systemd/system/%s\n' "$base" "$unit"
      return 0
    fi
  done
  echo "unit not found in rootfs: $unit" >&2
  return 1
}

# 开一个 unit 写两样东西，因为 build-47.1 证明光靠符号链接不行：
#
#   构建日志明明打印了「启用 armbian-zram-config.service」，e2fsck 报文件系统干净，
#   可实机上 /etc/systemd/system/*.wants/ 里两条链接一条都没有，而同一个脚本同一
#   毫秒写的常规文件（/etc/shadow、/etc/systemd/system/b860-expand-rootfs.service、
#   /usr/local/sbin/b860-expand-rootfs）全都在。链接是在哪一步掉的还没定论
#   （docs/known-issues.md 第 8 条），但「常规文件扛得住」是实机证据。
#
# 所以主力机制是 <target>.d/ 里的 drop-in 常规文件：[Unit] Wants= 和 *.wants 链接
# 完全等价。链接照旧也建一条，好让 systemctl is-enabled 显示 enabled。
for entry in "${enable_units[@]}"; do
  unit=${entry%%:*}
  target=${entry#*:}
  source_unit=$(unit_path "$unit")
  # 文件名统一 10-b860-*.conf；unit 自己就叫 b860-* 的话别写成 10-b860-b860-*。
  dropin=${unit%.service}
  dropin="10-b860-${dropin#b860-}.conf"
  $sudo mkdir -p "$root_mount/etc/systemd/system/$target.d"
  $sudo tee "$root_mount/etc/systemd/system/$target.d/$dropin" >/dev/null <<CONF
# 由 scripts/apply-rootfs-defaults.sh 写入。等价于 $target.wants/$unit，
# 但是常规文件 —— 符号链接进不了镜像，见 docs/known-issues.md 第 8 条。
[Unit]
Wants=$unit
CONF
  $sudo mkdir -p "$root_mount/etc/systemd/system/$target.wants"
  $sudo ln -sfn "$source_unit" "$root_mount/etc/systemd/system/$target.wants/$unit"
  say "启用 $unit（$target.d/$dropin + $target.wants 链接）"
done

for entry in "${disable_units[@]}"; do
  unit=${entry%%:*}
  target=${entry#*:}
  $sudo rm -f "$root_mount/etc/systemd/system/$target.wants/$unit"
  say "禁用 $unit"
done

# armbian-resize-filesystem 必须保持关闭 —— 上面解释过 parted 在这块板上认不出
# 分区表。这里断言一下，免得上游哪天默认打开了。
if [[ -e "$root_mount/etc/systemd/system/basic.target.wants/armbian-resize-filesystem.service" ]]; then
  echo 'armbian-resize-filesystem must stay disabled: parted cannot read the Amlogic table' >&2
  exit 1
fi

# ---- 5. 可选：本地 WiFi 预置（绝不进仓库） ------------------------------
# 仓库是公开的、包也是公开 CI 出的，所以 WiFi 密码不能写进代码。想让刷完就自动
# 连网，在本地放一个 board-inputs/wifi.env（已在 .gitignore 里），内容两行：
#   WIFI_SSID=你的网络
#   WIFI_PSK=你的密码
# CI 上没有这个文件，出的包里就不会有任何凭据。
wifi_env="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/board-inputs/wifi.env"
if [[ -f "$wifi_env" ]]; then
  # shellcheck disable=SC1090
  . "$wifi_env"
  [[ -n "${WIFI_SSID:-}" && -n "${WIFI_PSK:-}" ]] || { echo 'wifi.env needs WIFI_SSID and WIFI_PSK' >&2; exit 1; }
  profile="$root_mount/etc/NetworkManager/system-connections/$WIFI_SSID.nmconnection"
  $sudo mkdir -p "$(dirname "$profile")"
  $sudo tee "$profile" >/dev/null <<PROFILE
[connection]
id=$WIFI_SSID
type=wifi
interface-name=wlan0
autoconnect=true

[wifi]
mode=infrastructure
ssid=$WIFI_SSID

[wifi-security]
key-mgmt=wpa-psk
psk=$WIFI_PSK

[ipv4]
method=auto

[ipv6]
method=auto
PROFILE
  $sudo chmod 0600 "$profile"
  say "已预置 WiFi「$WIFI_SSID」（来自本地 board-inputs/wifi.env，不在仓库里）"
else
  say '没有 board-inputs/wifi.env，跳过 WiFi 预置'
fi

# ---- 6. meson-vdec 解码微码 ---------------------------------------------
# 上游 Armbian 镜像里 /lib/firmware/meson/ 整个目录都没有，所以 `/dev/video0`
# 在、格式也枚举得出 H264/MPG2/VP90，一 VIDIOC_STREAMON 就 -EINVAL，dmesg 里才
# 看到 `Direct firmware load for meson/vdec/gxl_h264.bin failed with error -2`。
# 实机对照过两遍：补上 gxl_h264.bin 后 1280x720 的 20 帧全解出来（NM12，
# 高度按 64 对齐成 768），把它挪走立刻退回 -EINVAL。
#
# 钉死的 commit 和 sha256 在 config/board.json 的 vdecFirmware 里。测试用
# VDEC_FIRMWARE_DIR 指到一个假目录来跳过下载（和上面的 SUDO= 一个套路）；
# 不设就自己下，让手工跑这个脚本也能得到完整结果。
firmware_dir=${VDEC_FIRMWARE_DIR-}
firmware_tmp=''
if [[ -z "$firmware_dir" ]]; then
  firmware_tmp=$(mktemp -d)
  trap 'rm -rf "$firmware_tmp"' EXIT
  "$(dirname -- "${BASH_SOURCE[0]}")/fetch-vdec-firmware.sh" "$firmware_tmp"
  firmware_dir=$firmware_tmp
fi
firmware_target=$(node -e '
  const fs = require("fs");
  console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).vdecFirmware.installPath);
' "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/config/board.json")
[[ "$firmware_target" == /lib/firmware/* ]] || {
  echo "vdecFirmware.installPath must live under /lib/firmware: $firmware_target" >&2
  exit 1
}
$sudo mkdir -p "$root_mount$firmware_target"
shopt -s nullglob
firmware_files=("$firmware_dir"/*.bin)
shopt -u nullglob
[[ ${#firmware_files[@]} -gt 0 ]] || { echo "no vdec firmware in $firmware_dir" >&2; exit 1; }
for blob in "${firmware_files[@]}"; do
  $sudo cp -- "$blob" "$root_mount$firmware_target/"
  $sudo chmod 0644 "$root_mount$firmware_target/$(basename -- "$blob")"
done
# 后置断言，同 §1/§2：少一个文件就是发一个硬解不能用的包。
for blob in "${firmware_files[@]}"; do
  $sudo test -f "$root_mount$firmware_target/$(basename -- "$blob")" || {
    echo "vdec firmware did not land in the rootfs: $(basename -- "$blob")" >&2
    exit 1
  }
done
say "已装 ${#firmware_files[@]} 个 vdec 微码到 $firmware_target"
