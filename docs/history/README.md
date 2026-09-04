# 历史设计文档

这些是本项目早期的实现计划与设计说明，**已被现在的代码和 [`docs/burn-image.md`](../burn-image.md) 取代**，
保留下来只为溯源：想知道某个决定当初是怎么做的，可以来这里查。

不要按这些文档实现新功能 —— 它们描述的是 raw SD 镜像那条线，且早于直刷包的全部发现。

**里面的仓库名已经过时。** 这些文档写于 raw 那条线还在另一个仓库的时候，正文和 JSON
示例里出现的 `wuhao1477/b860av1-t-armbian-builder` 指的就是那个仓库：它已经合并进本仓库、
转为私有，公开地址打不开。当前唯一有效的仓库常量是
`wuhao1477/b860av1-t-armbian-burn-builder`（见 `src/device-evidence.mjs`、
`src/release-metadata.mjs`、`scripts/validate-device-evidence.mjs`）。这里的旧名字刻意
不改 —— 历史记录改了就不是记录了。

## 归档的分支

早期的实验分支都已删除，删之前打了 `archive/<原分支名>` 的附注 tag，提交对象因此仍然
可达。想看某条路当初是怎么走的：

```bash
git fetch origin --tags
git log --oneline main..archive/feat/diagnostic-hdmi-console
git checkout -b 随便起个名 archive/feat/diagnostic-hdmi-console
```

| tag | main 之外的提交 | 内容 |
|---|---|---|
| `archive/feat/diagnostic-hdmi-console` | 17 | HDMI 控制台诊断构建 |
| `archive/codex/restore-stock-bl33` | 8 | 恢复原厂 BL33 的早期尝试（与 `archive/feat/stock-boot-armbian` 同一 tip） |
| `archive/codex/fix-b860-emmc-50mhz` | 7 | eMMC 50 MHz 尝试 |
| `archive/feat/vendor-bl33-android-boot` | 0 | 变体 C，已并入 main |
| `archive/feat/ophub-bl33-ext4-burn` | 0 | 变体 B，已并入 main |

另有 `archive/fix/bl2-reseal-after-mbr`、`archive/fix/burn-mbr-in-bootloader`、
`archive/codex/fix-stock-p215-direct-boot` 三个，内容全部已在 main 里。
