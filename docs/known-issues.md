# 待解决问题

实机（Armbian 26.11.0 / 5.10.268-ophub）已经能正常使用，下面是还没解决的。
每条都带实测证据和修它需要动什么，方便接手的人直接开工。

**还开着的：2、3、4、8、9。**
第 1、5、6、7 条已修复或已排除，保留下来是因为踩坑本身有价值。

## 1. eMMC 停在 25 MHz legacy 模式

**已修复并实机验证（2026-09-02）：22.4 → 82.0 MB/s，3.7 倍。**

修复后读数：

```
clock 52000000 Hz   timing spec 8 (mmc DDR52)   bus width 3 (8 bits)   signal voltage 1 (1.80 V)
hdparm -t /dev/mmcblk2 → 82.01 / 82.07 MB/sec   (两次一致)
dd 256M oflag=direct  → 23.4 MB/s 写
dmesg                 → "mmc2: new DDR MMC card"，mmc_select_hs200 failed 已消失
live DTB              → mmc-hs200-1_8v 已不在属性列表里
```

下面是定位过程，留着是因为「第一次尝试」那条假设很容易再犯。

### 症状

修复前读数（`/sys/kernel/debug/mmc2/ios`）：

```
clock         25000000 Hz     timing spec    0 (legacy)
bus width     3 (8 bits)      signal voltage 1 (1.80 V)
卡            Toshiba 008G70 (manfid 0x11) 7.28 GiB
hdparm -t /dev/mmcblk2 → 22.4 MB/sec
```

DTB 里能力其实都声明了 —— `cap-mmc-highspeed`、`mmc-ddr-1_8v`、`mmc-hs200-1_8v`
全在，信号电压也已经切到 1.8 V。卡住的是 HS200 协商本身：

```
mmc2: mmc_select_hs200 failed, error -74      (-74 = EBADMSG)

内核 mmc_select_timing() 对 EBADMSG 的处理是「不返回错误、直接 goto bus_speed」，
既不重试也不退到 HS52 —— 于是卡停在 legacy，时钟 25 MHz。
所以「掉到 legacy」不是驱动 bug，是 HS200 失败后不回退的必然结果。
```

**第一次尝试（已证伪）**：把 `max-frequency` 从 50 MHz 提到 200 MHz。刷入后实机
`max-frequency = 200000000` 确认生效，但 **HS200 照样 `-74` 失败，仍是 legacy 25 MHz**。
所以 50 MHz 上限不是原因 —— 这块板的 HS200 在任何时钟下都打不通，别再回头改这个值。

**第二次尝试（生效的那个）**：目标改成 DDR52。卡的 `ext_csd[196] DEVICE_TYPE = 0x57`
解出来是 `HS26 | HS52 | DDR52-1.8V | HS200-1.8V | HS400-1.8V` —— DDR52 是支持的，
拿不到纯粹是因为 HS200 先被尝试、失败后内核停在 legacy 不回退。

于是在 `writeStandaloneDtb()` 合并 overlay 之后用 `fdtput -d` 摘掉
`mmc-hs200-1_8v`，只留 `cap-mmc-highspeed` + `mmc-ddr-1_8v`，让
`mmc_select_timing()` 走 `mmc_select_hs()` → `mmc_select_hs_ddr()`。
（overlay 只能加属性不能删，所以只能在合并后删。删之前先 `fdtget -p` 查一下：
`fdtput -d` 对不存在的属性会硬报错，上游哪天不带它构建就会崩。）

`max-frequency` 保持 200 MHz —— 它不是瓶颈，DDR52 自己会把时钟停在 52 MHz。

**护栏**：`src/burn-standalone-dtb.mjs` 的 `validateHardware()` 断言
`mmc-hs200-1_8v` 不存在、`cap-mmc-highspeed` 与 `mmc-ddr-1_8v` 存在。
放回 `mmc-hs200-1_8v` = eMMC 掉回 22.4 MB/s，CI 会红。

