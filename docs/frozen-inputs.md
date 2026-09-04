# 冻结的上游输入

直刷包的全部上游输入钉死在**实机验证过的那一组**。构建不再自己漂到「最新的
`armbian-*` release」或 `kernel_stable` 里新出的 `5.10.y`：上游换了东西，构建会红，
而不是悄悄出一个没人上过机的包。

这一页是重钉（解冻）的唯一入口。要迭代就从这里开始。

## 冻结集合

| 输入 | 钉死的值 | 钉在哪 |
|---|---|---|
| raw release 所在仓库 | `wuhao1477/b860av1-t-armbian-burn-builder`（就是本仓库） | `SOURCE_REPOSITORY` |
| raw release | `input-armbian-26.11.0-debian-13.6-trixie-k5.10.268-build-46.1` | `SOURCE_RELEASE` |
| raw 资产 | `Armbian_26.11.0_amlogic_b860av1-t_trixie_5.10.268_server_2026.08.31.img.gz` | `SOURCE_ASSET` |
| raw 资产 sha256 | `32f5b8079e6c5ff8642e0703cfc0a8ae4402b1057b46bb3b8ce7181283da6ace`（781,108,291 B） | `SOURCE_DIGEST` |
| 内核 | `5.10.268`，sha256 `d3559323a4812600ab8f2bd0156d2b863c9b1ea3627d59d64890b8498621e49f`（80,862,597 B） | `config/sources.json` 的 `kernel` |
| Armbian / Debian | 26.11.0 / 13.6 trixie | 由上面那份 raw 资产决定 |
| U-Boot 源码 | `u-boot/u-boot` `v2020.07` | `config/sources.json` 的 `ubootSource` |
| ampack / gxlimg | `config/burn-tooling.json` 里的 commit | 一直是钉死的 |
| 原厂固件片段 | `board-inputs/`，白名单在 `config/burn-inputs.json` | 一直是钉死的 |

**输入是自托管的。** 这份 raw 资产早期由另一个仓库的 `armbian-…-build-46.1` 托管；那个
仓库是本仓库的子集，已经合并进来、原仓库转为私有，资产逐字节镜像到本仓库的 `input-*`
release，所以 `SOURCE_DIGEST` 与合并前完全一致。`input-` 这个前缀是刻意的 ——
`weekly-build.yml` 的历史审计按 `armbian-` 前缀筛，`weekly-burn-build.yml` 按
`b860-burn-` 筛，镜像进来的输入不该被任何一条当成自己的产物。

前四个在 [`.github/workflows/weekly-burn-build.yml`](../.github/workflows/weekly-burn-build.yml)
顶部的 `env:` 里，它们决定直刷包。`config/sources.json` 决定的是 raw 镜像那条线
（`weekly-build.yml`，同一个仓库，每周一照常跑）—— 它产出的新 `armbian-*` 包**不会**
自动成为直刷包的输入，要换得走下面的重钉流程。

产出：`burn.img` sha256 `2303d1c58b0061e9a70d6159e27e546c382d06cf792f3680d69f3659b8f02822`，
六项预置全部实机验证通过（见 [`docs/burn-image.md`](burn-image.md)）。

## 冻结是怎么强制的

| 位置 | 上游变了会怎样 |
|---|---|
| `detect` job | tag 不在、资产没了、摘要不对 → 立刻失败，日志指到这一页 |
| `selectPinnedKernel()`（`scripts/resolve-sources.mjs`） | 名字或摘要不符 → `frozen kernel … digest changed` / `is no longer published` |
| `tests/integration-contract.test.mjs` | 四个 pin 与本文档、与内核版本不自洽 → 测试红 |
| `recipe_digest` | `weekly-burn-build.yml` 自己在指纹清单里，所以改 pin 必然触发一次重建 |

`assetPattern` 现在是完整文件名（`^5\.10\.268\.tar\.gz$`）。`selectLatestAsset` 不带
版本提取器时只接受**恰好一个**匹配，所以多出一个候选就是硬报错，不会「挑个最大的」。

## 怎么重钉（跟一份新的 raw release）

