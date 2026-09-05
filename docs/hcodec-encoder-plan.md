# HCODEC 编码驱动实施规划

**结论先行：分三阶段。阶段 0 用户态原型（**已完成，实机编出可解码的 IDR 帧**）→
阶段 1a 树外内核模块（**已完成，insmod 时在内核里编出 IDR**）→ 阶段 1b 包成
V4L2 M2M（**已完成，实机 I+P 多帧码流用 ffmpeg 解出来 49~99 dB**，`v4l2-compliance`
48/48 全过，ffmpeg 的 `h264_v4l2m2m` 不用打补丁就能跑）→
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

## 阶段 1b：包成 V4L2 M2M ✅ 已完成（2026-09-05 实机）

**结果：1280x768 NV12 → H.264，IDR + 9 个 P 帧，ffmpeg 解出来对着输入
49.2~54.8 dB；单 IDR 在 QP 10/20 上是无损（99 dB，maxerr 0），QP 26/35/45 是
54.8/47.6/40.9 dB，单调下降。同一输入连编 10 个 IDR 全部 54.8 dB、字节数
±0.4%** —— 确定性、可重放。

阶段 1a 的核心序列已经在内核里跑通，1b 把它包成 V4L2 stateful 编码器，
让 ffmpeg 的 `h264_v4l2m2m` 和 gstreamer 的 `v4l2h264enc` 零补丁能用
（厂商那套 `/dev/amvenc_avc` ioctl 还得额外配 `libvpcodec`，不做）。

### 实机上这一趟只有两个真 bug，都在 QP 上（2026-09-05）

「重建帧完美、解码器解出来一片白」是这两个 bug 的共同症状。**这个症状能直接把
量化器排除掉**：重建帧 = 预测 + 反量化(量化(原始 − 预测))，不管解码器算不算得出
同一个预测都会 ≈ 原始。所以 `rec/in` 60 dB 而 `dec/rec` 4 dB，错的一定是**码流里
signal 出去的东西**，不可能是量化。

| # | 症状 | 真因 | 修法 |
| --- | --- | --- | --- |
| 1 | 控件要 QP 10，帧按 10 量化，解出来全白（`dec/in` 4.4 dB、maxerr 239），而重建帧 58~71 dB | **GXL 的 FULL ucode 把 `slice_qp_delta` 恒写 0**（实测 8 个码流，PPS 说多少 slice 就是多少）。`hc_headers()` 在 streamon 时跑，比 `ctx->cur_qp` 早，PPS 的 `pic_init_qp` 就永远冻在 26 | QP 只能在重发 SPS/PPS 的地方换 —— 也就是 IDR，厂商也正是每个 IDR 先 `ENCODER_SEQUENCE` 再 `ENCODER_PICTURE`。非 IDR 帧改用缓存的 `hc_hdr_qp` |
| 2 | slice QP 26 时同一输入连编 10 个 IDR，解出来 7~26 dB 且**每次都不一样**（QP 10/45 反而干净） | ucode 把 per-MB `mb_qp_delta` **写进了码流，自己的量化器却不按它走**。`ffmpeg -debug qp` 在 slice QP 26 的帧里看到 5..50 的乱数（厂商把幅度开到 `QDCT_VLC_QUANT_CTL_1 = ±26/25`）。QP 10/45 干净只是因为同样的绝对 Δ 在那儿被夹掉了，26 在正中间受害最大 | `avc_prot_init` 之后补一条 `HCODEC_QDCT_VLC_QUANT_CTL_1 = 0`，VLC 就只能写 `mb_qp_delta = 0`。10 个 IDR 全部 51.8 dB |

`ffmpeg -debug qp` 是这一趟最有用的一个工具：它直接把解码器看到的逐 MB QP 图打出来。

排掉的假设（都实测过，别再走一遍）：从 CPU 清 `VLC_ADV_CONFIG` 的
`use_q_delta_quant` / `hcmd_use_q_info` / `hcmd_intra_use_q_info`（ucode 会重写回去，
清了**更差**）；侧缓冲区里的旧数据（六个全清零，结果不变）；每次 insmod 的残留状态
（同一次 insmod 里 10 个 IDR 各错各的）；P 帧链传播（出错的全是全 intra 的 IDR）。

