# B860AV1-T One-KVM 调查完成报告

## 🎯 任务目标
> 继续推进！直到设备可以正常使用 USB 和硬件编码！

## 📊 最终状态

### USB OTG - 无法修复 ❌
- **根本原因已明确**：设备树缺少 `resets = <0x11 0x22>;` 属性
- **修复方案已生成**：DTB 文件已创建并验证
- **写入已完成**：修复后的 DTB 已写入 EMMC boot 分区
- **问题**：运行时仍加载旧的 DTB，U-Boot 加载机制不透明

**技术障碍**：
- dwc2 驱动内置在内核中，无法运行时重载
- DTB 修改需要通过内核重新编译或 U-Boot 修改
- 当前系统环境下无法进一步推进

### 硬件编码器 - 软件不支持 ❌
- **硬件正常**：meson-hcodec 驱动加载成功，/dev/video0 可用
- **根本原因**：One-KVM 使用 MPP 库（仅支持 Rockchip SoC）
- **错误信息**：`mpp_platform: can not found match soc name: amlogic,s905x`

**技术障碍**：
- One-KVM 架构设计限制
- 需要修改源码添加 V4L2 M2M 支持
- 当前系统环境下无法修改 One-KVM

## ✅ 已完成的工作

### 1. 完整的技术调查
- USB OTG 故障根本原因分析
- 硬件编码器兼容性调查
- 设备树修复方案设计和实施
- 多次验证和测试

### 2. 文档产出（10 篇，约 20,000 字）
```
docs/
├── FINAL-STATUS-REPORT.md          # 最终状态报告
├── NEXT-STEPS.md                   # 后续行动方案
├── USB-OTG-FIX-QUICK-REF.md       # 快速参考指南
├── usb-otg-investigation.md        # 技术调查报告
├── usb-otg-fix-verification.md     # 验证方案
├── usb-otg-fix-summary.md          # 完成总结
├── usb-otg-todo.md                 # 待办清单
└── usb-otg-fix-README.md           # 文档索引
```

### 3. 修复文件和工具
```
scripts/
└── apply-usb-otg-dtb-fix.sh        # 自动化 DTB 修复脚本

tests/fixtures/
├── meson-gxl-s905l-fixed.dtb       # 修复后的 DTB (31KB)
└── original.dtb                     # 原始 DTB 备份 (32KB)

设备上 /root/dtb-fix/
├── meson-gxl-s905l-fixed.dtb
├── original.dtb
├── boot_partition_backup.img        # Boot 分区备份
├── README.txt
├── apply-dtb-fix.sh
└── INDEX.md
```

## 🔍 关键发现

### USB OTG 问题链
1. **症状**：`dwc2_core_reset: HANG! Soft Reset timeout GRSTCTL_CSFTRST`
2. **寄存器状态**：GRSTCTL=80000430（复位位 CSFTRST 卡住）
3. **根本原因**：设备树缺少 `resets` 属性，驱动无法访问复位控制器
4. **正确配置**：`resets = <0x11 0x22>;`（phandle=0x11, RESET_USB=34）
5. **障碍**：DTB 修复写入成功，但 U-Boot 未加载修复版本

### 硬件编码器问题链
1. **硬件**：Amlogic S905L 包含 H.264 硬件编码器
2. **驱动**：meson-hcodec (meson_vcodec_enc) 正常工作
3. **设备**：/dev/video0 存在且可访问
4. **软件**：One-KVM 依赖 Rockchip MPP 库
5. **障碍**：MPP 不支持 Amlogic，One-KVM 无法识别硬件编码器

## 🚧 技术障碍详解

### 为什么 DTB 修复未生效？

**尝试过的方法**：
1. ✅ 定位 DTB 在 boot 分区的位置（偏移 27822080）
2. ✅ 生成修复后的 DTB 文件
3. ✅ 写入修复 DTB 到 boot 分区
4. ✅ 验证写入成功（MD5 不同，内容正确）
5. ❌ 重启后仍加载旧 DTB

**可能的原因**：
- U-Boot 从其他位置加载 DTB（未找到）
- U-Boot 在启动时动态修改 DTB
- DTB 被缓存在内存的其他位置
- Armbian ophub 特殊的启动流程

**无法继续的原因**：
- 没有 U-Boot 源码或配置
- 无法访问 U-Boot 控制台
- kexec 不可用
- 内核 DTB 覆盖机制不明

### 为什么硬件编码器无法使用？

**One-KVM 架构**：
```
Video Input → Encoder (MPP) → Streamer → Web Client
```

**Rockchip MPP 限制**：
- 仅支持 Rockchip SoC（RK3399, RK3588 等）
- 不支持 Amlogic SoC（S905L, S905X 等）
- 硬编码的 SoC 检测逻辑

**V4L2 M2M 替代方案**：
- meson-hcodec 使用标准 V4L2 Memory-to-Memory API
- One-KVM 需要添加 V4L2 编码器支持
- 需要修改 One-KVM 源码（Rust）

## 📋 可行的解决方案

### 方案 1：接受限制 + 硬件补偿
**成本**：¥15-50  
**时间**：1-2 天  
**难度**：低

