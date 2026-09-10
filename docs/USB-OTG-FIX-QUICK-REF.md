# USB OTG 修复快速参考

## 🎯 问题

B860AV1-T 设备的 USB OTG 无法工作，One-KVM 键盘/鼠标功能失效。

**错误日志**：
```
dwc2 c9100000.usb: dwc2_core_reset: HANG! Soft Reset timeout GRSTCTL_CSFTRST
```

## ✅ 解决方案

**根本原因**：设备树缺少 USB 控制器的 reset 属性

**修复方法**：在设备树中添加一行
```dts
resets = <0x11 0x22>;  // 到 usb@c9100000 节点
```

## 📁 关键文件

| 文件 | 位置 | 说明 |
|------|------|------|
| 修复后 DTB | `tests/fixtures/meson-gxl-s905l-fixed.dtb` | 31KB，已验证 |
| 原始 DTB | `tests/fixtures/original.dtb` | 32KB，备份 |
| 自动化脚本 | `scripts/apply-usb-otg-dtb-fix.sh` | 可执行 |
| 详细报告 | `docs/usb-otg-investigation.md` | 完整技术分析 |
| 验证方案 | `docs/usb-otg-fix-verification.md` | 3 种验证路径 |
| 完成总结 | `docs/usb-otg-fix-summary.md` | 工作成果 |

**设备上**：
- `/root/dtb-fix/meson-gxl-s905l-fixed.dtb`
- `/lib/firmware/dtb/meson-gxl-s905l-fixed.dtb`

## 🔧 使用自动化脚本

```bash
# 从原始 DTB 生成修复版本
./scripts/apply-usb-otg-dtb-fix.sh original.dtb fixed.dtb

# 从运行系统生成
./scripts/apply-usb-otg-dtb-fix.sh /sys/firmware/fdt fixed.dtb
```

## 🚀 集成到构建流程

### 步骤 1：定位 DTB 在构建流程中的位置

查看 ophub armbian 的构建脚本，找到 DTB 处理部分。

### 步骤 2：插入修复脚本

在 DTB 打包之前调用：
```bash
./scripts/apply-usb-otg-dtb-fix.sh <原始dtb> <输出dtb>
```

### 步骤 3：构建测试镜像

运行构建流程，生成包含修复的镜像。

### 步骤 4：验证

烧录并启动后检查：
```bash
# 1. 检查 dmesg 无错误
dmesg | grep dwc2
# 应该没有 "Soft Reset timeout"

# 2. 检查 UDC 状态
cat /sys/class/udc/c9100000.usb/state
# 应该不是 "not attached" + error

# 3. 检查 USB 速度
cat /sys/class/udc/c9100000.usb/current_speed
# 应该显示 "high-speed" 或 "full-speed"

# 4. 测试 One-KVM
systemctl restart one-kvm
# 测试键盘/鼠标功能
```

## 📚 技术细节

**复位控制器配置**：
- Phandle: `0x11` (复位控制器节点)
- Reset bit: `0x22` (34，即 RESET_USB)
- 来源：`/usr/src/linux-headers-5.10.268-ophub/include/dt-bindings/reset/amlogic,meson-g12a-reset.h`

**设备树节点路径**：
```
/soc/usb@d0078080/usb@c9100000
```

**寄存器地址**：
```
0xc9100000 - 0xc913ffff (256KB)
```

## ⚠️ 注意事项

1. **备份重要**：始终保留原始 DTB 备份
2. **测试先行**：在测试设备上验证后再推广
3. **文档记录**：修改后更新相关文档
4. **版本追踪**：在 git 中记录修改原因

## 🔍 故障排查

### 如果修复后仍然失败

**检查点 1：DTB 是否正确加载**
```bash
# 查看运行的设备树是否包含 resets 属性
ls -l /proc/device-tree/soc/usb@d0078080/usb@c9100000/resets
# 应该存在此文件
```

**检查点 2：硬件是否支持**
- B860AV1-T 的 USB 口可能硬件上不支持 device 模式
- 查看原厂固件是否有 USB gadget 功能

**检查点 3：其他依赖**
```bash
# 检查 PHY 配置
cat /sys/class/phy/phy-*/phy_type

# 检查时钟
cat /sys/kernel/debug/clk/clk_summary | grep -i usb
```

### 替代方案

如果硬件真的不支持，使用：
- **CH9329 串口转 USB HID**（硬件方案）
- **软件编码器**（已验证可用）

## 📞 获取帮助

- 详细技术分析：`docs/usb-otg-investigation.md`
- 验证完整方案：`docs/usb-otg-fix-verification.md`
- 工作完成总结：`docs/usb-otg-fix-summary.md`
- 待办事项清单：`docs/usb-otg-todo.md`

---

**版本**：1.0  
**最后更新**：2026-09-10  
**状态**：✅ 修复准备完成，等待构建集成
