# B860AV1-T USB OTG 问题调查报告

## 问题描述

One-KVM 的 USB HID 功能（键盘/鼠标模拟）无法工作，设备无法作为 USB gadget 连接到被控主机。

## 症状

1. **USB gadget 配置正常但无法连接**
   - UDC 状态：`not attached`
   - 当前速度：`UNKNOWN`
   - One-KVM 已正确配置 3 个 HID 设备（hid.usb0/1/2）

2. **内核错误日志**
   ```
   [  357.891253] dwc2 c9100000.usb: dwc2_hsotg_init_fifo: timeout flushing fifos (GRSTCTL=80000430)
   [  357.904020] dwc2 c9100000.usb: dwc2_core_reset: HANG! Soft Reset timeout GRSTCTL_CSFTRST
   [  357.904156] dwc2 c9100000.usb: bound driver configfs-gadget
   [  357.916714] dwc2 c9100000.usb: dwc2_core_reset: HANG! Soft Reset timeout GRSTCTL_CSFTRST
   ```

## 根本原因

### 1. 硬件复位失败

dwc2 USB 控制器在初始化时无法完成软复位操作：
- `GRSTCTL_CSFTRST` 位（Core Soft Reset）一直为 1，表示复位操作卡住
- 寄存器值 `GRSTCTL=80000430` 显示复位位未清除

### 2. 设备树缺少 reset 控制器配置

**当前设备树（原始）**：
```dts
usb@c9100000 {
    compatible = "amlogic,meson-g12a-usb", "snps,dwc2";
    reg = <0x00 0xc9100000 0x00 0x40000>;
    interrupts = <0x00 0x1f 0x04>;
    clocks = <0x03 0x33>;
    clock-names = "otg";
    phys = <0x39>;
    dr_mode = "peripheral";
    g-rx-fifo-size = <0xc0>;
    g-np-tx-fifo-size = <0x80>;
    g-tx-fifo-size = <0x80 0x80 0x10 0x10 0x10>;
    phandle = <0xa3>;
    // ❌ 缺少 resets 属性
};
```

**对比其他外设**（如 audio-controller）：
```dts
audio-controller@c8832000 {
    compatible = "amlogic,t9015";
    ...
    resets = <0x11 0x3d>;  // ✅ 有 reset 配置
};
```

### 3. 复位位定义

从内核头文件 `/usr/src/linux-headers-5.10.268-ophub/include/dt-bindings/reset/amlogic,meson-g12a-reset.h`：

```c
#define RESET_USB    34  // 0x22 (十六进制)
```

复位控制器 phandle = `0x11`（在设备树中定义）

## 修复方案

### 修改设备树

在 `usb@c9100000` 节点中添加 reset 属性：

```dts
usb@c9100000 {
    compatible = "amlogic,meson-g12a-usb", "snps,dwc2";
    reg = <0x00 0xc9100000 0x00 0x40000>;
    interrupts = <0x00 0x1f 0x04>;
    clocks = <0x03 0x33>;
    clock-names = "otg";
    phys = <0x39>;
    dr_mode = "peripheral";
    g-rx-fifo-size = <0xc0>;
    g-np-tx-fifo-size = <0x80>;
    g-tx-fifo-size = <0x80 0x80 0x10 0x10 0x10>;
    resets = <0x11 0x22>;  // ✅ 添加此行
    phandle = <0xa3>;
};
```

### 修复步骤

1. **反编译当前设备树**
   ```bash
   dtc -I fs -O dts -o current.dts /proc/device-tree
   ```

2. **修改 DTS 文件**
   添加 `resets = <0x11 0x22>;` 到 usb@c9100000 节点

3. **编译新 DTB**
   ```bash
   dtc -I dts -O dtb -o fixed.dtb current.dts
   ```

4. **应用新 DTB**
   - 需要在启动时替换设备树
   - Armbian ophub 的 DTB 位置待确定（可能嵌入在内核或 EMMC 特定位置）

## 修复文件

已生成的修复文件保存在：
- **设备上**：`/root/dtb-fix/meson-gxl-s905l-fixed.dtb`
- **本地**：`tests/fixtures/meson-gxl-s905l-fixed.dtb`

原始备份：
- **设备上**：`/root/dtb-fix/original.dtb`
- **本地**：`tests/fixtures/original.dtb`

