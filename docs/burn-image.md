# 直刷包（burn.img）

给 `ZXV10 B860AV1.1-T`（Amlogic S905X / P212，1 GB 内存，8 GB eMMC）做 Amlogic USB
Burning Tool 能直接刷的 `burn.img`，刷完开机就是 Debian/Armbian。

## 当前状态

**变体 C 已在实机验证。** 交付的那一份是 `v1.0.0`（构建序号 `build-49.1`），`burn.img` sha256
`2303d1c58b0061e9a70d6159e27e546c382d06cf792f3680d69f3659b8f02822`。刷完直接进系统，
不走首次开机向导，六项预置全部实机确认（2026-09-03 首次，2026-09-04 换一次刷入复验）：

```
Armbian OS 26.11.0 trixie / Debian GNU/Linux 13
Linux 5.10.268-ophub aarch64        BOARD="B860av1-T"
登录     root / password            SSH 直接进，不问 shell / 用户名 / 时区
shell    /usr/bin/zsh 5.9 + oh-my-zsh
根分区   /dev/mmcblk2p14 ext4 5.1G  首次开机 resize2fs 自己撑满（2.9G → 5.1G）
swap     /dev/zram0 400.3M
开机     24.3 s 进系统              已禁用 NetworkManager-wait-online
wlan0    RTL8189FTV (8189fs)        已连 AP，可上网
eth0     100Mbps/Full               DHCP 正常，收发无错误
HDMI     card0-HDMI-A-1 connected
eMMC     DDR52 82 MB/s              hdparm -t，HS200 打不通见 known-issues 第 1 条
```

上游输入已冻结在这一份验证过的组合上，见 [`frozen-inputs.md`](frozen-inputs.md)；
每周构建只在 pin 或配方变化时才出新包。预置本身由
[`scripts/apply-rootfs-defaults.sh`](../scripts/apply-rootfs-defaults.sh) 写进镜像，
`build-44.1` … `build-48.1` 的差异和踩坑见 [`known-issues.md`](known-issues.md) 第 7 条。

变体 A、B 已被实机证伪，原因见下面「三次全黑的根因」。

## 变体 C 的设计

`scripts/build-vendor-boot-burn.sh`，策略标识 `vendor-fip-vendor-bl33-android-boot`。

核心原则：**厂商 bootloader 一个字节都不改。** 不重打包 FIP，不嵌 MBR，BL33 仍是厂商
`U-Boot 2015.01-gd020ddf gxl_p211_1g`。Armbian 通过厂商 U-Boot 自己的启动路径进来：

```
bootrom
  → 原厂签名 BL2/BL30/BL301/BL31            board-inputs/bootloader.PARTITION 原样
  → 厂商 BL33 U-Boot 2015.01
  → preboot: init_display（画开机图）
  → bootcmd = run storeboot
  → storeboot = if imgread kernel boot ${loadaddr}; then bootm ${loadaddr}; fi
  → boot.PARTITION 里的 ANDROID! v0 镜像
  → Armbian kernel + initrd → Debian rootfs（data.PARTITION）
```

### 包内载荷

| 载荷 | 内容 | 来源 |
|---|---|---|
| `bootloader.PARTITION` | 原厂 FIP，逐字节不改 | `board-inputs/`，sha256 `50b0fb65…` |
| `boot.PARTITION` | ANDROID! v0：kernel + initrd + DTB | 构建时生成 |
| `data.PARTITION` | sparse ext4 Debian rootfs | 构建时生成 |
| `logo.PARTITION` | 原厂开机图 | `board-inputs/`，**诊断用，见下** |
| `meson1.dtb` | `gxl_p211_1g` 槽换成 Linux DTB | `replace-linux-target-dtb` |
| `DDR.USB` / `UBOOT.USB` / `aml_sdc_burn.*` / `platform.conf` | 烧录工具输入 | `board-inputs/` 原样 |

不产 `1.PARTITION`、`env.PARTITION`、`system.PARTITION`、`recovery.PARTITION`。

### Android boot 镜像的字段

头部数值逐个抄自原厂 `boot.PARTITION`，不要自己发明：

```
magic ANDROID!    page_size 2048    header_version 0
kernel  @0x01080000    gzip（厂商内核本身就是 gzip，bootm 会解压，所以 Image.gz 可直接用）
ramdisk @0x01000000    原厂是 gzip cpio；我们用 XZ 的 initrd.img 也可以 —— U-Boot 只透传，由内核解
second  @0x00f00000    DTB。原厂放的是 AML_ 多 DTB 容器，放裸 FDT 同样可用
tags    @0x00000100
```

### 根文件系统怎么被找到

**靠内核 cmdline 里的 `blkdevparts=`，不靠 MBR。** 这样 bootloader 才能真正零改动。

