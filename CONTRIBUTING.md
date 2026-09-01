# 参与开发

## 动手之前先读这两份

- [`docs/burn-image.md`](docs/burn-image.md) —— 直刷包怎么工作的，以及三次实机全黑分别是什么原因
- [`docs/known-issues.md`](docs/known-issues.md) —— 还没解决的问题，以及每个要动什么

**最重要的一条：变体 A/B 那条路（重打包 FIP、换掉 BL33）已经被实机证伪。**
`build-burn-image.sh` 和 `build-ophub-bl33-burn.sh` 留在仓库里只作证据，不要基于它们做新功能。

## 本地跑起来

```bash
pnpm install
pnpm test                      # 单元测试
bash -n scripts/*.sh           # 脚本语法

eval "$(scripts/setup-image-tools.sh)"     # 按 config 里钉死的 commit 编 ampack / gxlimg
scripts/build-vendor-boot-burn.sh <source-package-dir> out
scripts/validate-vendor-boot-burn.sh out/burn.img out/vendor-boot-contract.json
```

macOS 上用 Docker 跑 linux/arm64 容器即可，不需要 CI。

## 提 PR

1. 先开 issue，写清板子版本、SoC 丝印、内存/eMMC 容量，和你要改的行为。
2. 先加一个会失败的测试，再写实现。
3. 改动直刷包相关的字节布局时，PR 里要带**测量结果**，不要只写推理 —— 这个仓库里
   每一条结论都是量出来的（见 `docs/burn-image.md` 的「三次全黑的根因」）。
4. 不要提交本地绝对路径、设备密钥、Android 应用。
   `board-inputs/` 里的原厂固件片段是构建的必要输入，已经在仓库里，不要再加别的。

Commit 格式 `<type>(scope): <中文摘要>`，保持 GPG 或 SSH 签名。

## 硬件结论怎么算数

这块板**没有可用串口**，所以不能要求串口日志。声明「能启动」需要给出：

- `/proc/cmdline`、`/etc/armbian-release`、`uname -a`
- `ip -br link` 和 `lsblk` 的输出
- 用的是哪个 `burn.img` 的 sha256

个人研究项目，只对与仓库内 `board-inputs/` 摘要一致的那一批板子有效。