**还有一个坑不在驱动里**：`v4l2-ctl --set-ctrl` 必须和 `--stream-mmap` 在**同一次
调用**里。控件挂在 file handle 上，另起一次调用等于全部恢复默认（i=26/min=16/max=45）。
控件名带 `_value` 后缀：`h264_i_frame_qp_value`、`h264_minimum_qp_value` …

**代价**：`slice_qp_delta ≡ 0` 意味着码率控制只能在 IDR 边界生效，`h264_p_frame_qp_value`
（I/P QP 差值）在这颗 ucode 上表达不出来 —— 收下了但不起作用。

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

### QEMU 上把 V4L2 那一半跑完了（2026-09-05，也不需要板子）

[`scripts/hcodec-v4l2-qemu.sh`](../scripts/hcodec-v4l2-qemu.sh)：拿同一个冻结包里的真
`Image` 在 QEMU virt / cortex-a53 上起 initramfs，`nohw=1` 加载模块，然后 `v4l2-ctl` +
`v4l2-compliance`，再把 IDR/P/P 三帧真的推过 `/dev/video0`。

`nohw=1` 不是「什么都不碰」：四个 MMIO 窗口换成 `vzalloc` 的 RAM，**厂商那整套序列
照跑**（`amvenc_reset` → `avc_canvas_init` → `avc_init_encoder` → `avc_prot_init` →
dblk/ref/assit → `amvenc_start`），三个轮询点（IMEM DMA 忙位、`ENCODER_STATUS`）由模块
替硬件应答。于是**每帧写进寄存器的编码参数可以读回来断言** —— 这些正是 ucode 真正读的
东西。

```
HCV4L2_INSMOD ok            /dev/video0 出来了
Detected Stateful Encoder
1920x1080 NV12 → 1920/1088                      圆到整 MB
1281x721  YU12 → 1296/736  bpl 1344  size 1483776   MFDIN 跨度对齐 64
Total for meson-hcodec device /dev/video0: 48, Succeeded: 48, Failed: 0, Warnings: 0
nohw#1 idr=1 idr_pic_id=0 frame_num=0 poc=0 rec=e6e5e4 anc=e9e8e7 qp=26 qtab=1a1a1a1a
nohw#2 idr=0 idr_pic_id=1 frame_num=1 poc=2 rec=e9e8e7 anc=e6e5e4 qp=27 qtab=1b1b1b1b
nohw#3 idr=0 idr_pic_id=1 frame_num=2 poc=4 rec=e6e5e4 anc=e9e8e7 qp=26 qtab=1a1a1a1a
```

三行 `nohw#` 是脚本硬断言的，逐项都对得上厂商源码：`frame_num` 0/1/2 与 POC 0/2/4
递增（IDR 那帧写 0），刚写完的 dblk 缓冲区变成下一帧的参考帧（`rec`↔`anc` 互换，
基址是厂商的 `AMVENC_CANVAS_INDEX = 0xE4`），QP 表尾字等于本帧 QP 重复四次 ——
`qp=27 → 1b1b1b1b` 顺带证明 `hc_rate` 的码率反馈真的传到了表里（GXBB+ 的 FULL ucode
只认表里的值）。**所以多帧/P 帧的寄存器编程不再是「只读过代码」。**

**这一趟抓出 6 个真 bug**，其中第 1 个会让板子每次 insmod 都挂：

