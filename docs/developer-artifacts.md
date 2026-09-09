# 开发者产物

B860 Armbian 从 v1.3.1 开始，每个 release 会同时发布：

## 用户产物
- `burn.img.xz` — 开箱即用的刷机镜像
- `vendor-boot-contract.json` — 启动合约
- `burn-dtb-contract.json` — 设备树合约

## 开发者产物（用于二次构建）
- `Armbian_*.img.gz` — Armbian raw 镜像（来自 ophub）
- `boot-components.json` — 启动组件元数据
- `resolved-sources.json` — 冻结的上游输入

## 二次构建用途

开发者可以基于这些产物进行二次构建，例如：

### 注入自定义软件

```bash
# 1. 下载开发者产物
gh release download v1.3.1 \
  --repo wuhao1477/b860av1-t-armbian-burn-builder \
  --pattern "Armbian_*.img.gz" \
  --pattern "boot-components.json"

# 2. 设置 ONE_KVM_DEB 环境变量
export ONE_KVM_DEB=/path/to/one-kvm.deb

# 3. 运行构建（apply-rootfs-defaults.sh 会读取 ONE_KVM_DEB）
./scripts/build-burn-payloads.sh Armbian_*.img.gz ./payloads
./scripts/build-vendor-boot-burn.sh ./payloads ./out

# 输出：out/burn.img（包含你注入的软件）
```

### 示例项目

- [b860av1-t-one-kvm-builder](https://github.com/wuhao1477/b860av1-t-one-kvm-builder) — 基于 B860 Armbian 注入 One-KVM

## 发布流程

从 v1.3.1 开始，发布脚本会自动：

1. 从 ophub Armbian 下载对应版本的 raw 镜像
2. 生成 boot-components.json
3. 构建 burn.img
4. 发布时上传所有产物

开发者可以直接使用这些产物，无需重新下载 ophub Armbian。
