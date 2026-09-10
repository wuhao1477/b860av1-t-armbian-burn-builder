# B860AV1-T One-KVM 项目后续行动方案

## 🎯 当前状态快速总结

**可用功能**：
- ✅ 视频采集和预览（HDMI 输入）
- ✅ 软件编码（Mjpeg，CPU 占用较高）
- ✅ Web 界面访问

**不可用功能**：
- ❌ 硬件编码器（One-KVM 不支持 Amlogic）
- ❌ USB OTG 键盘/鼠标（DTB 修复未生效）

---

## 🛣️ 三种可行路径

### 路径 1：接受现状 + 硬件补偿方案

**适用场景**：想快速使用，不介意增加少量硬件成本

#### 行动步骤

1. **继续使用软件编码**
   - 当前 Mjpeg 模式可用
   - CPU 占用约 30-50%
   - 适合低刷新率场景（30fps）

2. **添加 USB HID 转换硬件**
   ```
   选项 A: CH9329 串口转 USB HID 模块
   - 成本：约 ¥15-30
   - 连接：树莓派 UART → CH9329 → 目标设备 USB
   - 需要修改 One-KVM 代码支持串口 HID
   
   选项 B: 使用 USB-C 连接到其他设备
   - 成本：¥0（如果有树莓派 4/CM4）
   - 将树莓派 4 的 USB-C 配置为 USB Gadget
   - 作为键盘/鼠标设备
   ```

3. **实施计划**
   ```bash
   # 1. 测试 CH9329 模块
   # 2. 修改 One-KVM HID 输入代码
   # 3. 添加串口 HID 支持
   ```

**预计工作量**：1-2 天开发 + 硬件到货时间  
**成功率**：90%  
**成本**：¥15-50

---

### 路径 2：为 One-KVM 添加 Amlogic 支持

**适用场景**：愿意投入开发时间，想要完美方案

#### 技术方案

##### 2.1 添加硬件编码器支持

One-KVM 当前架构：
```
Video Source (UVC) → Encoder (MPP) → Streamer → Web Client
```

需要改为：
```
Video Source (UVC) → Encoder (MPP 或 V4L2) → Streamer → Web Client
                          ↑
                    根据平台选择
```

##### 2.2 实施步骤

1. **Fork One-KVM 项目**
   ```bash
   git clone https://github.com/mofeng-git/One-KVM.git
   cd One-KVM
   git checkout -b feature/amlogic-support
   ```

2. **添加 V4L2 M2M 编码器支持**
   
   创建新文件：`src/video/encoder/v4l2_encoder.rs`
   ```rust
   // 使用 V4L2 Memory-to-Memory API
   // 参考 meson-hcodec 驱动接口
   
   pub struct V4l2Encoder {
       device: File,  // /dev/video0
       format: PixelFormat,
       width: u32,
       height: u32,
   }
   
   impl Encoder for V4l2Encoder {
       fn encode(&mut self, frame: &Frame) -> Result<Vec<u8>> {
           // 实现 V4L2 编码逻辑
       }
   }
   ```

3. **添加平台检测**
   ```rust
   // src/platform/mod.rs
   pub enum Platform {
       Rockchip,
       Amlogic,
       Generic,
   }
   
   pub fn detect_platform() -> Platform {
       // 读取 /proc/device-tree/compatible
       // 或检查 /sys/class/video4linux/video*/name
   }
   ```

4. **修改编码器初始化逻辑**
   ```rust
   // src/video/encoder/mod.rs
   pub fn create_encoder(config: &Config) -> Box<dyn Encoder> {
       match detect_platform() {
           Platform::Rockchip => Box::new(MppEncoder::new(config)),
           Platform::Amlogic => Box::new(V4l2Encoder::new(config)),
           Platform::Generic => Box::new(SoftwareEncoder::new(config)),
       }
   }
   ```

5. **测试和验证**
   ```bash
   cargo build --release
   ./target/release/one-kvm --config test-config.yaml
   ```

6. **提交 PR**
   - 创建详细的 PR 说明
   - 包含测试结果和性能对比
   - 等待社区审核

##### 2.3 关键技术点

**V4L2 M2M API 使用**：
```c
// 参考代码（需要转换为 Rust）
int fd = open("/dev/video0", O_RDWR);

// 设置输入格式（YUV）
struct v4l2_format fmt_in;
fmt_in.type = V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
fmt_in.fmt.pix_mp.width = 1920;
fmt_in.fmt.pix_mp.height = 1080;
fmt_in.fmt.pix_mp.pixelformat = V4L2_PIX_FMT_NV12;
ioctl(fd, VIDIOC_S_FMT, &fmt_in);

// 设置输出格式（H.264）
struct v4l2_format fmt_out;
fmt_out.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
fmt_out.fmt.pix_mp.pixelformat = V4L2_PIX_FMT_H264;
ioctl(fd, VIDIOC_S_FMT, &fmt_out);

// 分配和管理缓冲区
// 执行编码...
```

**预计工作量**：1-2 周全职开发  
**技术难度**：中等  
**成功率**：70%（需要深入了解 V4L2 和 Rust）

---

### 路径 3：更换硬件平台

**适用场景**：追求最佳体验，愿意更换硬件

#### 推荐硬件

