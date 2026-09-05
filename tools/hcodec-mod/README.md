# meson_hcodec — 树外 H.264 硬件编码内核模块

把 [`../hcenc/`](../hcenc/) 那个 `/dev/mem` 原型搬进内核，再包成 V4L2 stateful
M2M 编码器。对应 [`../../docs/hcodec-encoder-plan.md`](../../docs/hcodec-encoder-plan.md)
的阶段 1a（insmod 自测）+ 1b（`/dev/videoN`）。

- **1a 已实机验证（2026-09-05）**：insmod 时在内核里编出 1280x720 Baseline IDR，
  4432 / 4597 / 4499 字节（热载 / `rmmod` 后冷载 / 开机从未上电），
  `ffprobe` 认 `key_frame=1 pict_type=I`。
- **1b 已实机验证（2026-09-05）**：1280x768 NV12 → H.264，IDR + 9 个 P 帧，
  ffmpeg 解出来对着输入 49.2~54.8 dB 且不发散；单 IDR 在 QP 10/20 上无损
  （99 dB、maxerr 0），QP 26/35/45 是 54.8/47.6/40.9 dB。同一输入连编 10 个 IDR
  全部 54.8 dB、字节数 ±0.4%。`ffmpeg -c:v h264_v4l2m2m` / `gst v4l2h264enc`
  零补丁能用。
- **1b 的 V4L2 那一半在 QEMU 上全过（2026-09-05）**：`v4l2-compliance` 48/48、
  0 failed 0 warnings，`Detected Stateful Encoder`。这一趟抓出 6 个真 bug，
  其中「`v4l2_device_register` 空指针」会让板子每次 insmod 都挂 ——
  跑法见下面的「不用板子也能验」，明细见
  [`../../docs/hcodec-encoder-plan.md`](../../docs/hcodec-encoder-plan.md)。

- **1c 已做进直刷包（2026-09-05）**：`scripts/build-hcodec-module.sh` 在 CI 上现编，
  `apply-rootfs-defaults.sh` §7 装到 `/lib/modules/<release>/extra/` 并 `depmod -b`，
  配上 `/etc/modules-load.d` + `/etc/modprobe.d`（`stage=1 selftest=0`）开机自动加载。
  连续 4 次冷启动都是「起来就有 `/dev/videoN`，首次编码正常」（62174 / 63906 /
  65530 / 65945 字节）。**下面那些手工步骤只有开发时才需要 —— 刷完机就已经加载好了。**

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

## 不用板子也能验

```bash
scripts/hcodec-v4l2-qemu.sh [工作目录]     # 默认 /tmp/hcqemu
```

上面那套编译 + 在 QEMU virt / cortex-a53 上拿同一个真 `Image` 起 initramfs，
`nohw=1` 加载模块，跑 `v4l2-ctl` 和 `v4l2-compliance`，并把 IDR/P/P 三帧真的推过
`/dev/video0`。全过的标志是 `Failed: 0` 加三行 `nohw#`。`nohw=1` 时四个 MMIO 窗口
换成 `vzalloc` 的 RAM，**厂商那整套寄存器序列照跑**，所以能把 ucode 本该读到的值
读回来断言（`frame_num`/POC 递增、dblk↔ref canvas 互换、QP 表按帧重填）。
验不上的只有 ucode 和真码流 —— HCODEC 的 MMIO 在 QEMU 里不存在（碰一下就是同步
外部 abort），没有 AMRISC 去执行序列，所以帧长度恒为 0。

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
| `nohw` | 0 | 假硬件：4 个 MMIO 窗口换成 RAM，轮询点自己应答，码流长度为 0（QEMU 上验寄存器编程用） |
| `blanket_reset` | 0 | 用厂商的 `DOS_SW_RESET1=0xffffffff`（会打断正在解码的 vdec） |
| `dbg` | 0 | 每帧打一行 `idr= qp= total= vb=→` 和输入 Y 校验和；卡死时还会多打两条环占用 + 停在哪个宏块 |
| `waitms` | 300 | 等一帧编完的上限。编通一帧实测 7 ms，超了就是 ucode 卡死，驱动会抬 QP 重编 |

自测码流：`cat /sys/kernel/debug/meson-hcodec/out.h264 > /tmp/out.h264`。
编码器自己的重建帧（查错用，跟解码结果对比就能分清是量化错还是 signal 错）：
`cat /sys/kernel/debug/meson-hcodec/rec.y`，`ALIGN(w,32) × ALIGN(h,16)` 的 Y 平面。

