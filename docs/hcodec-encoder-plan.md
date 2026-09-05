# HCODEC 编码驱动实施规划

**结论先行：分三阶段。阶段 0 用户态原型（**已完成，实机编出可解码的 IDR 帧**）→
阶段 1a 树外内核模块（**已完成，insmod 时在内核里编出 IDR**）→ 阶段 1b 包成
V4L2 M2M（**代码已完成，等板子回来验证**，ffmpeg 的 `h264_v4l2m2m` 不用打补丁就能跑）→
阶段 2 上游化（可选，2 周+）。**

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

## 阶段 0：用户态原型 ✅ 已完成（2026-09-05 实机）

**结果：1280x720 Baseline IDR 帧，4,579 字节，`ffprobe` 认 `key_frame=1 pict_type=I`，
解出来的画面和喂进去的合成 NV12 测试图逐像素一致。** 代码在
[`tools/hcenc/`](../tools/hcenc/)，板子上跑完 `hcodec_down.sh` 归位，没有看门狗重启。

```
after-sequence STATUS=7 TOTAL=13    VB wr-start=0        <- SPS 还在 VLC FIFO 里
after-picture  STATUS=8 TOTAL=21    VB wr-start=24       <- 这时才落 DRAM
after-idr      STATUS=9 TOTAL=4579  VB wr-start=4584
00 00 00 01 67 42 00 28 f4 02 80 2d c8   SPS (Baseline, level 4.0)
00 00 00 01 68 ce 38 80                  PPS
00 00 00 01 65 88 84 0f ...              IDR slice
```

三个当时不知道、现在知道的点（细节见 [`tools/hcenc/README.md`](../tools/hcenc/README.md)）：

1. **`ENCODER_SEQUENCE_DONE` 时 VLC 不落盘。** `STATUS=7`、`VLC_TOTAL_BYTES=13`
   全都像成功，但 `VLC_VB_WR_PTR` 还等于 `VLC_VB_START_PTR`，缓冲区全 0 ——
   SPS 卡在 VLC 内部 FIFO。厂商也不在这儿读，它紧接着发 `ENCODER_PICTURE`
   （venc.c:4045），只在 `PICTURE_DONE` 之后读。**顺序错了会以为码流丢了。**
2. **`amvenc_start()` 只在重载 ucode 时调用**（`reload_flag`，venc.c:3316）。
   普通命令只写 `ENCODER_STATUS`，AMRISC 一直在 `0xa05..0xa18` 的空转循环里等。
3. **命令之间 VLC 用 `0xff` 补到 8 字节对齐**，会破坏前一个 NAL 的
   `rbsp_trailing_bits`（只剥零字节的解码器会报 `non-existing PPS 0 referenced`）。
   两段字节要分开写出去，别把补位一起存。

原始规划（保留作对照）：

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

## 阶段 1a：树外内核模块 ✅ 已完成（2026-09-05 实机）

**结果：insmod 时在内核里编出 1280x720 Baseline IDR，`ffprobe` 认
`key_frame=1 pict_type=I`，解出来的 8 条竖条亮度与合成输入逐条对上。**
代码在 [`tools/hcodec-mod/`](../tools/hcodec-mod/)，厂商切片照旧不入库，
由 [`fetch-vendor.sh`](../tools/hcenc/fetch-vendor.sh) 拼到同一个目录再编。

```
platform meson-hcodec: 缓冲区 20447232 字节 @ 0x0000000034b00000
platform meson-hcodec: ucode 已装载（36 轮，ctrl=0x00071000）
platform meson-hcodec: AMRISC 起来了：MPSR=00000005 CPSR=00000000 PC=0a18
platform meson-hcodec: 自测通过：1280x720 QP26 → 4499 字节（21 头 + 4478 IDR）
$ cat /sys/kernel/debug/meson-hcodec/out.h264 | xxd | head -2
0000 0001 6742 0028 f402 802d c800 0000    SPS（Baseline level 4.0）
0168 ce38 8000 0000 0165 8884 0fff fe1e    PPS + IDR
$ ffprobe -show_frames  →  key_frame=1  width=1280  height=720  pict_type=I
$ 解出来第 360 行 8 个条带 Y：0 31 63 94 126 157 189 220
  = 合成输入 16 43 70 97 124 151 178 205 的 limited→full 展开，逐条吻合
```