厂商 `storeargs` 会先把 `bootargs` 设成 Android 的 `initargs`，boot 镜像自带的 cmdline
追加在后面。Linux 对重复参数取最后一个，所以我们的 `root=` / `init=` / `rootfstype=` /
`console=` 全部覆盖掉厂商那份。实机 `/proc/cmdline` 实测：

```
rootfstype=ramfs init=/init console=ttyS0,115200 …（厂商 initargs）
blkdevparts=mmcblk2:… root=UUID=… rw rootwait rootfstype=ext4 mem=1024M
console=ttyAML0,115200n8 console=tty0 … init=/sbin/init      （我们的，生效）
```

**这块板没有可用串口，`console=tty0` 必须放在最后**，否则 `/dev/console` 会是串口，
屏幕上什么都看不到。

### 为什么带 `logo.PARTITION`

没有串口时，开机图是唯一能区分两类失败的信号：

- **有开机图** → 原厂 BL2/BL30/BL301/BL31/BL33 全跑起来了，故障在 `storeboot` 之后
- **全黑** → 连 BL2 都没过，问题在 bootloader 本身

调试直刷包时这一条省掉的时间比任何其他手段都多。

## 三次全黑的根因

按发现顺序记录，每条都是实测，不是推断。

### 1. gxlimg 还原不出原厂的 FIP 编码

**这是变体 A/B 全黑的真正原因。** 拿实机能启动的 Milton 包做往返测试：

```
gxlimg -t bl3x -d bl33.enc → -c 再编码
  549,888 字节里 547,330 字节不同
  AMLC 头 0x00..0x20 一致（magic、各长度字段全对），0x20..0x40 的 32 字节和整个载荷全变

用未改动的 bl2/bl30/bl301/bl31/bl33 重建 FIP
  779,264 字节 vs 原厂 786,432
  只有前 0xC000（BL2）对得上，从 0xC020 起就不一样 —— 同一个 +0x20 字段
```

结论：**「复用原厂签名段、只换 BL33」这条路在这块板上走不通。** 重打包出来的
bootloader，原厂 BL2 拿到的是它不认的 BL33 块，加载完跳过去就死 —— HDMI 无信号、
无串口、RJ45 无 link、只有电源灯。与 BL33 选主线 v2026.01 还是 ophub 2020.07 无关。

动 FIP 之前先跑这个往返测试。

### 2. MBR 落在 BL2 自身摘要的覆盖范围里

如果确实需要嵌 MBR（变体 C 不需要），**必须重算 BL2 的完整性摘要**。

gxlimg `bl2.c` 的 `gi_bl2_sign()` 把 SHA-256 存在 BL2 的 `0x50..0x70`，覆盖
`[0x10,0x50)` 与 `[0x10+hash_start, +hash_size)`。本板 `hash_start=0x60`、
`hash_size=0xbf90`，第二段就是 `[0x70,0xC000)` —— **DOS MBR 所在的 446..511 正好落在里面**。
摘要一旦过期，bootrom 拒绝执行 BL2。

BL2 的 `0x70..0x25F` 全为零，说明这块板没有 RSA 签名段，只有这一份摘要，所以重算写回
`0x50` 是完整修复，不需要厂商私钥。`embedDosMbr()` / `embedRootfsMbr()` 之后会自动
调用 `resealBl2()`。

### 3. 分区名必须在 `meson1.dtb` 的 `/partitions` 表里

MBR 不能作为独立的分区项写进包。原厂 U-Boot 的 `store` 按**分区名**查
`meson1.dtb` 的 `/partitions` 表，表里只有
`conf/logo/recovery/rsv/tee/crypt/misc/boot/system/cache/data`。写一个名为 `1` 的分区，
烧录必然停在：

```
[0x30402004] UBOOT/烧录分区 1/初始化分区/命令结果返回错误
```

同理，写 `env.PARTITION` 也必然失败 —— **这块板没有 `env` 分区**，U-Boot 环境存在
`rsv` 里面。

需要 MBR 时，正确做法是嵌进 `bootloader.PARTITION` 的 sector 0：`blkdevparts` 的
`4M@0(bootloader)` 说明 eMMC user 区 LBA 0 就是 bootloader 的 sector 0，原厂 FIP 在
440..511 全为零。ophub `install-aml.sh` 也正是用 `bs=1 count=442` +
`bs=512 skip=1 seek=1` 跳过这一段。

### 4. Amlogic 分区偏移的推算规则

`meson1.dtb` 的 `/partitions` 只给大小不给偏移，偏移按下面的规则顺序分配
（已用仓库里已知正确的 `BURN_PARTITION_ARGUMENT` 逐字符验证）：

```
bootloader 4M@0  →  reserved 64M@36M  →  cache（提到最前，从 108M 起）→  env
→  其余按 DTB 里的顺序，每个分区之间留 8 MiB 间隔
```