## 2. `/boot` 是空的，没有内核升级路径

**证据**

```
ls /boot          → 空
dpkg -l | grep linux-image  → 无
```

内核和 DTB 只存在于 eMMC 的 `boot` 分区（Android boot 镜像里），rootfs 里没有副本。
好处是 `apt upgrade` 不会动到启动路径（不会升级内核 = 不会刷坏）；坏处是想换内核只能
重新构建整个 `burn.img` 再刷一次。

**修它需要**：做一个板上的更新脚本，用 `dd` 把新的 Android boot 镜像写进
`/dev/mmcblk2` 的 `boot` 分区偏移（1104 MiB）。写之前一定要先备份原分区。

## 3. 视频输出模式由厂商 U-Boot 决定

**证据**：某次开机 `/proc/cmdline` 里是 `vout=576cvbs`，HDMI 无输出；正常时是
`vout=1080p60hz`。这个值来自 `rsv` 里的 U-Boot 环境（`outputmode`），不是我们能在
boot 镜像里覆盖的。

**修它需要**：要么在 rootfs 的 initrd 阶段强制设置显示模式，要么接受「刷完第一次开机
如果黑屏，重新上电一次」。目前按后者处理。

## 4. 蓝牙初始化超时

**证据**

```
Bluetooth: hci0: BCM: Reset failed (-110)
hciconfig → 无可用设备
```

BCM 芯片的 firmware/UART 配置在这块板上没跑通。WiFi（RTL8189FTV / `8189fs`）不受影响，
工作正常。

**修它需要**：确认板上蓝牙芯片型号，补 `/lib/firmware/brcm/` 里对应的 `.hcd`，或在 DTB
里改 `&uart_A` 的 bluetooth 子节点。优先级低。

## 5. eth0 的 `carrier_changes=0`

**已排除，不是缺陷。** 2026-09-01 23:47 复查：以太网整条链路都是好的，当前只是没插网线。

PHY 被正确识别和绑定：

```
/sys/class/net/eth0/phydev -> .../mdio@e40908ff/ethernet-phy@8
phy_id   0x01814400        ← 读得出来，说明 MDIO 读写正常
driver   Meson GXL Internal PHY
```

跨开机的 link 记录（`journalctl -b -3`，2026-09-01 中午那次）：

```
12:30:08  eth0: Link is Up - 100Mbps/Full - flow control rx/tx
12:37:55  eth0: Link is Down
12:38:41  eth0: Link is Up - 100Mbps/Full
12:40:52  eth0: Link is Down
12:40:55  eth0: Link is Up - 100Mbps/Full
          dhcp4 (eth0): state changed new lease, address=192.168.100.28
```

之后三次开机（-2 / -1 / 0）一次 link 事件都没有，当前这次已开机 10.5 小时仍是
`NO-CARRIER`。**自协商到 100Mbps/Full 并拿到 DHCP 租约都发生过，MAC + PHY + 自协商
全部工作正常**；反复的 up/down 正是当时插拔网线的痕迹。

两个容易误判的点：

- **没插线时 `ethtool eth0` 只报 `10baseT/Half 10baseT/Full`**，看起来像 PHY 少了
  100M 能力。它实际协商到过 100Mbps/Full，所以这只是无载波状态下的寄存器读数，不用查。
- `ethtool --cable-test` 在这块板上不可用：`PHY driver does not support cable testing`，
  Meson GXL 内部 PHY 没实现，别指望用它判断线缆。

**教训**（这条要留着）：**不要在这块板上手工 `ethtool` 强制速率。** 早先「RX pair 物理
损坏」的判断是错的 —— 那是手工 `ip link set eth0 up` 加强制改速率造成 PHY/MAC 的 RMII
时钟不一致，干净重启就恢复了。

## 6. CI 还在发布已证伪的变体 A