| # | 症状 | 真因 |
| --- | --- | --- |
| 1 | insmod 当场 oops，`pc : v4l2_device_register+0x60` | `hc_pdev` 是 `register_simple` 出来的，`dev->driver` 是空的；名字留空时 `v4l2_device_register` 会去读 `dev->driver->name`。**必须自己 `strscpy` 名字** |
| 2 | `test second /dev/video0 open: FAIL` | 独占闸设在 `open()` 上。挪到 `hc_start_streaming`（gstreamer 探测设备也需要能多开） |
| 3 | `codec_mask & STATEFUL_ENCODER` 判失败，连带三条「H264 not reported by ENUM_FMT」 | 少了 `VIDIOC_ENUM_FRAMESIZES` —— stateful 编码器强制要求 |
| 4 | `fmt_out.g_colorspace() != col` | colorimetry 硬编码成 REC709。要原样收下再带到 CAPTURE |
| 5 | 找不到 `V4L2_CID_MIN_BUFFERS_FOR_OUTPUT` | 控件漏了 |
| 6 | `stage=1` 时没有 `/dev/videoN` | 早退路径没走到注册；改成 `goto reg` |

验不上的只有 ucode 和真码流：HCODEC 的 MMIO 在 QEMU 里不存在，碰一下就是同步外部
abort（`hc_poweron+0x20` 实测），也没有 AMRISC 去执行厂商序列，所以 `VLC_TOTAL_BYTES`
恒为 0。**真码流只能实机验** —— 上面「两个真 bug」那一节就是这一格的结果，
两个都是 QEMU 断言不到的（signal 出去的 QP 对不对，只有解码器说得准）。

另外记一笔踩了三轮的坑：`v4l2-ctl` 每帧从文件读的字节数是 **mmap 缓冲区长度**
（`read_one_frame` 用 `q.g_length(j)`），而 vb2 会把它 `PAGE_ALIGN`。640x480 NV12 =
460800 不是页整数倍，读第二帧就跨过文件尾，只喂得进一帧；改成 640x512（491520 = 120
页）才对得齐。缓冲区数也要显式 `--stream-out-mmap 4`，否则 v4l2-ctl 拿
`MIN_BUFFERS_FOR_OUTPUT`（我们报 1）当数量，同样只有一帧。

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

五个绕不开的实现约束（前四条是读厂商源码读出来的，第五条是实机测出来的）：

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
5. **`slice_qp_delta ≡ 0`，且 `mb_qp_delta` 必须夹成 0**（见上面「两个真 bug」）。
   连带两条：QP 只能在 IDR 换，`ENCODER_NON_IDR` 之后 ucode 报的是
   `ENCODER_IDR_DONE(9)` 不是 `NON_IDR_DONE(10)`，两个状态得互认，只等 10 会超时。

`device_run` 只 `queue_work`：`hc_wait` 要睡，而且 `v4l2_m2m_job_finish` 会当场
回调下一轮，直接在里面编会递归（vim2m 的做法）。完成信号除了轮询
`ENCODER_STATUS`，还要认 `HCODEC_ASSIST_MBOX2_IRQ_REG` 位 0 并写
`HCODEC_IRQ_MBOX_CLR`（厂商的 ISR 就干这个；不清的话下一帧的状态可能是上一帧的）。

**实机复现（2026-09-05，`/dev/video1`，`meson_vdec` 占了 video0）**：

```sh
modprobe v4l2-mem2mem videobuf2-dma-contig && insmod meson_hcodec.ko dbg=1
# 控件和 streaming 必须同一次调用，控件名带 _value 后缀
v4l2-ctl -d /dev/video1 \
  --set-fmt-video-out=width=1280,height=768,pixelformat=NV12 \
  --set-fmt-video=width=1280,height=768,pixelformat=H264 \
  --set-ctrl=video_gop_size=10,h264_minimum_qp_value=26,h264_maximum_qp_value=26,\
h264_i_frame_qp_value=26,h264_p_frame_qp_value=26 \
  --stream-out-mmap 4 --stream-mmap --stream-count 10 \
  --stream-from /tmp/pan.nv12 --stream-to /tmp/gop10.h264
```

板上没有 ffmpeg/ffprobe，码流 scp 回来解：IDR 54.8 dB，9 个 P 帧 52.9→49.2 dB
且**不发散**（maxerr ≤ 14）。逐 MB QP 图用 `ffmpeg -debug qp -i x.h264 -f null -`
看，现在整帧是平的 26。

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
