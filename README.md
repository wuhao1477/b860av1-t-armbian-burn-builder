# B860AV1.1-T Armbian Builder

[![CI](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/actions/workflows/ci.yml)
[![Weekly burn image](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/actions/workflows/weekly-burn-build.yml/badge.svg)](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/actions/workflows/weekly-burn-build.yml)
[![Weekly build](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/actions/workflows/weekly-build.yml/badge.svg)](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/actions/workflows/weekly-build.yml)

面向中兴 `ZXV10 B860AV1.1-T` 的源输入固定、可追溯 Debian stable / Armbian 构建项目。所有大文件下载、镜像重构和 Linux 文件系统检查都在 GitHub Actions 中执行。

## 当前状态

**已冻结在 v1.1.0。** 上游输入（raw release、资产摘要、内核版本）全部钉死在实机验证过
的那一组，构建不再自己跟到新版本 —— 上游换了东西 CI 会红，而不是悄悄出一个没上过机的
包。冻结集合和重钉步骤见 [`docs/frozen-inputs.md`](docs/frozen-inputs.md)。

| 产物 | 状态 | 说明 |
|---|---|---|
| **`burn.img` 直刷包（变体 C）** | **`hardware-verified`** | 2026-09-03 实机刷入、进系统、六项预置全过、eMMC DDR52 82 MB/s；2026-09-04 换一次刷入复验；2026-09-05 `v1.1.0`（= `build-50.1`）再刷一次，七项预置全过（多了 H.264 硬解），见 [`docs/burn-image.md`](docs/burn-image.md) |
| Armbian raw `.img.gz` | `container-valid / hardware-unverified` | 只做过容器与文件系统静态校验 |

直接下载：[**`v1.1.0` 的 `burn.img.xz`**](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/releases/latest)
（解压后 `burn.img` sha256 `188d8ff6…`，七项预置全部实机验证通过：
`root` / `password` 直接 SSH、zsh、根分区 5.1G、zram 400 MB、无首登向导、不等网络、H.264 硬解）。
刷之前先看 [`docs/burn-image.md#刷机步骤`](docs/burn-image.md)——**「擦除 flash」必须勾**。

**要刷机只下 `latest`（现在是 `v1.1.0`）。** 其余 release 一律是 `Pre-release`，都不是
拿来刷的：

| tag | 是什么 | 能刷吗 |
|---|---|---|
| `v1.1.0`（`latest`） | 直刷包，含 H.264 硬解微码，**这份字节流本身实机验证过** | **能** |
| `v1.0.0` | 上一版直刷包，没有微码所以没有硬解，同样实机验证过 | 能 |
| `b860-burn-*-build-N.M` | 每周自动出的直刷包，策略一致，但那些字节没上过机（`build-50.1` 除外，它就是 `v1.1.0`） | 自担风险 |
| `armbian-*-build-N.M` | raw `.img.gz` 线的每周产物，只做过容器与文件系统静态校验 | 不能直刷 |
| `input-armbian-*` | 冻结的上游输入镜像，是构建的原料不是产物 | 否 |

之前那批预置不完整的 `b860-burn-*`（`build-43.1` … `build-49.1`）已全部删除，避免有人
下错来刷；`v1.0.0` 是 `build-49.1` 那份实机验证过的字节，`v1.1.0` 是 `build-50.1` 那份，
各自同一个 sha256。各项预置是
怎么一步步补齐的，记在 [`docs/known-issues.md`](docs/known-issues.md) 第 7 条。

**刷完直接能用，没有首次开机向导。** 镜像里由
[`scripts/apply-rootfs-defaults.sh`](scripts/apply-rootfs-defaults.sh) 预置好：

| 预置项 | 值 |
|---|---|
| 登录 | `root` / `password`，SSH 直接进，不问 shell / 用户名 / 时区 |
| 口令 | `/etc/shadow` 里钉死的 `$6$` 哈希（`openssl passwd -6 -salt b860burn password`）；删了首登向导就没人再设口令，不钉死等于发一个口令未知的包 |
| shell | zsh 5.9 + oh-my-zsh（改 `root_shell` 一行可换 bash） |
| 根分区 | 首次开机 `resize2fs` 自己撑满 `data` 分区（8 GB eMMC 上 2.9G → 5.1G，实机确认） |
| swap | zram 400 MB（`armbian-zram-config`，靠 `sysinit.target.d` drop-in 起来） |
| 开机 | 禁用 `NetworkManager-wait-online`，实机 24.3 s 进系统（首刷含 resize 30.6 s） |
| 硬解 | `meson-vdec` 微码装在 `/lib/firmware/meson/vdec/`，H.264 实机解通（上游镜像里这个目录整个不存在，缺了 `VIDIOC_STREAMON` 直接 `-EINVAL`，见 [`docs/known-issues.md`](docs/known-issues.md) 第 10 条）。**`v1.1.0` 起才有，`v1.0.0` 里没有** |
| 硬编 | 树外模块 `meson_hcodec.ko` 装在 `/lib/modules/<release>/extra/`，`stage=1 selftest=0` 开机自动加载，出来一个 V4L2 编码器节点（`ffmpeg -c:v h264_v4l2m2m` / `gst v4l2h264enc` 零补丁能用）。mainline 5.10 只有解码，编码这块硬件在上游内核里根本没有驱动，见 [`docs/hcodec-encoder-plan.md`](docs/hcodec-encoder-plan.md)。**下一个 tag 起才有** |

swap 为什么一开始没起来（构建时写进 rootfs 的 `*.wants` 符号链接一条都没进镜像，同一
毫秒写的常规文件全在），见 [`docs/known-issues.md`](docs/known-issues.md) 第 7、8 条。
换成 drop-in 的那条路已经在实机上验证过三次：`sysinit.target.wants/` 里的链接照旧
不见，冷重启后 `swapon --show` 仍是 `/dev/zram0 400.3M`。

WiFi 密码不进仓库（CI 产物是公开的）。要预置就在本地放 `board-inputs/wifi.env`
写两行 `WIFI_SSID=` / `WIFI_PSK=` 再自己构建；细节见
[`docs/known-issues.md`](docs/known-issues.md) 第 7 条。

变体 C 实机跑到的系统：

```
Armbian OS 26.11.0 trixie / Debian GNU/Linux 13
Linux 5.10.268-ophub aarch64        BOARD="B860av1-T"
wlan0  RTL8189FTV (8189fs) 2.4G 20 Mbps   eth0 100Mbps/Full DHCP 正常
HDMI   card0-HDMI-A-1 connected     eMMC DDR52 82 MB/s (/dev/mmcblk2p14 ext4)
```

尚未解决的问题（`/boot` 为空、蓝牙初始化超时、5.10 内核线 2026-12-31 EOL 等）列在 [`docs/known-issues.md`](docs/known-issues.md)。

## 从哪读起

| 文件 | 内容 |
|---|---|
| [`docs/burn-image.md`](docs/burn-image.md) | **直刷包的设计、三次实机全黑的根因、刷机步骤** |
| [`docs/frozen-inputs.md`](docs/frozen-inputs.md) | **冻结了哪些输入、怎么重钉、内核线为什么停在 5.10** |
| [`docs/known-issues.md`](docs/known-issues.md) | 待解决问题，每条带证据和修它要动什么 |
| [`docs/hardware-probes.md`](docs/hardware-probes.md) | **实机 `/dev/mem` 探测结论：HCODEC 硬编块是活的，附会让板子重启的坑** |
| [`docs/hcodec-encoder-plan.md`](docs/hcodec-encoder-plan.md) | 硬件编码驱动的三阶段实施规划 |
| [`docs/device-validation.md`](docs/device-validation.md) | raw 镜像那条线的实机证据采集流程 |
| [`docs/history/`](docs/history/) | 早期设计文档，已被取代，只作溯源 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 本地怎么跑、提 PR 的要求、迭代入口 |

```
scripts/build-burn-payloads.sh         从 raw 镜像做 boot/data 载荷 + rootfs 预置
scripts/apply-rootfs-defaults.sh       开箱即用项（口令、shell、zram、resize2fs、vdec 微码）
scripts/fetch-vdec-firmware.sh         按 board.json 钉死的 commit + sha256 下 vdec 微码
scripts/build-vendor-boot-burn.sh      变体 C 构建器（唯一实机验证过的）
scripts/validate-vendor-boot-burn.sh   独立复核交付件
scripts/setup-image-tools.sh           按 config 钉死的 commit 编 ampack / gxlimg
scripts/burn-image.mjs                 Android boot 打包、BL2 摘要、sparse ext4 等原语
board-inputs/                          原厂固件片段，构建的必要输入
config/burn-inputs.json                原厂输入的 sha256 白名单
config/stock-environment.json          厂商 U-Boot 的 81 个环境变量快照
```

公开资料表明该型号存在硬件批次差异。当前仓库绑定的原厂 BL33 明确选择 `gxl_p211_1g`，Linux 侧采用 P212 DTB、1 GB 内存；该结论只适用于与仓库原厂输入摘要一致的 B860AV1.1-T 批次。

raw 镜像那条线的 DTB 是从公开 P212 修复源码构建的候选配置；虽然构建会验证 RTL8189FTV、SDIO 200 MHz、reset GPIO 与 64 MiB CMA 等关键属性，但上游根节点 model 仍是通用 P212，且没有该组合的完整启动记录，因此 raw Release 是候选镜像，不是已确认可启动的正式固件。

## 实机证据

新构建会在 rootfs 写入 `/usr/lib/b860av1-t/image-identity.json`，将板型、manifest fingerprint、内核版本和实际 kernel release 绑定到 `filesystem-manifest.sha256`。包含该文件的下一次成功 Release 才能提交实机证据；既有 Release 不追溯补写。

[`scripts/collect-device-evidence.sh`](scripts/collect-device-evidence.sh) 只读检查 eMMC、Ethernet、HDMI、红外、USB 和 RTL8189FTV Wi-Fi，并生成脱敏串口日志与 JSON。采集器不写块设备、不修改启动配置，也不安装软件。提交目录格式和命令见 [`docs/device-validation.md`](docs/device-validation.md)。

证据 PR 只执行 `contents: read` 验证。维护者复验并发布时使用：

```bash
gh workflow run verify-device.yml \
  -f release_tag='<release-tag>' \
  -f evidence_path='evidence/<release-tag>/<evidence-id>' \
  -f confirmation=verify
```

通过后只为该 Release 增加 `operator-attested / one-device` 资产；原始 `validation-report.json` 继续保持 `container-valid / hardware-unverified`。这是单台设备的操作者证据，不是远程密码学硬件证明，也不代表所有硬件批次已经适配。

本仓库发布两类包：USB Burning Tool 的 `burn.img.xz`（`b860-burn-*`）和 raw `.img.gz`（`armbian-*`，直刷包的输入源）。直刷包随附 `vendor-boot-contract.json`（Android boot 头部、cmdline、root UUID）和 `burn-dtb-contract.json`（`meson1.dtb` 的 7 个 sub-DTB 槽位与替换结果），再加一份 `SHA256SUMS`。CI 里的自动校验只能证明容器结构和设备树自洽；变体 C 的可启动结论来自机主实机刷入，不是构建成功推出来的。设备证据流程仍只针对 raw 镜像。

## 自动构建

**一个仓库，两条线。** 早期 raw 那条线在另一个仓库，那个仓库其实是本仓库的子集
（119 个文件里 94 个逐字节相同），两边还在跑同一条 cron 出同一份 raw 包。已经合并进
本仓库，原仓库转为私有，不再产出任何东西。构建、发布、实机证据全部只依赖本仓库。

| 线 | 产出 | workflow |
|---|---|---|
| 直刷包 | `b860-burn-*` release（`burn.img.xz`） | [`weekly-burn-build.yml`](.github/workflows/weekly-burn-build.yml) |
| raw 镜像 | `armbian-*` prerelease（直刷包的输入源） | [`weekly-build.yml`](.github/workflows/weekly-build.yml) |

直刷包的输入自托管：那份实机验证过的 raw 资产逐字节镜像在本仓库的
[`input-armbian-…-build-46.1`](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/releases/tag/input-armbian-26.11.0-debian-13.6-trixie-k5.10.268-build-46.1)
里，`SOURCE_DIGEST` 与合并前完全一致。

**直刷包的输入是冻结的。** `weekly-burn-build.yml` 顶部钉死 `SOURCE_REPOSITORY` /
`SOURCE_RELEASE` / `SOURCE_ASSET` / `SOURCE_DIGEST`，`detect` 只核对不选新；
`config/sources.json` 把内核钉在 `5.10.268` 并校验摘要。输入变了 CI 会红，不会自己出新包 ——
重钉步骤见 [`docs/frozen-inputs.md`](docs/frozen-inputs.md)。raw 那条线每周照常跑，
但它产出的新 `armbian-*` 包不会自动成为直刷包的输入。

下面出现两个独立编号的 schema，不要混淆：

| schema | 描述的文件 | 当前版本 | 权威定义 |
|---|---|---|---|
| 来源清单 | `resolved-sources.json` | 5 | [`config/sources.json`](config/sources.json) |
| 验证报告 | `validation-report.json` | 8 | `CURRENT_VALIDATION_SCHEMA`，[`src/change-detection.mjs`](src/change-detection.mjs) |

门禁规则：来源清单 schema ≥ 5 时，验证报告 schema 必须正好等于 8。

以下描述 raw 那条线（`weekly-build.yml`）的检测与发布规则：

- 每周一 UTC 03:23 检查一次，相邻计划时间为 7 天。
- 检测 job 从固定的 Debian 官方 HTTPS 地址下载 `stable/InRelease`，使用 Ubuntu 提供的 `debian-archive-keyring` 验签，并校验 Debian 标签、`arm64` 架构和 `main` 组件后才解析版本。
- Debian stable 代号与 `arm64` 架构用于匹配基础镜像；完整 point version 用于版本追踪、构建指纹和 Release 标签。
- stable 迁移时自动选择新版本；检测会拒绝 point version、发布日期或 major version 回退，同一 major 也不允许更换代号。
- 下载、签名、元数据或匹配镜像任一检查失败时立即停止，不进入镜像构建。
- 每次检测先审计全部公开的非草稿 `armbian-*` Release；每一份都必须是**来源清单 schema 5 + 验证报告 schema 8** 的 prerelease、源码构建 U-Boot/DTB、通过 QEMU 系统启动烟测、无 Android 扫描结果的 B860 Armbian 镜像。任一历史或不完整 Release 存在时，检测直接失败，不会继续构建。
- **验证报告 schema 7** 的旧公开 Release 不再满足当前发布门禁；升级后必须先删除旧 Release 和同名 tag，再运行首次产出 schema 8 验证报告的构建。
- 检查范围包括所有匹配 Debian stable 的公开 Armbian Release，并按 Armbian 与基础镜像内核版本全局选择最高资产；**内核不在此列 —— 它钉死在 `5.10.268` 并逐字节校验摘要**，跟踪的其余输入是 ophub 构建器提交、upstream U-Boot 源码提交和本仓库构建配方哈希。
- 检测拒绝 Armbian 或 Debian stable 版本回退，即使手动设置 `force=true` 也不能绕过；目标内核既不升也不降，换它必须显式改 `config/sources.json`。
- 构建配方还固定 upstream U-Boot v2020.07 的 commit、Armbian GPL 补丁 SHA-256、`libretech-cc_defconfig` 和 `aarch64-linux-gnu-` 交叉编译设置；不会把第三方预编译 U-Boot 作为最终 overload。
- 只有统一指纹变化时才进入镜像构建；没有变化时只运行轻量检测 job。
- 构建失败不会记录为成功，下周会再次尝试同一组输入。
- 成功后创建 prerelease，并附带 `resolved-sources.json`、`validation-report.json`、`boot-components.json`、`uboot-build.json`、`source-built-dtb.json`、`device-tree-source.dts`、`qemu-system-smoke.json`、`qemu-system-smoke.log`、`rtl8189fs-driver.json`、`hardware-capabilities.json`、应用补丁后的完整 `u-boot-source.tar.gz`、[`THIRD_PARTY_SOURCES.md`](THIRD_PARTY_SOURCES.md)、`filesystem-manifest.sha256` 和 `SHA256SUMS`。
- Tag 格式为 `armbian-<版本>-debian-<Debian完整版本>-<代号>-k<内核>-build-<运行号>.<重试号>`；同一版本可以重复构建且不会覆盖历史记录。
- 每约 42 天只更新一次 `.github/schedule-heartbeat`，避免 GitHub 因 60 天无仓库活动而停用 schedule；该文件不进入构建指纹，单独变更时也不会触发 CI 编译或镜像构建。

手动启动直刷包构建：打开 [Weekly burn image](https://github.com/wuhao1477/b860av1-t-armbian-burn-builder/actions/workflows/weekly-burn-build.yml)，
选择 **Run workflow**，把 `force` 设为 `true`。必须在默认分支上跑 —— `detect` 带
`if: github.ref_name == default_branch`，feature 分支只会跑诊断 job，产不出包。
raw 那条线是同一个仓库里的 [`weekly-build.yml`](.github/workflows/weekly-build.yml)。

## burn.img 直刷包

完整设计、踩坑记录和刷机步骤在 [`docs/burn-image.md`](docs/burn-image.md)。这里只讲结论。

Amlogic USB Burning Tool 的 `burn.img` 不只是磁盘镜像，它还必须携带与主板 DDR、电源和安全配置匹配的 BL2/BL30/BL301、USB U-Boot 与持久 bootloader。

**能用的是变体 C：`scripts/build-vendor-boot-burn.sh`**，策略标识 `vendor-fip-vendor-bl33-android-boot`。核心原则是**厂商 bootloader 一个字节都不改** —— 不重打包 FIP、不嵌 MBR、BL33 仍是厂商 `U-Boot 2015.01 gxl_p211_1g`。Armbian 装进 `ANDROID!` v0 boot 镜像，走厂商自己的 `storeboot` → `imgread kernel boot` → `bootm` 进来；根文件系统靠内核 cmdline 的 `blkdevparts=` 定位，不依赖 MBR。

```
bootrom → 原厂签名 BL2/BL30/BL301/BL31 → 厂商 BL33 → storeboot
        → boot.PARTITION（Armbian kernel + initrd + DTB）→ Debian rootfs
```

包内 5 个载荷：`bootloader.PARTITION`（原厂原样）、`boot.PARTITION`、`data.PARTITION`（sparse ext4）、`logo.PARTITION`（原厂开机图，**没有串口时唯一能判断 bootloader 是否跑起来的信号**）、`meson1.dtb`。不产 `1.PARTITION` / `env.PARTITION` / `system.PARTITION`。

```bash
scripts/build-vendor-boot-burn.sh <source-package-dir> <output-dir>
scripts/validate-vendor-boot-burn.sh <output-dir>/burn.img
```

刷入时 **Burning Tool 里「擦除 flash」必须勾** —— 否则 `rsv` 里残留的 `upgrade_step=3` 会让厂商 U-Boot 每次开机都跳去等 USB 烧录，永远走不到 `bootcmd`，表现为静止在开机图。

### 已证伪的变体 A / B

两者都是「保留原厂签名段、只把 BL33 换成主线/ophub U-Boot」，实机三次全黑。根因不是 BL33 选谁，而是 **gxlimg 还原不出原厂的 AMLC 编码**：拿实机可启动的 Milton 包往返测试，`bl33.enc` 549,888 字节里 547,330 字节不同；用未改动的原厂组件重建 FIP 得到 779,264 字节（原厂 786,432），从 `0xC020` 起就对不上。重打包出来的 bootloader，原厂 BL2 拿到的是它不认的 BL33 块。

脚本（`build-burn-image.sh`、`build-ophub-bl33-burn.sh` 及各自的 validator）保留在仓库里作为可复现证据，**不要基于它们开发新功能**。此前按变体 A 发布的 17 个 `b860-burn-*` Release 已全部删除，避免有人下载来刷；`weekly-burn-build.yml` 现在只构建并发布变体 C，`tests/mainline-workflow-contract.test.mjs` 里有断言守着这一点。

## 静态验证

云端构建会检查：

- 基础镜像和内核包 SHA-256 与 GitHub Release digest 一致，Git 仓库固定到精确 commit；
- gzip、已清零的 MBR bootstrap、真实首分区起点、FAT boot 与 ext4 rootfs 结构正确；
- rootfs 的 Debian major version 和代号与已验签的 stable 元数据一致，同时标识为 Armbian 并存在正常的 `/sbin/init`；
- boot 分区包含 kernel、initrd、目标 DTB 和 source-built `u-boot-s905x-s912.bin`/`u-boot.ext` overload，活动配置实际引用 kernel、initrd 与 DTB，并在启动参数中固定保守的 `mem=1024M`（对应 `memoryLimitMiB: 1024`）；
- 直刷包（变体 C）验证原厂 USB factory 文件摘要、`bootloader.PARTITION` 与 `board-inputs/` 逐字节一致、sector 0 的 440..511 全零、BL2 摘要自洽、`ANDROID!` v0 头部可解析且 `second` 是合法 FDT、`boot.PARTITION` 不超过 32 MiB、root UUID 与 sparse rootfs 容量，并拒绝 `env.PARTITION` 与 `system.PARTITION`；这些检查证明包的结构，实机可启动结论来自机主刷入；
- boot 分区拒绝旧版 `u-boot.sd`/`u-boot.usb` 以及未列入允许范围的 bootloader 二进制；
- kernel 是 ARM64，DTB 必须包含精确的 `amlogic,p212` compatible 项；仅有其他 GXL/S905X compatible 的重命名 DTB 不能通过；
- rootfs 必须包含与目标 `5.10.y-ophub` 内核 vermagic 一致的 ARM64 `8189fs.ko`，模块自身和 `modules.alias` 必须把 RTL8189FTV 的 SDIO ID `024c:F179` 映射到 `8189fs`，`modules.dep` 必须记录 `cfg80211` 与 `rfkill` 依赖；证据写入 `rtl8189fs-driver.json`；
- `config/hardware-capabilities.json` 声明的板级门禁会读取镜像内生成的 `include/config/auto.conf`，并用 `fdtget` 检查活动 DTB：eMMC（8-bit、200 MHz、HS200）、RMII 以太网、HDMI Type-A、红外 pinctrl、USB host/PHY，以及 RTL8189FTV 的 SDIO/reset 属性；所有六类结果、内核配置摘要和 DTB 摘要写入 `hardware-capabilities.json`，分别绑定 `filesystem-manifest.sha256`、`boot-components.json` 和 `rtl8189fs-driver.json`；**注意这里的 HS200 检查针对的是 raw 那条线的上游 DTB**——直刷包会在生成 `linux.dtb` 时主动删掉 `mmc-hs200-1_8v`，因为这块板的 HS200 协商必然 `-74` 失败且内核不回退，见 [`docs/known-issues.md`](docs/known-issues.md) 第 1 条；
- QEMU user-mode 可以执行 rootfs 中的 shell、`dpkg-query` 包状态和 systemd 版本检查；
- QEMU system-mode 使用镜像内同一 ARM64 kernel、initramfs 和 ext4 rootfs 启动到 `/bin/sh`，确认 Debian/Armbian 身份和真实根挂载；结果与控制台日志分别写入 `qemu-system-smoke.json` 和 `qemu-system-smoke.log`；
- SSH unit 与 `sshd` 存在，rootfs 标签正确，镜像不超过十进制 8 GB 容量减 128 MiB 安全余量，即 `7,865,782,272` 字节；
- 生成 schema 8 验证报告，分别记录 rootfs、boot、initrd、bootConfig、DTB 五个范围的 Android 扫描结果，并单独记录两个 autoscript、source-built U-Boot、独立重建 repair DTB、硬件能力和 QEMU 系统启动烟测摘要；源码归档解包后的规范化目录树摘要必须与构建摘要一致；扫描拒绝已知 Android 路径、目录和符号链接、APK/APEX/DEX、Android boot/sparse/AVB magic、Android 可执行文件名及分区标记；这不是对 U-Boot overload 二进制内部字符串的绝对保证；
- `boot-components.json` 记录 kernel、initrd、DTB、U-Boot overload、`s905_autoscript` 和 `aml_autoscript` 的大小与 SHA-256；`filesystem-manifest.sha256` 记录 rootfs 文件清单；
- 原始镜像先由构建 job 生成，再由独立 runner 使用仓库内可信 validator 重验，校验和与验证报告必须绑定同一个镜像文件；
- 发布前先把本地上传文件的大小和 SHA-256 与 GitHub draft 的服务器资产逐项比对，任何不一致都会保留 draft；
- 发布清单记录所选上游源、板级配置和构建配方哈希。

这些检查只能证明 Wi-Fi 驱动已正确打包并具备自动匹配元数据，不能替代 DDR 初始化、eMMC 枚举、HDMI、以太网、Wi-Fi 连接和完整启动过程的实机测试。

Ubuntu runner 镜像和 apt 包版本未逐项固定，因此本项目不承诺跨时间 bit-for-bit 可复现。U-Boot overload 来自 [U-Boot v2020.07](https://github.com/u-boot/u-boot/tree/v2020.07) 与仓库内记录的 [Armbian 补丁](patches/u-boot/u-boot-s905x-s912.patch)，每次构建和独立验证都会重新编译并比较字节摘要。当前**来源清单 schema 5** 不再克隆 `ophub/u-boot` 或 `ophub/firmware` 二进制仓库；Linux firmware 继承自已校验的 Armbian 基础镜像。第三方源码获取方式和无法证明的上游内核映射明确记录在 [`THIRD_PARTY_SOURCES.md`](THIRD_PARTY_SOURCES.md)。该源码链仍不包含 B860 专用 DDR、BL30/BL301 或 Amlogic USB factory-burn 组件 —— 直刷包那条线用的就是 `board-inputs/` 里的原厂二进制，不是从源码构建的，清单见 [`THIRD_PARTY_SOURCES.md`](THIRD_PARTY_SOURCES.md)。

## 上游

- [ophub/amlogic-s9xxx-armbian](https://github.com/ophub/amlogic-s9xxx-armbian)
- [ophub/kernel](https://github.com/ophub/kernel)
- [U-Boot Amlogic SPL documentation](https://github.com/u-boot/u-boot/blob/v2026.07/doc/board/amlogic/spl.rst)
- [TF-A Meson GXL documentation](https://github.com/ARM-software/arm-trusted-firmware/blob/master/docs/plat/meson-gxl.rst)

## License

本仓库自有代码使用 [MIT License](LICENSE)。上游项目及构建产物继续适用各自许可证；MIT License 不覆盖调用者提供的厂商固件。