**已修复**（`weekly-burn-build.yml`）。构建链现在是
`build-burn-payloads.sh` → `build-vendor-boot-burn.sh` → `validate-vendor-boot-burn.sh`，
发布资产换成 `vendor-boot-contract.json` / `burn-dtb-contract.json`，
`tests/mainline-workflow-contract.test.mjs` 里有一条断言禁止变体 A/B 的脚本名再出现在
这个 workflow 里。

注意 `weekly-burn-build.yml` 的 `build` job 依赖 `detect`，而 `detect` 带
`if: github.ref_name == github.event.repository.default_branch` —— **在 feature 分支上
dispatch 只会跑诊断 job，产不出包**，要在默认分支上才能验证。

## 7. 板上手改的三项修复扛不住重刷

**已修复并实机验证（`build-49.1`，2026-09-03）。** 这些项之前只改了 rootfs、没进构建，
重刷之后全部回到出厂值。现在由 `scripts/apply-rootfs-defaults.sh` 在
`build-burn-payloads.sh` 里（rootfs 还 rw 挂着的时候）写进镜像。

`build-48.1` / `build-49.1` 刷完的实测结果：

| 项 | 出厂 | 现在进包的做法 | 实机 |
|---|---|---|---|
| 首登向导 | 每次重刷都问 shell/用户/密码/locale | 删 `/root/.not_logged_in_yet` | 不再出现 ✅ `49.1` |
| root 口令 | 首登向导现场设 | 在 `/etc/shadow` 里钉死 `password` 的 `$6$` 哈希 | SSH 直接进 ✅ `49.1` |
| root shell | zsh（上游默认） | 在 `/etc/passwd` 里钉死 `/usr/bin/zsh` | `/usr/bin/zsh` ✅ `49.1` |
| 开机耗时 | 41.2 s | 禁用 `NetworkManager-wait-online.service` | 用户态 8.8 s ✅ `48.1`（首刷那次 17.3 s，含 resize 和首启动作） |
| swap | 无 | `armbian-zram-config.service`，靠 `sysinit.target.d` drop-in | zram0 400.3M ✅ `48.1` `49.1` |
| 根分区 | 2.9G，data 分区有 5.1G | `b860-expand-rootfs.service` 跑 `resize2fs`，靠 `multi-user.target.d` drop-in | 首次开机自己撑到 5.1G ✅ `49.1` |

`build-49.1` 首刷第一次开机，服务自己干完了（时间戳是 fake-hwclock 的，板上没 RTC）：

```
Aug 31 10:17:12 b860-expand-rootfs[1435]: Filesystem at /dev/mmcblk2p14 is mounted on /; on-line resizing required
Aug 31 10:17:12 b860-expand-rootfs[1435]: The filesystem on /dev/mmcblk2p14 is now 1351680 (4k) blocks long.
Aug 31 10:17:12 systemd[1]: Finished b860-expand-rootfs.service
df -h /  → /dev/mmcblk2p14  5.1G  1.7G  3.4G  33% /
```

**根分区撑满得我们自己管（`build-48.1` 纠正了 `build-47.1` 的误判）。** `build-47.1`
那次看到 p14 上的 ext4 从 768000 块长到 1351680 块，当时归因成「有别的东西在初始化阶段
撑好了」，于是把 `b860-expand-rootfs.service` 删了。**那是错的** —— 长大是因为当时在板上
手工跑过 `resize2fs`。`build-48.1` 刷完（只有一次开机、`journalctl -b | grep -ic resiz`
为 0）根分区就是 raw 镜像自带的 768000 块：

```
df -h /      → /dev/mmcblk2p14  2.9G  1.7G  1.2G  58% /
dumpe2fs -h  → Block count 768000   (× 4096 = 3.0 GiB)
lsblk -b     → mmcblk2p14  5536481280   (= 1351680 块，差 2.1 GiB)
```

