# HCODEC 编码驱动实施规划

**结论先行：分三阶段，阶段 0 用户态原型（1 天）→ 阶段 1 树外 V4L2 模块（2–3 天）
→ 阶段 2 上游化（可选，2 周+）。做到阶段 1 就够用了，ffmpeg 的
`h264_v4l2m2m` 不用打补丁就能跑。**

硬件已经确认可用，见 [`docs/hardware-probes.md`](hardware-probes.md)。
这份文档只讲驱动怎么写。

## 现状盘点（全部实测，不是推测）

| 项 | 实测结果 | 对驱动的影响 |
| --- | --- | --- |
| mainline 编码驱动 | **不存在**。`meson-vdec` 只解码，本机连 `/dev/video*` 都没有（模块没加载） | 从零写 |
| DT 节点 | `video-codec@c8820000` 已存在，`compatible = amlogic,gxl-vdec` | reg 范围已描述好，能直接复用 |
| DT 已有资源 | reg `dos`(`0xc8820000`/`0x10000`) + `esparser`；clocks `dos_parser`/`dos`/`vdec_1`/`vdec_hevc`；interrupts `vdec`(SPI 44)/`esparser`(SPI 32)；phandle `amlogic,ao-sysctrl` + `amlogic,canvas` | AO 和 canvas 都能拿到，不用自己找 syscon |
| DT 缺的 | **没有 hcodec 时钟**（`clk-gxbb` 里没有 `CLKID_HCODEC`）、**没有 hcodec 中断**（GXL 上是 SPI 45）、**没有 hcodec 电源域**（`meson-gx-pwrc-vpu` 只管 VPU） | 三样都要补，见阶段 1 |
| 内存 | CMA 64 MB（`CmaFree` 60 MB）；1080p 需要 `0x1370000` = **19.4 MB 物理连续** | CMA 够用 |
| 大页 | `/sys/kernel/mm/hugepages/` 有 **`hugepages-32768kB`** | 一个 32 MB 大页覆盖全部缓冲 → 阶段 0 不需要内核模块 |
| canvas LUT | `DC_CAV_LUT_DATAL/DATAH/ADDR/RDATAL/RDATAH` = DMC 字索引 `0x12`–`0x16` → 字节 `0xc8838048`/`4c`/`50`/`54`/`58`，**有读回通道** | 用户态能直接配 canvas，且能先读回来确认没占用内核的索引 |

## 阶段 0：用户态原型（约 1 天）

目标：**编出一个 IDR 帧，`ffprobe` 能认。** 这一阶段的真正价值是在真硅片上把
上千个寄存器值试对，改一行几秒钟就能重跑，不刷机、不签模块、崩了最多看门狗重启。

1. 一次分配 32 MB 大页，按厂商 `amvenc_buffspec[AMVENC_BUFFER_LEVEL_1080P]`
   的偏移切分（`min_buffsize = 0x1370000`）：`dct` / `dec0_y` / `dec0_uv` /
   `dec1_y` / `dec1_uv` / `assit` / `bitstream` / `inter_bits_info` /
   `inter_mv_info` / `intra_bits_info` / `intra_pred_info` / `qp_info`。
   物理地址照 [`hardware-probes.md`](hardware-probes.md) 的 pagemap + `/dev/mem` 核对流程拿。
2. 配 6 个 canvas（`dblk_buf_canvas` 3 个 + `ref_buf_canvas` 3 个）：先用
   `DC_CAV_LUT_RDATAL/H` 把 LUT 读一遍，挑内核 `meson-canvas` 没占的高位索引，
   再写 `DATAL/DATAH` + `ADDR`。厂商用的是固定基址 `ENC_CANVAS_OFFSET`，别照抄。
3. 移植 gxl 分支的初始化：`avc_prot_init()`（847 行，剔掉 M8/M8B/GXTVBB/TXL
   变体后约 500 行）+ `set_input_format()`（243 行，NV12/NV21/YUV420 → `MFDIN_*`）
   + `avc_init_encoder()`（25 个寄存器写）+ `amvenc_avc_start_cmd()`（239 行）。
4. **不要中断**：轮询 `ENCODER_STATUS`（`HENC_SCRATCH_0` = `0xc8826b00`）等
   `ENCODER_SEQUENCE_DONE` / `ENCODER_IDR_DONE`。已实测固件就坐在这个循环里等命令。
5. 输入帧写完用 `dc civac` 刷 cache，编完读 `HCODEC_VLC_TOTAL_BYTES`
   （`0xc8827468`）拿码流字节数，从 `bitstream` 缓冲区里搬出来存文件。

