#!/usr/bin/env bash
set -Eeuo pipefail

# 把「开箱即用」的默认值写进已经挂载好的 rootfs。由 build-burn-payloads.sh 在
# rootfs 还是 rw 挂载状态时调用。
#
# 之前这几项都是刷完机再手工改的，每次重刷全丢（见 docs/known-issues.md 第 7 条）。
#
# 全部用符号链接直接操作 systemd 的 *.wants 目录，**不用 systemctl --root**：
# 构建机（CI runner / 本地 Docker）不一定装了 systemd，而这几个 unit 的
# [Install] 段都很简单，符号链接是它唯一的产物。

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

# 要开/要关的 unit，写成 "unit:WantedBy 目标"。开 = 建链接，关 = 删链接。
enable_units=(
  'armbian-zram-config.service:sysinit.target'   # 512 MiB 内存的板子，没 swap 很难受
  'b860-expand-rootfs.service:multi-user.target' # 见下，本文件自己装的
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

# ---- 3. 首次开机把根文件系统撑满 ----------------------------------------
# 不能用 Armbian 自带的 armbian-resize-filesystem：它先用 parted 重算分区边界，
# 而这块板的分区表来自 DTB 的 /partitions（Amlogic 私有格式），parted 直接报
# "unrecognised disk label"，脚本会在找 partstart 时 return 1。
#
# 也不需要它做的事 —— data 分区在 DTB 里是 ffffffff（吃掉剩余全部空间），实机
# 上 p14 已经有 5.15 GiB，缺的只是把 2.81 GiB 的 ext4 撑到分区大小。所以只跑
# resize2fs，一个字节的分区表都不碰。
$sudo tee "$root_mount/usr/local/sbin/b860-expand-rootfs" >/dev/null <<'SCRIPT'
#!/bin/sh
# 首次开机把根文件系统撑到 data 分区的实际大小，然后自己关掉。
# 只做 resize2fs：分区表是 Amlogic 私有格式，parted 认不出来，也不需要改。
set -eu
device=$(findmnt -no SOURCE /)
resize2fs "$device"
rm -f /etc/systemd/system/multi-user.target.wants/b860-expand-rootfs.service
SCRIPT
$sudo chmod 0755 "$root_mount/usr/local/sbin/b860-expand-rootfs"

$sudo tee "$root_mount/etc/systemd/system/b860-expand-rootfs.service" >/dev/null <<'UNIT'
[Unit]
Description=Expand the B860 root filesystem to fill the data partition
Documentation=https://github.com/wuhao1477/b860av1-t-armbian-burn-builder
ConditionPathExists=/usr/local/sbin/b860-expand-rootfs

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/b860-expand-rootfs
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
UNIT
say '已装 b860-expand-rootfs.service（只在首次开机跑一次）'

# ---- 4. 开关 unit -------------------------------------------------------
# unit 文件可能在 /usr/lib（发行版自带）也可能在 /etc（我们刚装的），都要能找到。
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

for entry in "${enable_units[@]}"; do
  unit=${entry%%:*}
  target=${entry#*:}
  source_unit=$(unit_path "$unit")
  $sudo mkdir -p "$root_mount/etc/systemd/system/$target.wants"
  $sudo ln -sfn "$source_unit" "$root_mount/etc/systemd/system/$target.wants/$unit"
  say "启用 $unit"
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
