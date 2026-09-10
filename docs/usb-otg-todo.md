# USB OTG 修复待办事项

## 已完成 ✅

1. ✅ 诊断 USB OTG 问题根本原因
   - dwc2 控制器软复位超时
   - 设备树缺少 `resets = <0x11 0x22>;`

2. ✅ 生成修改后的设备树
   - 文件位置：`tests/fixtures/meson-gxl-s905l-fixed.dtb`
   - 原始备份：`tests/fixtures/original.dtb`

3. ✅ 创建详细调查报告
   - 文档：`docs/usb-otg-investigation.md`

## 待完成 ⏳

### 1. 研究 Armbian ophub DTB 加载机制

**目标**：确定 DTB 在镜像中的存储位置和加载方式

**可能的位置**：
- [ ] 嵌入在内核 Image 中（需要反编译内核镜像）
- [ ] EMMC 特定偏移位置（需要分析 U-Boot 启动脚本）
- [ ] U-Boot 环境变量动态加载（需要转储 U-Boot env）

**行动项**：
```bash
# 在设备上执行
dd if=/dev/mmcblk2 bs=1M count=100 of=/tmp/emmc_head.img
# 分析 U-Boot 和内核镜像结构

# 或者查看 ophub armbian 构建脚本
# https://github.com/ophub/amlogic-s9xxx-armbian
```

### 2. 确定修复应该在哪个构建项目中

**选项 A**：在 `b860av1-t-armbian-burn-builder` 中修复
- ✅ 优点：底层硬件修复，所有基于此基础镜像的项目都受益
- ❌ 缺点：修改基础 Armbian 镜像，可能影响其他用途

**选项 B**：在 `b860av1-t-one-kvm-builder` 中修复
- ✅ 优点：只影响 One-KVM 镜像，不改变基础镜像
- ❌ 缺点：USB OTG 是硬件功能，不应该是应用层修复

**推荐**：选项 A（在基础镜像构建中修复）

### 3. 集成 DTB 修复到构建流程

根据第 1 步的研究结果，修改构建脚本：

**如果 DTB 在内核 Image 中**：
```bash
# 在构建脚本中添加
# 1. 从内核 Image 提取 DTB
# 2. 反编译、修改、重新编译
# 3. 替换回内核 Image
```

**如果 DTB 在 EMMC 偏移位置**：
```bash
# 在烧录脚本中添加
# 1. 挂载镜像
# 2. 写入修改后的 DTB 到正确偏移
```

**如果通过 U-Boot 加载**：
```bash
# 修改 U-Boot 环境变量或启动脚本
# 指向自定义 DTB 位置
```

### 4. 测试验证

**测试步骤**：
1. [ ] 构建包含修复的新镜像
2. [ ] 烧录到测试设备
3. [ ] 启动并检查 dmesg：
   ```bash
   dmesg | grep dwc2
   # 应该没有 "Soft Reset timeout" 错误
   ```
4. [ ] 检查 USB gadget 状态：
   ```bash
   cat /sys/class/udc/c9100000.usb/state
   # 应该不是 "not attached"，而是 "configured" 或其他正常状态
   ```
5. [ ] 测试 One-KVM 键盘/鼠标功能
6. [ ] 验证其他功能未受影响

### 5. 文档和发布

- [ ] 更新构建文档，说明 DTB 修复
- [ ] 更新 CHANGELOG
- [ ] 如果发现 ophub armbian 也有同样问题，考虑提交 upstream PR

## 备选方案

如果修复后仍然失败（可能是硬件限制）：

### 方案 A：外置 USB HID 转换器
- 使用 CH9329 等串口转 USB HID 芯片
- 通过 UART 发送 HID 数据

### 方案 B：网络 HID
- 通过网络传输 HID 事件
- 在被控主机上运行接收端软件（侵入性强，不推荐）

## 时间估算

- **研究 DTB 加载机制**：2-4 小时
- **集成到构建流程**：2-3 小时
- **测试验证**：1-2 小时
- **总计**：5-9 小时

## 优先级

🔴 **高优先级**：USB OTG 是 One-KVM 的核心功能，键盘/鼠标无法工作严重影响可用性

## 相关资源

- 调查报告：`docs/usb-otg-investigation.md`
- 修复后的 DTB：`tests/fixtures/meson-gxl-s905l-fixed.dtb`
- ophub armbian 仓库：https://github.com/ophub/amlogic-s9xxx-armbian
- dwc2 驱动文档：https://www.kernel.org/doc/html/latest/usb/dwc2.html

---

**最后更新**：2026-09-10