三种加载路径都过：块已上电时、`rmmod` 断电后重载、刚开机从未上电时
（4432 / 4597 / 4499 字节）。

**码流大小每次不一样（±4%）是正常的**：dblk / ref / assit 这些侧缓冲区拿到的是
CMA 里的旧数据，ucode 的 RD 决策会读它们。解码画面照样对得上。

三条新踩的坑：

1. **厂商 `avc_poweron()` 结尾那个 `mdelay(10)` 不能省。** 第一版没有它，第一次
   insmod 整机硬挂（ssh 15 s 内断、ping 全丢、约 90 s 后自己重启）。解除隔离后
   10 µs 就去读 `ENCODER_STATUS`（hcodec 子块）正是已知的挂总线场景。
2. **硬挂之后一个字的日志都没有。** `/sys/fs/pstore` 空的（cmdline 里有
   `ramoops.*`，但 DT 没有 reserved-memory 节点，backend 根本没注册），
   `/var/log` 又在 tmpfs（armbian-ramlog）。所以模块自带 `marklog=`：每步往
   `/root/hcodec-stage.log` 写一行并 `vfs_fsync`，重启后最后一行就是挂住的那步；
   `stage=1..6` 能只跑到某一步（1 映射 2 上电 3 scratch 4 ucode 5 起 AMRISC 6 编一帧）。
3. **刷机会把板上的调试工具全清掉。** `/root/mmio`、`/root/hcodec_up.sh` 在刷完
   v1.1.0 之后一个都不在，重建花掉半小时。`mmio` 的源码现在进了仓库：
   [`tools/hcenc/mmio.c`](../tools/hcenc/mmio.c)。

## 阶段 1b：包成 V4L2 M2M（已编译通过，等实机验证）

阶段 1a 的核心序列已经在内核里跑通，1b 把它包成 V4L2 stateful 编码器，
让 ffmpeg 的 `h264_v4l2m2m` 和 gstreamer 的 `v4l2h264enc` 零补丁能用
（厂商那套 `/dev/amvenc_avc` ioctl 还得额外配 `libvpcodec`，不做）。

**编译验证（2026-09-05，不需要板子）**：用冻结的 `5.10.268.tar.gz` 里的
`header-5.10.268-ophub.tar.gz` 头文件树，在 arm64 容器里原生 kbuild ——
头文件树自带的 `scripts/fixdep`、`scripts/mod/modpost` 就是 aarch64 ELF，
所以不用交叉编译，`gcc 14.2.0` 和板上一致。

| 项 | 结果 |
| --- | --- |
| `make -C hdr M=... ARCH=arm64 modules` | 干净通过，`W=1` 也零告警 |
| `vermagic` | `5.10.268-ophub SMP preempt mod_unload aarch64` ← 和板子逐字一致 |
| `depends` | `v4l2-mem2mem,videobuf2-dma-contig` ← modpost 实测，坐实了「必须先 modprobe」 |
| `meson_hcodec.ko` | 56,216 B |

复现命令见 [README](../tools/hcodec-mod/README.md) 的「不用板子也能编」。

代码在 [`tools/hcodec-mod/`](../tools/hcodec-mod/)（用法见
[README](../tools/hcodec-mod/README.md)）。单平面 `V4L2_CAP_VIDEO_M2M`，
OUTPUT 收 NV12/NV21/YUV420 → CAPTURE 出 H.264，`vb2_dma_contig` +
`VB2_MMAP | VB2_DMABUF`。硬件只有一份参考帧和一套 canvas，所以只允许一个
ctx，第二个 `open()` 直接 `-EBUSY`。