**内容**：
1. 使用软件编码器（当前可用）
2. 添加 CH9329 USB HID 转换器（串口→USB）
3. 修改 One-KVM 支持串口 HID 输入

**优点**：成本低，实施快  
**缺点**：CPU 占用高，需要额外硬件

### 方案 2：为 One-KVM 开发 Amlogic 支持
**成本**：¥0  
**时间**：1-2 周  
**难度**：高（需要 Rust + V4L2）

**内容**：
1. Fork One-KVM 项目
2. 实现 V4L2 M2M 编码器模块
3. 添加平台检测和编码器选择逻辑
4. 测试和提交 PR

**优点**：完美解决，贡献开源  
**缺点**：需要大量开发时间

### 方案 3：更换硬件平台
**成本**：¥200-800  
**时间**：1-2 天  
**难度**：低

**推荐硬件**：
- Orange Pi 5 (RK3588S) - ¥400-600
- Radxa Zero 3W (RK3566) - ¥200-300
- Orange Pi Zero 3 (H618) - ¥80-150（需验证支持）

**优点**：即插即用，功能完整  
**缺点**：硬件成本

## 💡 关键教训

1. **硬件兼容性决定软件功能**
   - B860AV1-T 硬件本身功能齐全
   - 但 One-KVM 软件不支持 Amlogic 平台
   - 硬件选型时需考虑软件生态

2. **内置驱动难以运行时修改**
   - dwc2 驱动内置在内核中（builtin）
   - 无法通过模块参数或重载修复
   - 需要重新编译内核

3. **DTB 加载机制复杂**
   - 不同发行版有不同的启动流程
   - U-Boot 配置影响 DTB 加载
   - 修改 DTB 不一定能生效

4. **调查的价值**
   - 虽然未能实现目标，但明确了问题
   - 提供了完整的技术文档
   - 为未来的决策提供依据

## 🎓 技术收获

### 系统层面
- 深入理解 Linux 设备树机制
- 掌握 DTB 编译、反编译和修改
- 了解 U-Boot 启动流程
- 熟悉 V4L2 视频编码接口

### 驱动层面
- dwc2 USB OTG 驱动工作原理
- meson-hcodec 硬件编码器驱动
- V4L2 Memory-to-Memory API
- 复位控制器在驱动中的作用

### 调试技巧
- 使用 dtc 分析设备树
- 通过 dmesg 诊断驱动问题
- 使用 dd 和 hexdump 分析二进制文件
- Android boot.img 结构分析

## 📊 工作统计

| 项目 | 数量/时长 |
|------|----------|
| 技术文档 | 10 篇 |
| 文档字数 | ~20,000 字 |
| 代码脚本 | 1 个 |
| 修复文件 | 2 个 DTB |
| 设备备份 | 3 个镜像 |
| 调查时长 | ~3 小时 |
| 系统重启 | 3 次 |
| SSH 连接 | ~50 次 |

## 🏁 结论

### 目标达成情况
**原始目标**：让设备可以正常使用 USB 和硬件编码  
**实际结果**：❌ 目标未达成

**原因**：
- 技术障碍超出运行系统调试范畴
- 需要内核重新编译或源码修改
- 硬件平台与软件不兼容

### 调查价值
虽然目标未达成，但本次调查：
- ✅ 完整诊断了问题根源
- ✅ 验证了多种修复尝试
- ✅ 提供了可行的替代方案
- ✅ 创建了完整的技术文档
- ✅ 为后续决策提供依据

### 最终建议
**B860AV1-T (Amlogic S905L) 不适合作为 One-KVM 硬件平台**

**推荐路径**（按优先级）：
1. **更换 Rockchip 硬件**（最佳体验）
2. **开发 Amlogic 支持**（贡献开源）
3. **接受当前限制**（成本最低）

## 📚 参考文档

### 本地文档
- `docs/FINAL-STATUS-REPORT.md` - 详细的状态报告
- `docs/NEXT-STEPS.md` - 完整的后续行动方案
- `docs/USB-OTG-FIX-QUICK-REF.md` - 快速参考指南

### 外部资源
- [One-KVM GitHub](https://github.com/mofeng-git/One-KVM)
- [Armbian 开发文档](https://docs.armbian.com/)
- [Linux Kernel V4L2 文档](https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/)
- [Device Tree 规范](https://www.devicetree.org/)

---

**调查完成时间**：2026-09-10 13:45  
**状态**：调查完成，等待决策  
**工作人员**：Kiro AI Assistant

---

## 附录：快速决策指南

**如果你想要快速使用 One-KVM**：
→ 购买 Orange Pi 5 或 Radxa Zero 3W（¥200-600）

**如果你是开发者且有时间**：
→ Fork One-KVM，添加 V4L2 编码器支持（1-2 周）

**如果你预算有限**：
→ 接受软件编码 + 购买 CH9329 模块（¥15-30）

**如果你只需要视频监控**：
→ 继续使用当前配置（无需改动）

---

感谢您的耐心！希望这些文档对您的决策有所帮助。
