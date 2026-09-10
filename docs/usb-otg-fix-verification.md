# USB OTG 修复验证方案

## 当前状态

### ✅ 已完成
1. **诊断完成**：根本原因是设备树缺少 `resets = <0x11 0x22>;`
2. **修复文件已生成**：
   - 设备上：`/root/dtb-fix/meson-gxl-s905l-fixed.dtb`
   - 本地：`tests/fixtures/meson-gxl-s905l-fixed.dtb`
3. **文档完整**：
   - 调查报告：`docs/usb-otg-investigation.md`
   - 待办清单：`docs/usb-otg-todo.md`

### ⏸️ 阻塞点
**无法在运行设备上直接应用 DTB**，原因：
- Armbian ophub 的 DTB 加载机制特殊
- `/boot` 目录为空，DTB 不在文件系统中
- DTB 可能嵌入在 U-Boot 或内核中
- 无 kexec 支持，无法运行时热替换
- 直接修改 EMMC 风险较高且位置不明

## 推荐方案：通过构建流程验证

由于无法在运行设备上安全地应用 DTB，推荐的验证路径是：

### 方案 A：集成到基础镜像构建（推荐）

**在 `b860av1-t-armbian-burn-builder` 中实现**

1. **研究 ophub armbian 构建流程**
   ```bash
   # Clone ophub armbian 仓库
   git clone https://github.com/ophub/amlogic-s9xxx-armbian
   
   # 查找 DTB 处理脚本
   grep -r "dtb" amlogic-s9xxx-armbian/
   grep -r "device.tree" amlogic-s9xxx-armbian/
   ```

2. **定位 DTB 注入点**
   - 可能在内核打包阶段
   - 可能在 U-Boot 配置中
   - 可能在镜像烧录脚本中

3. **修改构建脚本**
   ```bash
   # 在构建流程中添加 DTB 修改步骤
   # 1. 提取原始 DTB
   # 2. 反编译
   # 3. 添加 resets 属性
   # 4. 重新编译
   # 5. 替换回镜像
   ```

4. **构建测试镜像**
   ```bash
   cd b860av1-t-armbian-burn-builder
   # 修改脚本后执行构建
   ./build.sh
   ```

5. **验证测试**
   - 烧录新镜像到测试设备
   - 启动并检查 `dmesg | grep dwc2`
   - 应该没有 "Soft Reset timeout" 错误
   - 测试 USB gadget 功能

### 方案 B：创建 DTB overlay（如果支持）

某些 Amlogic 设备支持 DTB overlay，可以在不修改主 DTB 的情况下应用补丁：

```dts
/dts-v1/;
/plugin/;

/ {
    fragment@0 {
        target-path = "/soc/usb@d0078080/usb@c9100000";
        __overlay__ {
            resets = <0x11 0x22>;
        };
    };
};
```

编译：
```bash
dtc -@ -I dts -O dtb -o usb-otg-fix.dtbo usb-otg-fix-overlay.dts
```

### 方案 C：U-Boot 环境变量（如果可访问）

如果能访问 U-Boot 控制台：

1. 在启动时中断进入 U-Boot
2. 设置自定义 DTB 地址：
   ```
   setenv fdt_addr_r 0x08000000
   setenv fdtfile /lib/firmware/dtb/meson-gxl-s905l-fixed.dtb
   saveenv
   boot
   ```

**问题**：B860AV1-T 可能没有串口访问

## 临时替代方案

在 DTB 修复验证期间，可以使用以下临时方案：

### 选项 1：外置 USB HID 转换器

使用 CH9329 等 UART 转 USB HID 芯片：
- 通过串口发送 HID 命令
- 无需 USB OTG 功能
- 硬件成本增加

### 选项 2：软件编码器

当前已验证可用：
- One-KVM 使用软件编码器
- CPU 占用可接受
- 画质和延迟略有影响

## 验证检查清单

应用 DTB 修复后，验证以下项目：

### 1. 启动检查
```bash
# 检查设备树是否正确加载
cat /proc/device-tree/soc/usb@d0078080/usb@c9100000/compatible
# 应该输出：amlogic,meson-g12a-usb snps,dwc2

# 检查 resets 属性是否存在
ls -l /proc/device-tree/soc/usb@d0078080/usb@c9100000/resets
# 应该存在这个文件
```

### 2. 驱动初始化
```bash
# 检查 dmesg，不应该有错误
dmesg | grep dwc2
# ✅ 正常：dwc2 绑定成功，无 timeout 错误
# ❌ 失败：仍然有 "Soft Reset timeout GRSTCTL_CSFTRST"
```

### 3. USB Gadget 状态
```bash
# UDC 状态应该正常
cat /sys/class/udc/c9100000.usb/state
# ✅ 应该是 "configured" 或 "not attached"（但不是 error 状态）
# ❌ 如果仍是 "not attached" 且 dmesg 有错误，说明还有其他问题

# 当前速度应该正常
cat /sys/class/udc/c9100000.usb/current_speed
# ✅ 应该是 "high-speed" 或 "full-speed"
# ❌ 如果是 "UNKNOWN"，说明控制器未初始化
```

### 4. One-KVM 功能测试
```bash
# 重启 One-KVM 服务
systemctl restart one-kvm

# 检查日志
journalctl -u one-kvm -f

# 连接到被控主机，测试：
# - 键盘输入
# - 鼠标移动
# - 鼠标点击
```

## 失败场景处理

### 如果修复后仍然失败

**可能原因 1：硬件不支持 peripheral 模式**
- B860AV1-T 的 USB OTG 口可能硬件设计上不支持 device 模式
- 验证方法：查看原厂固件是否支持 USB gadget
- 解决方案：使用外置 HID 转换器

**可能原因 2：还缺少其他配置**
- 可能还需要配置 PHY、时钟或电源
- 验证方法：对比其他成功的 Amlogic 设备树
- 解决方案：继续分析 dmesg 错误，逐步完善设备树

**可能原因 3：内核驱动问题**
- 5.10.268-ophub 内核的 dwc2 驱动可能有 bug
- 验证方法：尝试更新内核版本
- 解决方案：打补丁或升级内核

## 下一步行动

### 立即可做
1. ✅ **完成**：文档已完整
2. ✅ **完成**：修复文件已准备
3. ⏳ **待定**：研究 ophub armbian 构建脚本

### 需要进一步研究
1. 下载 ophub armbian 源码
2. 分析 DTB 打包和注入流程
3. 确定修改点
4. 实现自动化 DTB 修改脚本

### 测试验证
1. 构建包含修复的镜像
2. 烧录到测试设备
3. 按照验证检查清单逐项测试
4. 根据结果调整方案

## 风险评估

**低风险**：
- 在构建流程中修改 DTB
- 有完整的原始镜像备份
- 可以随时回滚

**中等风险**：
- 直接在 EMMC 上替换 DTB
- 如果位置错误可能导致无法启动
- 需要串口或重新烧录恢复

**高风险**：
- 修改 U-Boot 分区
- 可能变砖
- 不推荐

## 参考资料

- ophub armbian 仓库：https://github.com/ophub/amlogic-s9xxx-armbian
- Amlogic U-Boot 文档：https://github.com/u-boot/u-boot/tree/master/board/amlogic
- dwc2 驱动文档：https://www.kernel.org/doc/html/latest/usb/dwc2.html
- 设备树规范：https://devicetree-specification.readthedocs.io/

---

**文档版本**：1.0  
**最后更新**：2026-09-10  
**状态**：等待构建流程集成
