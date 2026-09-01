# 待解决问题

实机（Armbian 26.11.0 / 5.10.268-ophub）已经能正常使用，下面是还没解决的。
每条都带实测证据和修它需要动什么，方便接手的人直接开工。

## 1. eMMC 停在 25 MHz legacy 模式

**证据**

```
dmesg: mmc_select_hs200 failed, error -74
       mmc2: new  MMC card at address 0001            ← 没有 "HS200" / "HS400"
hdparm -t /dev/mmcblk2: 22.4 MB/sec
```

HS200 应该能到 ~150 MB/s，现在慢了 6 倍以上。`error -74` = `EBADMSG`，tuning 阶段
CRC 失败。

**修它需要**：改 `meson-gxl-s905x-p212-b860av11t.dtb` 里 `&sd_emmc_c` 的
`max-frequency` / `mmc-hs200-1_8v` / `cap-mmc-highspeed`，重新构建 boot 镜像并
**重刷整包**。仓库里有 `b860-emmc-50mhz.patch` 可作起点。风险中等 —— 调错了直接不启动，
必须准备好回退包。

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

**证据**：最后一次开机 `cat /sys/class/net/eth0/carrier_changes` 是 0。之前一次开机
eth0 完全正常（`Link is Up - 100Mbps/Full`，DHCP 拿到 `192.168.100.28`，RX 840 包 0 错误），
说明**硬件是好的**。

早先「RX pair 物理损坏」的判断是错的 —— 那是我手工 `ip link set eth0 up` 加强制改
速率造成的 PHY/MAC RMII 时钟不一致，干净重启后就恢复了。**不要在这块板上手工强制
ethtool 速率。**

**修它需要**：先确认网线是否插着。若插着仍为 0，抓 `dmesg | grep -i eth` 看 PHY 是否
被探测到。

## 6. CI 还在发布已证伪的变体 A

`.github/workflows/weekly-burn-build.yml` 跑的是 `build-burn-image.sh`（变体 A），
产出的 `burn.img` 结构合法但**实机全黑**。任何人从 Release 下载都会刷坏一次。

**修它需要**：把 build/validate 两步换成 `build-vendor-boot-burn.sh` /
`validate-vendor-boot-burn.sh`，输入从 raw 镜像改成解包目录，Release 资产名从
`emmc-boot-contract.json` / `mainline-fip-contract.json` / `rootfs-contract.json` /
`burn-report.json` 换成 `vendor-boot-contract.json` / `burn-dtb-contract.json`。
同时要在 job 里加 `scripts/setup-image-tools.sh`。

注意 `weekly-burn-build.yml` 的 `build` job 依赖 `detect`，而 `detect` 带
`if: github.ref_name == github.event.repository.default_branch` —— **在 feature 分支上
dispatch 只会跑诊断 job，产不出包**。改完要合到默认分支才能验证。

---

## 已做过的板上修复（重启后验证有效）

不涉及启动路径，没有动 bootloader / boot 分区 / DTB / `/etc/fstab`。

| 项 | 之前 | 之后 |
|---|---|---|
| 根分区 | 2.9G（768000 块） | 5.1G（1,351,680 块），剩余 3.4G |
| swap | 无 | zram 400 MB |
| 开机耗时 | 41.2 s | 26.3 s（禁用 `NetworkManager-wait-online.service`） |
| failed units | — | 0 |

**`resize2fs` 要用 `setsid nohup` 脱离 SSH 跑**，否则会话一断整机卡死：

```bash
setsid nohup resize2fs /dev/mmcblk2p14 > /var/log/b860-resize.log 2>&1 < /dev/null &
```

前台跑过一次，整机 7 分钟无响应（ping 通、TCP 22 accept，但 SSH 握手超时）。断电重启后
文件系统 `clean`、块数没变 —— 没有提交任何中间状态，所以是安全的，但别再踩。