raw 线现在和直刷包在同一个仓库，所以新的 raw release 直接就在本仓库的 release 列表里，
不需要再镜像一次 —— `SOURCE_RELEASE` 指向那个 `armbian-*` tag 就行。

1. 挑一份新的 raw release，把 tag / 资产名 / 摘要读出来：

   ```bash
   gh api repos/wuhao1477/b860av1-t-armbian-burn-builder/releases \
     --jq '.[] | select(.draft == false and (.tag_name | startswith("armbian-"))) | {tag: .tag_name,
           asset: (.assets[] | select(.name | test("^Armbian_.*\\.img\\.gz$")) | {name, size, digest})}'
   ```

2. 改 `weekly-burn-build.yml` 顶部的 `SOURCE_RELEASE` / `SOURCE_ASSET` / `SOURCE_DIGEST`
   三行（`SOURCE_DIGEST` 去掉 `sha256:` 前缀）。`SOURCE_REPOSITORY` 不用动。
3. 内核跟着变就同改 `config/sources.json` 的 `kernel.version` / `kernel.assetPattern`
   / `kernel.digest`：

   ```bash
   gh api repos/ophub/kernel/releases/tags/kernel_stable \
     --jq '.assets[] | select(.name | startswith("5.10.")) | {name, size, digest}'
   ```

4. 把这一页的「冻结集合」表和产出摘要一起改掉，否则
   `tests/integration-contract.test.mjs` 会红（这是刻意的：pin 和文档必须同时动）。
5. `pnpm check`，然后在**默认分支**上 dispatch
   [Weekly burn image](../../actions/workflows/weekly-burn-build.yml)。
   feature 分支上 `detect` 有 `if: github.ref_name == default_branch`，只会跑诊断、产不出包。
6. 拿到新包**先上机**再改 README 的状态表。构建成功不等于能启动 ——
   变体 A/B 三次全黑就是这么出来的。

## 内核为什么冻在 5.10.268

这块板唯一的无线是 SDIO 的 RTL8189FTV，驱动是 out-of-tree 的 `rtl8189fs`
（`CONFIG_RTL8189FS`），主线没有。ophub 的 `kernel-config/release/stable/config-*`：

| 内核线 | `CONFIG_RTL8189FS` | 结论 |
|---|---|---|
| 5.10 / 5.15 | `=m` | 有 WiFi；EOL 都是 2026-12-31 |
| 6.1 / 6.6 | 无 | 没有 WiFi |
| 6.12 / 6.18 | 只有 `CONFIG_RTL8188EE=m`（PCIe 的另一颗芯片） | 没有 WiFi |

**所以没有任何升级路线能保住 WiFi。** 而 6.x 也修不了这块板的实际缺口：蓝牙几乎确定
是芯片/固件缺失、HDMI 输出模式由厂商 U-Boot 决定、eMMC HS200 是协议层握手失败
（见 [`docs/known-issues.md`](known-issues.md) 第 1 条）、板上没有 GbE / USB3 硬件。
6.x 真正多出来的只有 SPDIF dai、主线 `meson-vdec` 和 CVE 新鲜度。

## 三条升级路线

| 路线 | 代价 | 什么时候值得 |
|---|---|---|
| 留在 5.10.y，只跟 point release | 几乎为零，重钉两个摘要 | 默认。2026-12-31 之前一直有效 |
| 跳到 5.15.y | 一次重钉 + 一次实机验证；WiFi 仍在 | 5.10 EOL 之后想再撑一年 |
| 跳到 6.12+ | 要自己把 `rtl8189fs` 移植到 6.x 并进 ophub 的 config | 只有真的需要 6.x 的驱动栈时 |

第三条是唯一能长期活下去的路，也是唯一需要写代码的。

**内核和 bootloader 之外的东西不用重刷。** 用户态（Debian 包、Armbian 脚本）在板上
`apt update && apt full-upgrade` 就能跟上，`/boot` 是空的、rootfs 里没有
`linux-image-*`（[`docs/known-issues.md`](known-issues.md) 第 2 条），所以 `apt` 碰不到
启动路径 —— 升级不会刷坏，但也换不了内核。