`data` 分区在 DTB 里是 `size = <0xffffffff 0xffffffff>`（「剩下的全给我」），实际大小
取决于板上 eMMC 有多大，构建时算不出来，所以不能在构建时把 ext4 预先 resize 到某个
常数 —— 只能在板上跑。现在 `apply-rootfs-defaults.sh` 装回了那个 oneshot：
`resize2fs "$(findmnt -no SOURCE /)"`，不带尺寸就是撑满所在分区，已经满了打印
`Nothing to do!` 并 exit 0，所以幂等、不需要一次性标记。靠 `multi-user.target.d/`
的 drop-in 拉起来（这次链接不是唯一机制了，见第 8 条）。

在线 resize 实测很快，不是第 7 条早先记的那种卡死：

```
resize2fs 1.47.2 … on-line resizing required
The filesystem on /dev/mmcblk2p14 is now 1351680 (4k) blocks long.     ← 8 s 内完成
```

**为什么不用 Armbian 自带的 `armbian-resize-filesystem`**：它先用 `parted` 重算分区
边界，而这块板的分区表来自 DTB 的 `/partitions`（Amlogic 私有格式）：

```
# parted /dev/mmcblk2 unit s print -sm
Error: /dev/mmcblk2: unrecognised disk label
```

脚本会在找 `partstart` 时 `return 1`。所以自带的那份必须保持关闭，
`apply-rootfs-defaults.sh` 里有一条断言盯着它。

**删首登向导必须连口令一起钉死。** 镜像里唯一会*设*口令的东西就是那个向导；只删
`/root/.not_logged_in_yet`、不动 `/etc/shadow`，包的 root 口令就是上游 Armbian 的出厂
哈希（向导本来会强制改掉它），谁都不知道明文是什么，实机 SSH 只会 `Permission denied`。
**`build-46.1` 就是这么出去的** —— 向导没了、口令没钉，那个包谁也进不去，别刷它。
`apply-rootfs-defaults.sh` 现在把 `openssl passwd -6 -salt b860burn password` 的结果写进
去，并顺手把第 3 字段（上次改口令的天数）从 `0` 改成固定值 —— `0` 是「下次登录强制改
口令」，留着照样会被拦一次。写完有一条后置断言，没钉上就让构建红。

**WiFi 凭据不进仓库。** 仓库和 CI 产物都是公开的。想让刷完就自动连网，在本地放一个
`board-inputs/wifi.env`（已 gitignore）：

```
WIFI_SSID=你的网络
WIFI_PSK=你的密码
```

只有本地构建会读它。CI 上没有这个文件，公开发布的包里不含任何凭据 ——
`tests/rootfs-defaults.test.mjs` 有一条断言盯着。

**`resize2fs` 要用 `setsid nohup` 脱离 SSH 跑**（手工补救时才需要），否则会话一断整机
卡死：

```bash
setsid nohup resize2fs /dev/mmcblk2p14 > /var/log/b860-resize.log 2>&1 < /dev/null &
```

前台跑过一次，整机 7 分钟无响应（ping 通、TCP 22 accept，但 SSH 握手超时）。断电重启后
文件系统 `clean`、块数没变 —— 没有提交任何中间状态，所以是安全的，但别再踩。

## 8. `*.wants` 符号链接进不了镜像

**已绕开，根因未定。** 构建时写进 rootfs 的符号链接在实机上一条都不在，同一个脚本
同一毫秒写的常规文件全都在。

`build-47.1` 的构建日志（run 33712394527）：

```
03:46:05.0983  rootfs: 启用 armbian-zram-config.service
03:46:05.1122  rootfs: 启用 b860-expand-rootfs.service
03:46:07.3474  ROOTFS: 56159/192000 files (0.1% non-contiguous), 492207/768000 blocks   ← e2fsck 干净，没修任何东西
```

同一次构建写的常规文件，实机上全在，mtime 和构建日志对到毫秒（CI 是 UTC，板子 CST）：