## 试 V4L2

`meson_vdec` 会先占掉 `/dev/video0`，我们通常是 `video1`，先 `v4l2-ctl --list-devices` 看。

```bash
v4l2-ctl -d /dev/video1 --all
ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -t 5 \
       -pix_fmt nv12 -c:v h264_v4l2m2m -b:v 4M /tmp/t.h264
ffprobe -show_frames -select_streams v /tmp/t.h264 | grep -c key_frame=1
```

用 `v4l2-ctl` 手动推帧时有两个坑：

1. **`--set-ctrl` 必须和 `--stream-mmap` 在同一次调用里。** 控件挂在 file handle
   上，另起一次调用等于全恢复默认。控件名带 `_value` 后缀
   （`h264_i_frame_qp_value`、`h264_minimum_qp_value` …），`v4l2-ctl -L` 能列。
2. **分辨率要让 `sizeimage` 是 4096 的整数倍**，且 `--stream-out-mmap N` 要显式给
   数量。`v4l2-ctl` 每帧按 mmap 缓冲区长度（vb2 `PAGE_ALIGN` 过的）读文件，
   否则读第二帧就跨过文件尾，只喂得进一帧。1280x768 NV12 = 1474560 = 360 页，对齐。

## 四个不能动的地方

1. **宽高一律圆到 16 的倍数**（1080 → 1088）。ucode 按整 MB 编，厂商驱动里
   也没有 SPS `frame_cropping`（`crop_*` 只喂 ge2d 缩放器），所以没法只裁显示区。
2. **每帧都要整套重新初始化。** 厂商 ISR 在每个 `*_DONE` 之后置 `need_reset`
   （venc.c:2928），所以 `avc_init_encoder()` 每帧都跑 —— 它是
   `IDR_PIC_ID` / `FRAME_NUMBER` / `PIC_ORDER_CNT_LSB` / `QPPICTURE` 和
   `VLC_TOTAL_BYTES=0` 的唯一写入者。省掉它，第二帧的 slice header 就是错的。
3. **QP 走量化表，不走 `avc_prot_init()` 的 `quant` 参数。** GXBB+ 的 FULL
   ucode 会用 `quant_tbl_i4/i16[id][0] & 0xff` 反算 `i_pic_qp`（vendor.inc:1509），
   所以换 QP = 重填三张表（`hc_set_qp()`）。
4. **`HCODEC_QDCT_VLC_QUANT_CTL_1 = 0`，而且 QP 只能在 IDR 换。** ucode 把
   `slice_qp_delta` 恒写 0（PPS 的 `pic_init_qp` 就是整个 GOP 的 slice QP），又把
   自己不用的 per-MB `mb_qp_delta` 写进码流。厂商那个 ±26/25 的幅度留着的话，
   同一输入的 10 个 IDR 解出来 7~26 dB 且每次不同；夹成 0 之后全部 51.8 dB。
   连带一条：`ENCODER_NON_IDR` 之后 ucode 报的是 `IDR_DONE(9)`，两个 DONE 得互认。
   代价是码率控制只能在 IDR 边界生效，`h264_p_frame_qp_value` 表达不出来。
5. **卡死了只能抬 QP 重编。** 帧里有「太贵」的宏块时，ucode 会原地卡死在
   `ENCODER_MB_HEADER`（宏块位置冻住、AMRISC 的 PC 还在打转，两条环都不满）。
   加时间、腾 VLC 环、替它应答 `*_DONE`、换 `IE_ME_MB_TYPE`、补回厂商的 SAD 率项，
   全都叫不醒 —— 完整的排除清单在
   [`../../docs/hcodec-encoder-plan.md`](../../docs/hcodec-encoder-plan.md)。
   `hc_work()` 因此在 `-ETIMEDOUT` 上把 QP 抬 4 重编（并强制成 IDR 以重发 PPS），
   抬过就记住下限；换分辨率时清掉。1280x768 要 QP26 会自己退到 QP34，40 dB 出片。

`PHYSICAL_BUFF` 而不是 `LOCAL_BUFF`：后者会把 `request->src` 强行改成
`dct_buff_start_addr`（vendor.inc:1194），V4L2 递进来的缓冲区就成了摆设。
V4L2 的 `bytesperline` 必须等于 MFDIN 的跨度（NV12/NV21 对齐 32，YUV420 对齐 64）。