##### 选项 A: Orange Pi 5 / 5B / 5 Plus
- **SoC**: Rockchip RK3588/RK3588S
- **价格**: ¥400-800
- **优势**:
  - One-KVM 原生支持
  - 硬件编码器完美支持
  - USB OTG 功能正常
  - 性能强大（8 核 A76/A55）
- **劣势**:
  - 成本较高
  - 功耗较大（~15W）

##### 选项 B: Orange Pi Zero 3
- **SoC**: Allwinner H618
- **价格**: ¥80-150
- **优势**:
  - 价格便宜
  - 功耗低
  - 体积小
- **劣势**:
  - 需要验证 One-KVM 支持
  - 性能一般

##### 选项 C: Radxa Zero 3W
- **SoC**: Rockchip RK3566
- **价格**: ¥200-300
- **优势**:
  - 性价比高
  - Rockchip 平台，One-KVM 支持好
  - 功耗适中
- **劣势**:
  - 性能中等

#### 迁移计划

1. **购买新硬件**
2. **复用现有配件**：
   - HDMI 采集卡
   - 外壳（如果尺寸合适）
   - 电源
3. **安装配置**：
   ```bash
   # 1. 烧录支持的系统
   # 2. 安装 One-KVM
   # 3. 配置 USB OTG
   # 4. 测试所有功能
   ```

**预计成本**：¥80-800（取决于选择）  
**时间投入**：1-2 天  
**成功率**：95%

---

## 📊 方案对比

| 方案 | 成本 | 时间 | 技术难度 | 最终效果 | 推荐度 |
|------|------|------|----------|----------|--------|
| 路径 1：硬件补偿 | ¥15-50 | 1-2 天 | 低 | 基本可用 | ⭐⭐⭐ |
| 路径 2：开发支持 | ¥0 | 1-2 周 | 高 | 完美 | ⭐⭐⭐⭐ |
| 路径 3：更换硬件 | ¥80-800 | 1-2 天 | 低 | 完美 | ⭐⭐⭐⭐⭐ |

---

## 🎬 建议行动顺序

### 如果你时间有限且想快速使用：
```
1. 继续使用当前系统（仅视频监控）
2. 评估是否真的需要键盘/鼠标控制
3. 如需控制，购买廉价的 Rockchip 设备（路径 3）
```

### 如果你是开发者且想贡献开源：
```
1. Fork One-KVM 项目（路径 2）
2. 先实现基础的 V4L2 编码器
3. 测试验证后提交 PR
4. 如果被接受，继续完善功能
```

### 如果你想要最佳方案：
```
1. 购买 Orange Pi 5 或 Radxa Zero 3W（路径 3）
2. 保留 B860AV1-T 作为备用或其他用途
3. 在新硬件上完整部署 One-KVM
```

---

## 🔧 USB OTG 修复的替代尝试

如果你仍想尝试修复 USB OTG，可以尝试以下高级方案：

### 方案 A：通过 kexec 加载新内核
```bash
# 需要支持 kexec 的内核
kexec -l /boot/vmlinuz --initrd=/boot/initrd.img --append="..."
kexec -e
```

### 方案 B：修改 U-Boot 环境变量
```bash
# 如果能访问 U-Boot 控制台
# 尝试添加 DTB 覆盖路径
setenv fdtoverlay /boot/dtb-overlay/usb-otg-fix.dtbo
saveenv
```

### 方案 C：编译自定义内核
```bash
# 1. 获取 Armbian 内核源码
# 2. 修改设备树源文件
# 3. 编译内核和 DTB
# 4. 安装新内核
```

**注意**：这些方案需要更深入的系统知识，成功率不确定。

---

## 📚 相关资源

### One-KVM
- 官方仓库：https://github.com/mofeng-git/One-KVM
- 文档：https://github.com/mofeng-git/One-KVM/wiki

### V4L2 开发
- Kernel 文档：https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/
- V4L2 M2M：https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/dev-mem2mem.html

### Amlogic 硬件编码
- meson-vcodec 驱动：drivers/media/platform/amlogic/meson_vcodec/
- 示例代码：可以参考 FFmpeg 的 v4l2_m2m 实现

### Rockchip 替代硬件
- Orange Pi：http://www.orangepi.org/
- Radxa：https://radxa.com/
- Armbian 支持：https://www.armbian.com/download/

---

## ✅ 检查清单

在做出最终决定前，回答以下问题：

- [ ] 我是否真的需要键盘/鼠标远程控制？
- [ ] 我能接受软件编码的性能（CPU 占用）吗？
- [ ] 我愿意花多少钱解决这个问题？
- [ ] 我有多少时间投入开发？
- [ ] 我的 Rust 开发经验如何？
- [ ] 我是否愿意为开源项目贡献代码？
- [ ] 更换硬件对我来说是否可行？

根据你的答案，选择最适合你的路径。

---

## 📞 需要帮助？

如果你决定实施以上任何方案并需要技术支持：

1. **路径 1**：查找 CH9329 的 Linux 驱动和使用示例
2. **路径 2**：加入 One-KVM 社区讨论技术细节
3. **路径 3**：查看 Armbian 论坛了解硬件兼容性

---

**文档创建时间**：2026-09-10  
**最后更新**：2026-09-10  
**状态**：待决定