```
2026-09-03 11:46:04.994  /etc/fstab
2026-09-03 11:46:05.029  /etc/passwd
2026-09-03 11:46:05.052  /etc/shadow
2026-09-03 11:46:05.081  /etc/systemd/system/b860-expand-rootfs.service      ← /etc/systemd/system 底下的常规文件也在
2026-09-03 11:46:05.067  /usr/local/sbin/b860-expand-rootfs
```

而 `05.098` 和 `05.112` 那两条链接，实机上一条都没有：

```
find /etc/systemd/system -type l          → 52 条，全部是上游或首次开机建的，
                                             没有一条 mtime 落在 11:46
journalctl -b -1 | grep -i expand         → 空（首次开机 10:17:09 就 Reached
                                             target multi-user.target，服务从没启动）
journalctl -u armbian-zram-config         → 手工 enable 之前没有任何记录
```

已经排除的：

- **首次开机的脚本没干这事。** `armbian-fix` / `armbian-firstrun` 里的
  `systemctl mask/disable/enable` 全是点名操作（sleep.target、motd-news、
  armbian-resize-filesystem、ssh.socket → ssh.service），没有 `preset-all`，
  没有对 `*.wants` 的批量删除。
- **不是 dangling 链接被 systemd 清掉。** 两条链接的目标在实机上都真实存在。
- **不是目录本身是链接**：`sysinit.target.wants` 和 `multi-user.target.wants` 都是
  真目录（`btime` 是上游镜像的 2026-08-31 17:56:56），所以 `ln` 不会跑到构建机上去。
- **不是 e2fsck 修掉的**：上面那行 e2fsck 输出是干净盘的常规统计，没有 `FIXED`。
- **不是仓库里有代码删链接**：`grep -rn "type l|-delete" scripts/ src/` 只有一处，
  是变体 A 脚本里删多余 DTB 用的。

**`build-48.1` 的新证据：丢失发生在 `dd` 之后，而且不是只丢我们写的那条。**
新加的 `debugfs` 复查（构建日志 run 33723826992）证明链接确实躺在要 sparse 的那份 ext4 里：

```
12231  120777  51  3-Sep-2026 06:35   armbian-zram-config.service    ← 我们写的，在包里
 3192  120777  46  31-Aug-2026 02:19  armbian-ramlog.service         ← 上游写的，也在包里
 3194..3197    14-Aug-2026 06:29/06:30  fake-hwclock-load / keyboard-setup / systemd-pstore / systemd-resolved
```

实机上这个目录只剩 `3194..3197` 那四条。**上游那条 `armbian-ramlog.service` 链接同样
不见了** —— 它是上游镜像自己写的，跟我们的脚本无关，所以这不是「我们写链接的方式不对」。
存活的四条 mtime 都是 14-Aug（基础镜像装包时间），丢掉的两条是 31-Aug（ophub 组装镜像）
和 3-Sep（我们）。

（`armbian-ramlog` 在实机上照样在跑，是 `armbian-ramlog.timer` 拉起来的，
`systemctl is-enabled armbian-ramlog` 是 `disabled`。别拿「服务在跑」当链接还在。）

没排除的：`sparse` 转换、USB Burning Tool 写 eMMC、初始化阶段（journald 起来之前）。
`umount` / `e2fsck` / `dd` 已经由上面那份 `debugfs` 列表排除。

**绕开的办法**：`apply-rootfs-defaults.sh` 现在主要靠 `<target>.d/` 里的 drop-in
**常规文件**（`[Unit] Wants=`，和 `*.wants` 链接完全等价），链接照旧也建一条，好让
`systemctl is-enabled` 显示 enabled。另外 `build-burn-payloads.sh` 在 `dd` 之后用
`debugfs` 在要写进 eMMC 的那份 ext4 上复查 drop-in，缺了就让构建红 —— 这次别再靠
「脚本打印了启用」下结论；同时把 `sysinit.target.wants` 的目录列表打进日志，链接到底
是不是又掉了，留给下一次实机对照。