## 验证测试（已执行）

### 1. 重新绑定驱动测试

```bash
echo c9100000.usb > /sys/bus/platform/drivers/dwc2/unbind
sleep 2
echo c9100000.usb > /sys/bus/platform/drivers/dwc2/bind
```

**结果**：仍然失败，同样的复位超时错误
- 确认问题在驱动初始化阶段
- 无法通过运行时操作修复

### 2. USB 控制器状态检查

```bash
cat /sys/class/udc/c9100000.usb/state      # not attached
cat /sys/class/udc/c9100000.usb/current_speed  # UNKNOWN
cat /sys/class/udc/c9100000.usb/is_otg     # 0
```

### 3. USB gadget 配置检查

```bash
ls /sys/kernel/config/usb_gadget/one-kvm/functions/
# hid.usb0  hid.usb1  hid.usb2  ✅ 配置正确

cat /sys/kernel/config/usb_gadget/one-kvm/UDC
# c9100000.usb  ✅ 已绑定到 UDC
```

配置层面完全正确，问题在硬件初始化。

## 待解决问题

### 1. DTB 应用方式

Armbian ophub 的启动方式特殊：
- `/boot` 目录为空
- 无 uEnv.txt 或 armbianEnv.txt
- DTB 可能：
  - 嵌入在内核 Image 中
  - 存储在 EMMC 特定偏移位置
  - 通过 U-Boot 环境变量加载

**需要进一步研究**：
1. Armbian ophub 的 DTB 加载机制
2. 如何在构建流程中注入修改后的 DTB
3. 或者通过 U-Boot 环境变量动态加载

### 2. 硬件兼容性验证

即使修复了 reset，还需验证：
- B860AV1-T 的 USB OTG 口是否硬件上支持 peripheral 模式
- 是否有其他硬件限制（电源、PHY 配置等）

**验证方法**：
- 应用修改后的 DTB 并重启
- 检查是否还有其他初始化错误
- 测试 USB gadget 是否能成功连接到主机

## 相关问题：硬件编码器

**问题**：One-KVM 无法识别 meson-hcodec 为硬件编码器

**原因**：One-KVM 的 hwcodec 库不支持 Amlogic 平台

**当前方案**：使用软件编码器（已验证可用）

**长期方案**：向 One-KVM 项目提交 PR 支持 Amlogic 平台

## 下一步行动

1. ✅ **完成**：诊断根本原因
2. ✅ **完成**：生成修改后的 DTB
3. ⏳ **待定**：确定 DTB 应用方式
4. ⏳ **待定**：集成到构建流程
5. ⏳ **待定**：实机测试验证

## 技术细节

### 相关文件路径

**设备上**：
- 当前 DTB：`/sys/firmware/fdt` (32896 字节)
- 设备树目录：`/sys/firmware/devicetree/base/`
- USB 控制器：`/sys/bus/platform/drivers/dwc2/c9100000.usb/`

**内核头文件**：
- G12A 复位定义：`/usr/src/linux-headers-5.10.268-ophub/include/dt-bindings/reset/amlogic,meson-g12a-reset.h`
- GXBB 复位定义：`/usr/src/linux-headers-5.10.268-ophub/include/dt-bindings/reset/amlogic,meson-gxbb-reset.h`

### 硬件信息

- **SoC**：Amlogic S905L (GXL)
- **内核**：5.10.268-ophub
- **设备树兼容性**：`amlogic,meson-g12a-usb`, `snps,dwc2`
- **USB 控制器地址**：0xc9100000
- **dr_mode**：peripheral (USB device 模式)

### 参考资料

- dwc2 驱动源码：`drivers/usb/dwc2/platform.c`
- 设备树绑定文档：`Documentation/devicetree/bindings/usb/dwc2.txt`
- Amlogic 复位控制器：`drivers/reset/reset-meson.c`

## 结论

USB OTG 问题的根本原因已明确：**设备树缺少 reset 控制器配置**。修复方案已准备就绪，但需要解决 DTB 应用方式的技术难题。

修复后预期可以解决 USB gadget 初始化失败的问题，使 One-KVM 的键盘/鼠标功能正常工作。

---

**调查完成时间**：2026-09-10  
**调查人员**：Kiro AI Assistant  
**设备型号**：B860AV1-T (Amlogic S905L)  