依赖已经从 rootfs 清单核对过，**不用等板子**：这颗内核里 `videodev` /
`videobuf2-core` / `videobuf2-v4l2` 是 `=y`，而 `v4l2-mem2mem.ko` 和
`videobuf2-dma-contig.ko` 是 `=m` —— insmod 之前必须先 `modprobe` 这两个。
（modpost 出来的 `depends:` 字段已经独立确认了这一条。）

四个绕不开的实现约束（都是读厂商源码读出来的，不是猜的）：

1. **宽高圆到 16 的倍数**（1080 → 1088）。厂商驱动里没有 SPS `frame_cropping`，
   `crop_*` 只喂 ge2d 缩放器（venc.c:1344），所以显示区裁不了。
2. **每帧整套重新初始化。** ISR 在每个 `*_DONE` 之后置 `need_reset`（venc.c:2928），
   `avc_init_encoder()` 因此每帧都跑 —— 它是 `IDR_PIC_ID` / `FRAME_NUMBER` /
   `PIC_ORDER_CNT_LSB` / `QPPICTURE` 和 `VLC_TOTAL_BYTES=0` 的唯一写入者。
   帧后推进（`idr_pic_id++`、`pic_order_cnt_lsb += 2`、dblk ↔ ref canvas 互换）
   照 `AMVENC_AVC_IOC_SUBMIT`（venc.c:3875）做。
3. **QP 走量化表**，不走 `avc_prot_init()` 的 `quant` 参数：GXBB+ 的 FULL ucode
   会用 `quant_tbl_i4/i16[id][0] & 0xff` 反算 `i_pic_qp`（vendor.inc:1509）。
4. **`PHYSICAL_BUFF` 不是 `LOCAL_BUFF`**：后者把 `request->src` 强行改成
   `dct_buff_start_addr`（vendor.inc:1194），V4L2 的缓冲区就喂不进去。
   `bytesperline` 必须等于 MFDIN 的跨度（NV12/NV21 对齐 32，YUV420 对齐 64）。

`device_run` 只 `queue_work`：`hc_wait` 要睡，而且 `v4l2_m2m_job_finish` 会当场
回调下一轮，直接在里面编会递归（vim2m 的做法）。

**板子回来要跑的三条**：`modprobe` 两个依赖 + `insmod`；`v4l2-ctl -d /dev/video0
--all` 看格式和控件；`ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -t 5
-pix_fmt nv12 -c:v h264_v4l2m2m -b:v 4M /tmp/t.h264` 然后 `ffprobe` 数关键帧
——这一步才是 P 帧路径的第一次实机验证。

下面是阶段 1 的原始规划，1a 已经验证的部分标了 ✅：

1. **时钟** ✅：树外模块里直接写 `HHI_VDEC_CLK_CNTL` 位 `[27:25]` sel /
   `[22:16]` div / `[24]` enable（`0x01020000`，实测 166,664,063 Hz）。
   只改高半个字，低半个字是 vdec_1 的。
2. **电源域** ✅：`AO_PWR_SLEEP0[1:0]` + `AO_PWR_ISO0[5:4]` 读改写 +
   `DOS_MEM_PD_HCODEC`，收尾 `mdelay(10)`。
3. **中断**：还没做，仍然轮询 `ENCODER_STATUS`。一帧一次轮询在 30 fps 下无所谓，
   真要做就给 burn 包的 DTB 加 hcodec 中断（GXL 是 SPI 45）。
4. **缓冲区** ✅：`dma_alloc_coherent()` 从 CMA 拿 19.4 MB（`0x1380000`，含尾部
   16 KB ucode 暂存），省掉 `dc civac`。输入帧走 V4L2 的 dmabuf / mmap 是 1b 的事。
5. **绑定方式** ✅：没抢 `video-codec@c8820000`，直接 `ioremap` 同一个 DOS 窗口
   （不 `request_mem_region`），复位脉冲只打 hcodec 的位
   （`amvenc_reset()` 那组 = `0x341c4`），`DOS_GCLK_EN0` 用 `|=`。

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