**drop-in 这条路已实机验证（2026-09-03，`build-47.1` 的板子上）。** 把手工建的那条链接
删掉、只留 `/etc/systemd/system/sysinit.target.d/10-b860-armbian-zram-config.conf`，
`daemon-reload` 后 `systemctl show sysinit.target -p Wants` 里就有
`armbian-zram-config.service`；冷重启后：

```
ls /etc/systemd/system/sysinit.target.wants/ | grep -c zram   → 0        ← 一条链接都没有
swapon --show     → /dev/zram0  partition  400.3M  PRIO 5
zramctl           → zram0 lzo-rle 400.4M [SWAP]（zram1 50M 是 ramlog 的）
systemctl is-active  armbian-zram-config.service → active
systemctl is-enabled armbian-zram-config.service → disabled              ← 只是显示，不影响启动
```

所以即使链接再一次进不了镜像，`build-48.1` 的 swap 也会起来。

**`build-49.1` 又把范围缩小了：丢失是「针对某个目录」的，不是针对所有链接。**
同一次构建、同一个脚本、同一个 `ln -sfn`，写进两个不同目录的两条链接，实机上一条活一条死：

```
/etc/systemd/system/multi-user.target.wants/b860-expand-rootfs.service   ← 活着（mtime 就是构建时间 08:14 UTC）
/etc/systemd/system/sysinit.target.wants/armbian-zram-config.service     ← 没了
/etc/systemd/system/sysinit.target.wants/armbian-ramlog.service          ← 也没了（上游的）
```

`sysinit.target.wants/` 里只剩那四条 14-Aug 的。所以「我们写链接的方式不对」和
「sparse / Burning Tool 丢符号链接」两种解释都不成立 —— 它们不会只挑一个目录下手。
剩下的怀疑集中在 `sysinit.target.wants` 这个目录本身（初始化早期有东西在动它，
journald 起来之前，所以日志里看不到）。

已经排除掉的新候选：`armbian-fix` 全文只 `mask sleep/suspend/hibernate`、
`disable motd-news / armbian-resize-filesystem / ssh.socket / serial-getty@*`，
没有 ramlog / zram；本次开机日志里 `disab|mask` 也没有 ramlog / zram 的记录。

**结论没变，而且现在有两次实机证据支持**：开机自启只能靠 `<target>.d/` 里的 drop-in
常规文件。两条 drop-in（`sysinit.target.d` 的 zram、`multi-user.target.d` 的
expand-rootfs）在 `build-49.1` 上都按预期起来了。

## 9. 内核线 2026-12-31 EOL，且没有保住 WiFi 的升级路线

**已知、无解，只能等移植。** 当前钉死在 5.10.268（[`frozen-inputs.md`](frozen-inputs.md)）。

这块板唯一的无线是 SDIO 的 RTL8189FTV，驱动 `rtl8189fs` 是 out-of-tree 的，主线没有。
ophub 的 `kernel-config/release/stable/config-*` 里 `CONFIG_RTL8189FS=m` 只出现在
5.10 和 5.15；6.1 / 6.6 完全没有，6.12 / 6.18 只有 `CONFIG_RTL8188EE=m`（PCIe 的另一颗
芯片，不是这块板上的）。而 5.10 和 5.15 的 EOL 都是 **2026-12-31**。

所以：**升级到任何 6.x = 丢掉 WiFi；留在有 WiFi 的两条线 = 年底之后没有上游补丁。**

**修它需要**：把 `rtl8189fs` 移植到 6.12（或 6.18）并让 ophub 的 config 带上，这是唯一
能长期活下去的路。三条路线的对比在 [`frozen-inputs.md`](frozen-inputs.md)。

在那之前：用户态照常 `apt full-upgrade` 就能跟上（rootfs 里没有 `linux-image-*`，
`apt` 碰不到启动路径，见第 2 条），只是换不了内核。
