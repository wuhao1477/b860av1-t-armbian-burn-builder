# B860AV1.1-T Armbian Builder

[![CI](https://github.com/wuhao1477/b860av1-t-armbian-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/wuhao1477/b860av1-t-armbian-builder/actions/workflows/ci.yml)
[![Weekly build](https://github.com/wuhao1477/b860av1-t-armbian-builder/actions/workflows/weekly-build.yml/badge.svg)](https://github.com/wuhao1477/b860av1-t-armbian-builder/actions/workflows/weekly-build.yml)

面向中兴 `ZXV10 B860AV1.1-T` 的源输入固定、可追溯 Debian stable / Armbian 构建项目。所有大文件下载、镜像重构和 Linux 文件系统检查都在 GitHub Actions 中执行。

## 当前状态

`container-valid / hardware-unverified`

公开资料表明该型号存在硬件批次差异。当前仓库绑定的原厂 BL33 明确选择 `gxl_p211_1g`，Linux 侧采用 P212 DTB、1 GB 内存和 `u-boot-s905x-s912`；该结论只适用于与仓库原厂输入摘要一致的 B860AV1.1-T 批次。

当前 DTB 是从公开 P212 修复源码构建的候选配置；虽然构建会验证 RTL8189FTV、SDIO 200 MHz、reset GPIO 与 64 MiB CMA 等关键属性，但上游根节点 model 仍是通用 P212，不能据此宣称已完成 B860AV1.1-T 实机适配。

该组合尚未取得 B860AV1.1-T 完整串口启动记录。因此 Release 是候选镜像，不是已经确认可启动的正式固件。

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

公开构建同时发布 Armbian raw `.img.gz` 和 USB Burning Tool 候选 `burn.img.xz`。直刷包状态固定为 `format-valid / hardware-unverified`：容器结构和 Linux 设备树通过自动校验，但尚无该设备的串口启动证据。设备证据流程仍只针对 raw 镜像，不会把实机证明写成构建成功。

## 自动构建

- 每周一 UTC 03:23 检查一次，相邻计划时间为 7 天。
- 检测 job 从固定的 Debian 官方 HTTPS 地址下载 `stable/InRelease`，使用 Ubuntu 提供的 `debian-archive-keyring` 验签，并校验 Debian 标签、`arm64` 架构和 `main` 组件后才解析版本。
- Debian stable 代号与 `arm64` 架构用于匹配基础镜像；完整 point version 用于版本追踪、构建指纹和 Release 标签。
- stable 迁移时自动选择新版本；检测会拒绝 point version、发布日期或 major version 回退，同一 major 也不允许更换代号。
- 下载、签名、元数据或匹配镜像任一检查失败时立即停止，不进入镜像构建。
- 每次检测先审计全部公开的非草稿 `armbian-*` Release；每一份都必须是 schema 5/8 的 prerelease、源码构建 U-Boot/DTB、通过 QEMU 系统启动烟测、无 Android 扫描结果的 B860 Armbian 镜像。任一历史或不完整 Release 存在时，检测直接失败，不会继续构建。
- schema 7 的旧公开 Release 不再满足当前发布门禁；升级后必须先删除旧 Release 和同名 tag，再运行首次 schema 8 构建。
- 检查范围包括所有匹配 Debian stable 的公开 Armbian Release，并按 Armbian 与基础镜像内核版本全局选择最高资产；同时跟踪最新 `5.10.y` 内核、ophub 构建器提交、upstream U-Boot 源码提交和本仓库构建配方哈希。
- 检测拒绝 Armbian、目标内核或 Debian stable 版本回退，即使手动设置 `force=true` 也不能绕过。
- 构建配方还固定 upstream U-Boot v2020.07 的 commit、Armbian GPL 补丁 SHA-256、`libretech-cc_defconfig` 和 `aarch64-linux-gnu-` 交叉编译设置；不会把第三方预编译 U-Boot 作为最终 overload。
- 只有统一指纹变化时才进入镜像构建；没有变化时只运行轻量检测 job。
- 构建失败不会记录为成功，下周会再次尝试同一组输入。
- 成功后创建 prerelease，并附带 `resolved-sources.json`、`validation-report.json`、`boot-components.json`、`uboot-build.json`、`source-built-dtb.json`、`device-tree-source.dts`、`qemu-system-smoke.json`、`qemu-system-smoke.log`、`rtl8189fs-driver.json`、`hardware-capabilities.json`、应用补丁后的完整 `u-boot-source.tar.gz`、[`THIRD_PARTY_SOURCES.md`](THIRD_PARTY_SOURCES.md)、`filesystem-manifest.sha256` 和 `SHA256SUMS`。
- Tag 格式为 `armbian-<版本>-debian-<Debian完整版本>-<代号>-k<内核>-build-<运行号>.<重试号>`；同一版本可以重复构建且不会覆盖历史记录。
- 每约 42 天只更新一次 `.github/schedule-heartbeat`，避免 GitHub 因 60 天无仓库活动而停用 schedule；该文件不进入构建指纹，单独变更时也不会触发 CI 编译或镜像构建。

手动启动：打开 [Weekly build](https://github.com/wuhao1477/b860av1-t-armbian-builder/actions/workflows/weekly-build.yml)，选择 **Run workflow**，把 `force` 设为 `true`。

## burn.img 直刷候选

Amlogic USB Burning Tool 的 `burn.img` 不只是 Linux 磁盘镜像。它还必须携带与具体主板 DDR、电源和安全配置匹配的 BL2/BL30/BL301、USB U-Boot 与持久 bootloader。

当前直刷工作流保留仓库中已确认与 B860 输入包匹配的 `DDR.USB`、`UBOOT.USB`、`aml_sdc_burn.UBOOT`、`aml_sdc_burn.ini`、`platform.conf` 和原厂 `meson1.dtb`。持久 `bootloader.PARTITION` 保留原厂签名的 BL2/BL30/BL301/BL31，只把 Android BL33 替换为固定提交构建的 U-Boot v2026.01 R3300-L BL33；U-Boot 与 Linux DTB 的 eMMC 时钟都限制为 50 MHz。

最终包只写入四个分区载荷：512 字节 DOS MBR `1.PARTITION`、主线 BL33 FIP、32 MiB FAT16 `boot.PARTITION` 和 sparse ext4 `data.PARTITION`。FAT16 分区只包含 `Image.gz`、raw `initrd.img`、B860 P212 DTB 和 `extlinux/extlinux.conf`，不包含 Android boot v0、原厂环境或 autoscript。

`1.PARTITION` 把 FAT16 映射到 eMMC 1104 MiB、把 rootfs 映射到 2176 MiB；extlinux 的 root UUID 必须与 `data.PARTITION` 完全一致。包不生成 `env.PARTITION` 或 `system.PARTITION`。启动路径为原厂签名 BL2/BL30/BL301/BL31 -> 主线 BL33 `distro_bootcmd` -> eMMC `mmc1` FAT16/extlinux -> Armbian kernel/initrd -> Debian rootfs。

每周直刷工作流只在最新公开 Armbian 输入或直刷配方变化时运行，生成 `burn.img`、`burn.img.xz`、`SHA256SUMS`、`emmc-boot-contract.json`、`mainline-fip-contract.json`、`rootfs-contract.json` 和 schema 4 `burn-report.json`。独立步骤会重新解包 Amlogic v2 容器，解密 BL33，并重算 FAT16/extlinux、FIP 组件、root UUID 和 8 GB eMMC 容量证据。下载时优先使用 `burn.img.xz`，解压后导入 Amlogic USB Burning Tool。

raw Armbian 镜像仍主动排除 ophub 的持久 bootloader、旧版 `u-boot.sd` 和 `u-boot.usb`，并验证 MBR 后至 4 MiB 分区起点之间没有启动链。FAT 分区只保留由固定 U-Boot 源码和补丁构建的 `u-boot-s905x-s912.bin`，以及同一字节的 `u-boot.ext`，供外部介质候选使用；它与直刷包是两条不同的启动路径。

raw 镜像仍从 `config/aml-autoscript.cmd` 生成外部介质安装脚本。直刷包则写入重打包 FIP、MBR、FAT16 boot 和 Debian/Armbian rootfs；原厂签名阶段继续负责 DDR 和安全初始化，主线 BL33 负责进入 extlinux。

## 静态验证

云端构建会检查：

- 基础镜像和内核包 SHA-256 与 GitHub Release digest 一致，Git 仓库固定到精确 commit；
- gzip、已清零的 MBR bootstrap、真实首分区起点、FAT boot 与 ext4 rootfs 结构正确；
- rootfs 的 Debian major version 和代号与已验签的 stable 元数据一致，同时标识为 Armbian 并存在正常的 `/sbin/init`；
- boot 分区包含 kernel、initrd、目标 DTB 和 source-built `u-boot-s905x-s912.bin`/`u-boot.ext` overload，活动配置实际引用 kernel、initrd 与 DTB，并在启动参数中固定保守的 `mem=1024M`（对应 `memoryLimitMiB: 1024`）；
- 直刷包验证原厂 USB factory 文件摘要、512 字节 MBR、32 MiB FAT16、extlinux 文件集、vendor FIP 阶段、主线 BL33 的 `distro_bootcmd`/`mmc1`、root UUID 和 sparse rootfs 容量，并拒绝 Android boot v0、`env.PARTITION` 与 `system.PARTITION`；这些检查仍不能替代目标盒子的串口启动证据；
- boot 分区拒绝旧版 `u-boot.sd`/`u-boot.usb` 以及未列入允许范围的 bootloader 二进制；
- kernel 是 ARM64，DTB 必须包含精确的 `amlogic,p212` compatible 项；仅有其他 GXL/S905X compatible 的重命名 DTB 不能通过；
- rootfs 必须包含与目标 `5.10.y-ophub` 内核 vermagic 一致的 ARM64 `8189fs.ko`，模块自身和 `modules.alias` 必须把 RTL8189FTV 的 SDIO ID `024c:F179` 映射到 `8189fs`，`modules.dep` 必须记录 `cfg80211` 与 `rfkill` 依赖；证据写入 `rtl8189fs-driver.json`；
- `config/hardware-capabilities.json` 声明的板级门禁会读取镜像内生成的 `include/config/auto.conf`，并用 `fdtget` 检查活动 DTB：eMMC（8-bit、200 MHz、HS200）、RMII 以太网、HDMI Type-A、红外 pinctrl、USB host/PHY，以及 RTL8189FTV 的 SDIO/reset 属性；所有六类结果、内核配置摘要和 DTB 摘要写入 `hardware-capabilities.json`，分别绑定 `filesystem-manifest.sha256`、`boot-components.json` 和 `rtl8189fs-driver.json`；
- QEMU user-mode 可以执行 rootfs 中的 shell、`dpkg-query` 包状态和 systemd 版本检查；
- QEMU system-mode 使用镜像内同一 ARM64 kernel、initramfs 和 ext4 rootfs 启动到 `/bin/sh`，确认 Debian/Armbian 身份和真实根挂载；结果与控制台日志分别写入 `qemu-system-smoke.json` 和 `qemu-system-smoke.log`；
- SSH unit 与 `sshd` 存在，rootfs 标签正确，镜像不超过十进制 8 GB 容量减 128 MiB 安全余量，即 `7,865,782,272` 字节；
- 生成 schema 8 验证报告，分别记录 rootfs、boot、initrd、bootConfig、DTB 五个范围的 Android 扫描结果，并单独记录两个 autoscript、source-built U-Boot、独立重建 repair DTB、硬件能力和 QEMU 系统启动烟测摘要；源码归档解包后的规范化目录树摘要必须与构建摘要一致；扫描拒绝已知 Android 路径、目录和符号链接、APK/APEX/DEX、Android boot/sparse/AVB magic、Android 可执行文件名及分区标记；这不是对 U-Boot overload 二进制内部字符串的绝对保证；
- `boot-components.json` 记录 kernel、initrd、DTB、U-Boot overload、`s905_autoscript` 和 `aml_autoscript` 的大小与 SHA-256；`filesystem-manifest.sha256` 记录 rootfs 文件清单；
- 原始镜像先由构建 job 生成，再由独立 runner 使用仓库内可信 validator 重验，校验和与验证报告必须绑定同一个镜像文件；
- 发布前先把本地上传文件的大小和 SHA-256 与 GitHub draft 的服务器资产逐项比对，任何不一致都会保留 draft；
- 发布清单记录所选上游源、板级配置和构建配方哈希。

这些检查只能证明 Wi-Fi 驱动已正确打包并具备自动匹配元数据，不能替代 DDR 初始化、eMMC 枚举、HDMI、以太网、Wi-Fi 连接和完整启动过程的实机测试。

Ubuntu runner 镜像和 apt 包版本未逐项固定，因此本项目不承诺跨时间 bit-for-bit 可复现。U-Boot overload 来自 [U-Boot v2020.07](https://github.com/u-boot/u-boot/tree/v2020.07) 与仓库内记录的 [Armbian 补丁](patches/u-boot/u-boot-s905x-s912.patch)，每次构建和独立验证都会重新编译并比较字节摘要。当前 schema 5 不再克隆 `ophub/u-boot` 或 `ophub/firmware` 二进制仓库；Linux firmware 继承自已校验的 Armbian 基础镜像。第三方源码获取方式和无法证明的上游内核映射明确记录在 [`THIRD_PARTY_SOURCES.md`](THIRD_PARTY_SOURCES.md)。该源码链仍不包含 B860 专用 DDR、BL30/BL301 或 Amlogic USB factory-burn 组件。

## 上游

- [ophub/amlogic-s9xxx-armbian](https://github.com/ophub/amlogic-s9xxx-armbian)
- [ophub/kernel](https://github.com/ophub/kernel)
- [U-Boot Amlogic SPL documentation](https://github.com/u-boot/u-boot/blob/v2026.07/doc/board/amlogic/spl.rst)
- [TF-A Meson GXL documentation](https://github.com/ARM-software/arm-trusted-firmware/blob/master/docs/plat/meson-gxl.rst)

## License

本仓库自有代码使用 [MIT License](LICENSE)。上游项目及构建产物继续适用各自许可证；MIT License 不覆盖调用者提供的厂商固件。
