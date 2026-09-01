# 待解决问题

实机（Armbian 26.11.0 / 5.10.268-ophub）已经能正常使用，下面是还没解决的。
每条都带实测证据和修它需要动什么，方便接手的人直接开工。

**还开着的：2、3、4、7。** 第 1、5、6 条已修复或已排除，保留下来是因为踩坑本身有价值。

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

**开着的。** 下面三项都只改了 rootfs，**没有进构建**，所以 2026-09-02 重刷 DDR52
包之后全部回到出厂值，得手工再来一遍。

| 项 | 出厂 | 手改后 | 重刷后 |
|---|---|---|---|
| 根分区 | 2.9G（768000 块） | 5.1G（1,351,680 块） | 2.9G |
| swap | 无 | zram 400 MB | 无 |
| 开机耗时 | 41.2 s | 26.3 s（禁 `NetworkManager-wait-online.service`） | 32.5 s |

**修它需要**：把这三项挪进镜像 —— 根分区尺寸在
`scripts/build-burn-payloads.sh` 生成 `data.PARTITION` 时定，zram 和禁用
`NetworkManager-wait-online` 属于 rootfs 预置。做完就不用每次重刷都补。

**`resize2fs` 要用 `setsid nohup` 脱离 SSH 跑**，否则会话一断整机卡死：

```bash
setsid nohup resize2fs /dev/mmcblk2p14 > /var/log/b860-resize.log 2>&1 < /dev/null &
```

前台跑过一次，整机 7 分钟无响应（ping 通、TCP 22 accept，但 SSH 握手超时）。断电重启后
文件系统 `clean`、块数没变 —— 没有提交任何中间状态，所以是安全的，但别再踩。