**这一阶段的主要风险**：`avc_prot_init` 里的 ME/量化/deblock 参数写错不会报错，
只会出一个解不开的码流。对策是先只做 `ENCODER_SEQUENCE`（只出 SPS/PPS，
参数依赖面小得多），确认 `VLC_TOTAL_BYTES` 是个合理的小数字、字节序列以
`00 00 00 01 67` 开头，再上 IDR 帧。

## 阶段 1：树外 V4L2 M2M 模块（2–3 天）

把阶段 0 试对的序列搬进内核，直接做 V4L2 而不是厂商那套 `/dev/amvenc_avc` ioctl
——V4L2 stateful M2M 编码器能让 ffmpeg 的 `h264_v4l2m2m` 和 gstreamer 的
`v4l2h264enc` 零补丁使用，厂商 ABI 还得配一个 `libvpcodec`。

1. **时钟**：树外模块里直接用 HIU syscon regmap 写 `HHI_VDEC_CLK_CNTL`
   位 `[27:25]` sel / `[22:16]` div / `[24]` enable（实测值 `0x01020000`）。
   不要为这个先去改 `clk-gxbb.c`——那是阶段 2 的事。
2. **电源域**：用 DT 里已有的 `amlogic,ao-sysctrl` regmap 走
   [`hardware-probes.md`](hardware-probes.md) 那张七步表，加上 `DOS_MEM_PD_HCODEC`。
3. **中断**：给 burn 包的 DTB 加 `hcodec` 中断（GXL 是 SPI 45）。本仓库的
   `writeStandaloneDtb()` 已经在合并 overlay 后用 `fdtput` 改 DTB，加一条属性就行，
   跟第 1 条已知问题删 `mmc-hs200-1_8v` 是同一个位置。**也可以先不加**，
   沿用阶段 0 的轮询，一帧一次轮询的开销在 30 fps 下无所谓。
4. **缓冲区**：`dma_alloc_coherent()` 从 CMA 拿那 19.4 MB，省掉 `dc civac`。
   输入帧走 V4L2 的 dmabuf / mmap，`meson_canvas_alloc()` + `meson_canvas_config()`
   配 canvas（DT 的 `amlogic,canvas` phandle 已经在了）。
5. **绑定方式**：不要去抢 `video-codec@c8820000`（`meson-vdec` 要用）。加一个
   `amlogic,gxl-hcodec` 的兄弟节点，reg 指向同一个 DOS 窗口，或者做成 `meson-vdec`
   的子设备。两个驱动共用 `DOS_SW_RESET1` 和 `DOS_GCLK_EN0`，**复位脉冲不能再写
   `0xffffffff`**，必须只打 hcodec 相关的位，否则会打断正在解码的 vdec。

## 阶段 2：上游化（可选，2 周+）

只有想进 mainline 才做：给 `drivers/clk/meson/gxbb.c` 加 `CLKID_HCODEC`
（照 `gxbb_vdec_hevc` 那组 mux/div/gate 抄，换成 `HHI_VDEC_CLK_CNTL` 的高半部分，
约 60 行）；写 `amlogic,gxl-hcodec` 的 DT binding 文档；hcodec 电源域并进
`meson-gx-pwrc`；然后往 linux-media 发 patch。

## 不做什么

- 不移植厂商的 `/dev/amvenc_avc` ioctl ABI（要额外配 `libvpcodec`，还是死路）。
- 不做 JPEG 编码（`jpegenc.c` 是另一套 ucode 和另一套寄存器）。
- 不改 raw 那条线的内核配置——编码驱动是树外模块，跟冻结输入无关，
  见 [`docs/frozen-inputs.md`](frozen-inputs.md)。
- 不把这个做成刷机包的默认组件，直到阶段 1 有实机编出的可播放码流。

## 参考

- 厂商驱动：`khadas/linux@khadas-vim-3.14.y:drivers/amlogic/amports/encoder.c`（5086 行）
- 寄存器定义：同仓库 `drivers/amlogic/amports/arch/regs/hcodec_regs.h`、`dmc_regs.h`
- 关键函数行号：`avc_init_encoder` 870、`avc_canvas_init` 926、`avc_buffspec_init` 962、
  `set_input_format` 1473、`avc_prot_init` 1718、`amvenc_loadmc` 2642、
  `avc_poweron` 2763、`amvenc_avc_start_cmd` 3082
