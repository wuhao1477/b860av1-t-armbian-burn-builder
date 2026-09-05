# meson_hcodec — 树外 H.264 硬件编码内核模块

把 [`../hcenc/`](../hcenc/) 那个 `/dev/mem` 原型搬进内核，再包成 V4L2 stateful
M2M 编码器。对应 [`../../docs/hcodec-encoder-plan.md`](../../docs/hcodec-encoder-plan.md)
的阶段 1a（insmod 自测）+ 1b（`/dev/videoN`）。

- **1a 已实机验证（2026-09-05）**：insmod 时在内核里编出 1280x720 Baseline IDR，
  4432 / 4597 / 4499 字节（热载 / `rmmod` 后冷载 / 开机从未上电），
  `ffprobe` 认 `key_frame=1 pict_type=I`。
- **1b 已编译通过（2026-09-05）**，等实机验证：`vermagic 5.10.268-ophub SMP
  preempt mod_unload aarch64`、`depends v4l2-mem2mem,videobuf2-dma-contig`，
  `W=1` 零告警。`ffmpeg -c:v h264_v4l2m2m` / `gst v4l2h264enc` 零补丁能用。

## 不用板子也能编

冻结的内核包里那份 `header-5.10.268-ophub.tar.gz` 就是板上的
`/usr/src/linux-headers-5.10.268-ophub`，而且它自带的 `scripts/fixdep` /
`scripts/mod/modpost` 是 **aarch64 ELF** —— 在 arm64 容器里原生跑，
不用交叉编译，也不用 `make prepare`：

```bash
curl -fsSLo /tmp/k.tar.gz \
  https://github.com/ophub/kernel/releases/download/kernel_stable/5.10.268.tar.gz
tar xzf /tmp/k.tar.gz -O 5.10.268/header-5.10.268-ophub.tar.gz | tar xz -C /tmp/hdr
tools/hcenc/fetch-vendor.sh /tmp/hcbuild
docker run --rm --platform linux/arm64 -v /tmp/hdr:/hdr -v /tmp/hcbuild:/build \
  debian:trixie bash -c 'apt-get update -qq && apt-get install -y -qq \
  build-essential bc libelf1 && make -C /hdr M=/build ARCH=arm64 modules'
```

`debian:trixie` 的 gcc 是 14.2.0，和板上一致；vermagic 不编码 gcc 版本，
MODVERSIONS 和签名都没开，所以出来的 `.ko` 直接 `insmod` 就行。

## 编译并加载

```bash
tools/hcenc/fetch-vendor.sh /tmp/hcbuild        # GPL 切片 + 本目录源码，都拼过去
scp -r /tmp/hcbuild root@<board>:/root/hcbuild
ssh root@<board> '
  make -C /lib/modules/$(uname -r)/build M=/root/hcbuild modules
  modprobe v4l2-mem2mem videobuf2-dma-contig    # 这两个在 ophub 内核里是 =m
  insmod /root/hcbuild/meson_hcodec.ko
  dmesg | tail -20'
```

`videodev` / `videobuf2-core` / `videobuf2-v4l2` 在这颗内核里是 `=y`，不用管；
`v4l2-mem2mem` 和 `videobuf2-dma-contig` 是 `=m`，**必须先 modprobe**，
否则 `insmod` 报 unknown symbol。

## 模块参数

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `width` / `height` | 1280 / 720 | 自测帧尺寸，也是 V4L2 的初始几何 |
| `qp` | 26 | 固定 QP，也是 `I_FRAME_QP` 控件的初值 |
| `selftest` | 1 | insmod 时编一帧合成 IDR 到 debugfs |
| `stage` | 9 | 只跑到第 N 步：1 映射 2 上电 3 scratch 4 ucode 5 起 AMRISC 6 编一帧 |
| `marklog` | `/root/hcodec-stage.log` | 每步落盘 + fsync 一行；硬挂重启后最后一行就是挂住的那步 |
| `poweron` | 1 | 自己做上电序列 |
| `blanket_reset` | 0 | 用厂商的 `DOS_SW_RESET1=0xffffffff`（会打断正在解码的 vdec） |

自测码流：`cat /sys/kernel/debug/meson-hcodec/out.h264 > /tmp/out.h264`。

## 试 V4L2

```bash
v4l2-ctl -d /dev/video0 --all
ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -t 5 \
       -pix_fmt nv12 -c:v h264_v4l2m2m -b:v 4M /tmp/t.h264
ffprobe -show_frames -select_streams v /tmp/t.h264 | grep -c key_frame=1
```

## 三个不能动的地方

1. **宽高一律圆到 16 的倍数**（1080 → 1088）。ucode 按整 MB 编，厂商驱动里
   也没有 SPS `frame_cropping`（`crop_*` 只喂 ge2d 缩放器），所以没法只裁显示区。
2. **每帧都要整套重新初始化。** 厂商 ISR 在每个 `*_DONE` 之后置 `need_reset`
   （venc.c:2928），所以 `avc_init_encoder()` 每帧都跑 —— 它是
   `IDR_PIC_ID` / `FRAME_NUMBER` / `PIC_ORDER_CNT_LSB` / `QPPICTURE` 和
   `VLC_TOTAL_BYTES=0` 的唯一写入者。省掉它，第二帧的 slice header 就是错的。
3. **QP 走量化表，不走 `avc_prot_init()` 的 `quant` 参数。** GXBB+ 的 FULL
   ucode 会用 `quant_tbl_i4/i16[id][0] & 0xff` 反算 `i_pic_qp`（vendor.inc:1509），
   所以换 QP = 重填三张表（`hc_set_qp()`）。

`PHYSICAL_BUFF` 而不是 `LOCAL_BUFF`：后者会把 `request->src` 强行改成
`dct_buff_start_addr`（vendor.inc:1194），V4L2 递进来的缓冲区就成了摆设。
V4L2 的 `bytesperline` 必须等于 MFDIN 的跨度（NV12/NV21 对齐 32，YUV420 对齐 64）。