本仓库的 `meson1.dtb` 据此得到 `boot@1104M`、`data@2176M`。换一份厂商 `meson1.dtb`
（分区集合不同）算出来的偏移就不一样，`blkdevparts=` 和 MBR 都要跟着改。

### 5. 「擦除 flash」必须勾

厂商 `preboot` 的顺序是 `init_display → upgrade_check → storeargs → switch_bootmode`，
而 `upgrade_check` 在 `upgrade_step == 3` 时直接 `run update`，`update` 第一件事是
`update 1000` 等 USB 烧录工具 —— 于是每次开机「画开机图 → 等 USB」，**永远走不到
`bootcmd`**，表现为静止在开机图。

`upgrade_step` 存在 `rsv` 里的 U-Boot 环境中，只有勾「擦除 flash」才会被清掉。
完整的 81 个环境变量快照在 `config/stock-environment.json`。

## 已证伪的变体

两个变体的构建与校验脚本仍在仓库里，作为「这条路走不通」的可复现证据保留。
**不要基于它们开发新功能。**

| 变体 | 策略 | 脚本 | 结果 |
|---|---|---|---|
| A | 原厂签名段 + 主线 U-Boot v2026.01 BL33 + FAT16/extlinux | `build-burn-image.sh` | 实机全黑，根因 1 |
| B | 原厂签名段 + ophub BL33 + rootfs 内 `/boot` | `build-ophub-bl33-burn.sh` | 实机全黑，根因 1 |
| C | 厂商 bootloader 逐字节不改 + Android boot 镜像 | `build-vendor-boot-burn.sh` | **实机可启动** |

那段全黑期的开发分支没有合进 `main`，也不占 tag / 分支列表，存在远端的 `refs/archive/*`
下面（`git push --tags` 碰不到它们）。要翻当时的实现：

```bash
git fetch origin 'refs/archive/*:refs/archive/*'
git log --oneline main..refs/archive/codex-fix-b860-emmc-50mhz      # 改用 R3300L 参考启动链
git log --oneline main..refs/archive/codex-restore-stock-bl33       # 原厂内核诊断包
git log --oneline main..refs/archive/feat-diagnostic-hdmi-console   # HDMI 诊断 / SD 卡启动
```

结论本身都在这一页和 [`known-issues.md`](known-issues.md) 里，翻分支只在要复现测量时才需要。

## 构建与校验

```bash
# 一次性：按 config 里钉死的 commit 编出 ampack / gxlimg 并加进 PATH
eval "$(scripts/setup-image-tools.sh)"

# 1. 从公开 Armbian raw 镜像做出两个载荷（需要 Linux + loop 分区支持）
scripts/build-burn-payloads.sh <Armbian_*.img.gz> payloads

# 2. 套上原厂 bootloader 打包
scripts/build-vendor-boot-burn.sh payloads out

# 3. 独立校验交付件
scripts/validate-vendor-boot-burn.sh out/burn.img out/vendor-boot-contract.json
```

每周的 [`weekly-burn-build.yml`](../.github/workflows/weekly-burn-build.yml) 跑的就是
这三步，发布 `burn.img` / `burn.img.xz` / `vendor-boot-contract.json` /
`burn-dtb-contract.json`。变体 A/B 的脚本不在发布路径里，有测试断言守着。
输入是钉死的：`detect` 只核对 `SOURCE_RELEASE` / `SOURCE_ASSET` / `SOURCE_DIGEST`，
上游换了东西就红，不会自己跟到新的 raw release（[`frozen-inputs.md`](frozen-inputs.md)）。
`build-burn-payloads.sh` 里还会在 rootfs 上跑
[`apply-rootfs-defaults.sh`](../scripts/apply-rootfs-defaults.sh) 做预置，并在 `dd` 之后用
`debugfs` 复查 drop-in 真的在要写进 eMMC 的那份 ext4 里。

构建过程中强制断言的不变量：

1. `bootloader.PARTITION` 与 `board-inputs/` 逐字节相同
2. bootloader sector 0 的 440..511 全零（没有被 MBR 污染）
3. BL2 摘要自洽（`check-bl2-seal`）
4. Android boot 镜像可解析，`second` 是合法 FDT
5. `boot.PARTITION` 不超过 32 MiB 的 Amlogic `boot` 分区

## 刷机步骤

1. Burning Tool 导入 `burn.img`，**勾上「擦除 flash」和「擦除 bootloader」**
2. 男对男 USB 线插靠 LAN 口那个 USB2 口
3. 短接主板 C125 两个焊盘（或用 HDMI 短接头），上电
4. 保持短接到 4% 以后，7% 左右松手
5. 100% 后断电、拔 USB、接 HDMI 上电

参考：[hicairo post 69](https://www.hicairo.com/post/69.html)，本项目的原厂输入即来自该教程
指名的 `20191218-R3300L-Q7-6.0-root-twrp-Milton` 固件。
