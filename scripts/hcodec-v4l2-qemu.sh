#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# 不用板子验证 meson_hcodec：拿冻结内核包里的真 Image 在 QEMU virt 上起一个
# initramfs，insmod 模块（nohw=1，四个 MMIO 窗口换成 RAM），然后跑 v4l2-ctl /
# v4l2-compliance，并把 IDR/P/P 三帧真的推过 /dev/video0。
#
# 能验的：模块能不能加载、/dev/videoN 出不出来、格式协商（16 对齐、MFDIN 跨度）、
# 控件范围、缓冲区分配、ioctl 状态机，以及**每帧写进寄存器的编码参数**——
# nohw 下 dos 窗口是 RAM，所以编完能把 ucode 本该读到的值读回来断言：
# frame_num / POC 递增、dblk↔ref canvas 互换、QP 表按帧重填。
# 验不上的：ucode 和真码流 —— HCODEC 的 MMIO 在 QEMU 里根本不存在（碰一下就是
# 同步外部 abort），没有 AMRISC 去执行序列，所以帧长度恒为 0。
# 真码流只能实机跑（见 docs/hcodec-encoder-plan.md）。
#
#   scripts/hcodec-v4l2-qemu.sh [工作目录]
set -Eeuo pipefail

work=${1:-/tmp/hcqemu}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bundle_url=https://github.com/ophub/kernel/releases/download/kernel_stable/5.10.268.tar.gz
bundle_sha=d3559323a4812600ab8f2bd0156d2b863c9b1ea3627d59d64890b8498621e49f
release=5.10.268-ophub

command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
mkdir -p "$work"

# 1) 冻结内核包 —— Image / modules / config 都从这里来
if [[ ! -f "$work/bundle.tar.gz" ]]; then
  echo '==> 下载冻结内核包'
  curl -fsSL -o "$work/bundle.tar.gz.part" "$bundle_url"
  mv "$work/bundle.tar.gz.part" "$work/bundle.tar.gz"
fi
got=$(shasum -a 256 "$work/bundle.tar.gz" 2>/dev/null || sha256sum "$work/bundle.tar.gz")
[[ ${got%% *} == "$bundle_sha" ]] || { echo "内核包 sha256 不对：${got%% *}" >&2; exit 1; }

if [[ ! -f "$work/boot/vmlinuz-$release" ]]; then
  echo '==> 解包'
  ( cd "$work" && tar xzf bundle.tar.gz \
      "5.10.268/boot-$release.tar.gz" "5.10.268/modules-$release.tar.gz" \
      "5.10.268/header-$release.tar.gz" )
  mkdir -p "$work/boot" "$work/mods" "$work/hdr"
  tar xzf "$work/5.10.268/boot-$release.tar.gz" -C "$work/boot"
  tar xzf "$work/5.10.268/modules-$release.tar.gz" -C "$work/mods"
  tar xzf "$work/5.10.268/header-$release.tar.gz" -C "$work/hdr"
fi

# 2) 厂商 GPL 切片（下载一次就缓存）+ 本仓库的模块源码（每次都覆盖，不然改了
#    源码却编的是上一轮的）
[[ -f "$work/build/venc.c" ]] || "$root/tools/hcenc/fetch-vendor.sh" "$work/build"
cp "$root/tools/hcenc/"{hcenc.c,kshim.h,venc_defs.h} "$work/build/"
cp "$root/tools/hcodec-mod/"{meson_hcodec.c,kmshim.h,Makefile} "$work/build/"

# 3) 剩下的全在 arm64 容器里做：编模块 → 造 initramfs → 跑 QEMU
#    头文件树自带的 fixdep/modpost 是 aarch64 ELF，所以容器必须是 arm64，
#    这样原生编，不用交叉工具链。
cat >"$work/inner.sh" <<'INNER'
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq build-essential bc libelf1 busybox-static v4l-utils \
  qemu-system-arm cpio gzip kmod >/dev/null

echo "==> gcc $(gcc -dumpfullversion)"
make -C /hdr M=/build ARCH=arm64 modules >/tmp/make.log 2>&1 || { tail -40 /tmp/make.log; exit 1; }
grep -E 'warning|error' /tmp/make.log && { echo '编译有告警/报错'; exit 1; } || echo '==> 模块编译干净'
modinfo /build/meson_hcodec.ko | grep -E '^(vermagic|depends)'

ir=/tmp/ir
mkdir -p "$ir"/{bin,sbin,proc,sys,dev,tmp,lib,usr/bin,usr/sbin}
cp /bin/busybox "$ir/bin/"
ln -sf busybox "$ir/bin/sh"
cp /build/meson_hcodec.ko "$ir/lib/"
cp /mods/*/kernel/drivers/media/v4l2-core/v4l2-mem2mem.ko "$ir/lib/"
cp /mods/*/kernel/drivers/media/common/videobuf2/videobuf2-dma-contig.ko "$ir/lib/"

# v4l2-ctl / v4l2-compliance 是动态链接的，把它们和依赖库一起搬进去
for b in /usr/bin/v4l2-ctl /usr/bin/v4l2-compliance; do
  cp "$b" "$ir/usr/bin/"
  ldd "$b" | awk '/=>/ {print $3} /ld-linux/ {print $1}' | sort -u | while read -r so; do
    [[ -f "$so" ]] || continue
    mkdir -p "$ir$(dirname "$so")"
    cp -n "$so" "$ir$so"
  done
done

cat >"$ir/init" <<'EOF'
#!/bin/sh
/bin/busybox --install -s /bin
mount -t proc none /proc
mount -t sysfs none /sys
mount -t devtmpfs none /dev
echo "HCV4L2_BOOT $(uname -r)"
insmod /lib/videobuf2-dma-contig.ko && insmod /lib/v4l2-mem2mem.ko \
  && echo 'HCV4L2_DEPS ok' || echo 'HCV4L2_DEPS fail'
insmod /lib/meson_hcodec.ko stage=1 selftest=0 poweron=0 marklog= nohw=1 \
  && echo 'HCV4L2_INSMOD ok' || echo 'HCV4L2_INSMOD fail'
ls -l /dev/video0 2>&1
echo '---- v4l2-ctl --all ----'
v4l2-ctl -d /dev/video0 --all 2>&1
echo '---- 1920x1080 应该被圆到 1088 ----'
v4l2-ctl -d /dev/video0 --set-fmt-video-out=width=1920,height=1080,pixelformat=NV12 \
  --get-fmt-video-out 2>&1
echo '---- 1281x721 应该被圆到 1296x736，YUV420 跨度对齐 64 ----'
v4l2-ctl -d /dev/video0 --set-fmt-video-out=width=1281,height=721,pixelformat=YU12 \
  --get-fmt-video-out 2>&1
echo '---- IDR/P/P 三帧过一遍真路径（640x512 NV12，gop 默认 30）----'
v4l2-ctl -d /dev/video0 --set-fmt-video-out=width=640,height=512,pixelformat=NV12 \
  --get-fmt-video-out 2>&1
# 分辨率取 640x512 是有讲究的：v4l2-ctl 每帧从文件读的是 **mmap 缓冲区长度**
# （read_one_frame 用 q.g_length(j)，不是 sizeimage），而 vb2 会把长度 PAGE_ALIGN。
# 640x480 NV12 = 460800 不是页整数倍，读第二帧就跨过文件尾了；640x512 = 491520
# = 120 页整整好。--stream-out-mmap 也要显式给 4：不给的话 v4l2-ctl 拿
# MIN_BUFFERS_FOR_OUTPUT（我们报 1）当缓冲区数，只喂得进一帧。
# 于是 STREAMON 之前 3 帧全进队列（第 3 帧上 --stream-count 归零 → QUEUE_STOPPED），
# v4l2-ctl 随即发 ENC_CMD_STOP，三帧一起 drain。
dd if=/dev/zero of=/tmp/in.nv12 bs=491520 count=6
v4l2-ctl -d /dev/video0 --stream-mmap --stream-out-mmap 4 --stream-count 3 \
  --stream-from /tmp/in.nv12 --stream-to /tmp/out.h264 2>&1
ls -l /tmp/out.h264 2>&1
echo '---- v4l2-compliance ----'
v4l2-compliance -d /dev/video0 2>&1
echo "HCV4L2_DONE"
poweroff -f
EOF
chmod +x "$ir/init"
( cd "$ir" && find . | cpio -o -H newc --quiet | gzip -1 >/tmp/ir.gz )

echo '==> QEMU virt / cortex-a53 / TCG'
timeout 900 qemu-system-aarch64 -M virt,gic-version=2 -cpu cortex-a53 -m 2048 -smp 2 \
  -nographic -monitor none -serial stdio -nic none -no-reboot \
  -kernel /boot/vmlinuz-KREL -initrd /tmp/ir.gz \
  -append 'console=ttyAMA0,115200 earlycon=pl011,0x09000000 rdinit=/init loglevel=7 cma=256M' \
  2>&1 | tee /out/console.log || true
INNER
sed -i.bak "s/vmlinuz-KREL/vmlinuz-$release/" "$work/inner.sh" && rm -f "$work/inner.sh.bak"

docker run --rm --platform linux/arm64 \
  -v "$work/hdr:/hdr" -v "$work/build:/build" -v "$work/boot:/boot:ro" \
  -v "$work/mods:/mods:ro" -v "$work:/out" -v "$work/inner.sh:/inner.sh:ro" \
  debian:trixie bash /inner.sh

log=$work/console.log
echo
echo "==> console log: $log"
for marker in HCV4L2_BOOT 'HCV4L2_DEPS ok' 'HCV4L2_INSMOD ok' HCV4L2_DONE; do
  grep -q "$marker" "$log" || { echo "缺标记：$marker" >&2; exit 1; }
done
if grep -qE 'Total for meson-hcodec device .*Failed: 0,' "$log"; then
  grep -E 'Total for meson-hcodec' "$log"
else
  echo '==> v4l2-compliance 有失败项：' >&2
  grep -E '^\s*(fail|Total for)|fail:' "$log" >&2 || true
  exit 1
fi

# IDR/P/P 的每帧寄存器编程。这几个值是 ucode 真正读的东西：frame_num 和 POC 必须
# 按 0/0 → 1/2 → 2/4 递增（IDR 自己那帧写 0），刚写好的 dblk 缓冲区要变成下一帧的
# 参考帧（rec↔anc 互换），canvas 基址是厂商的 0xE4。
want1='nohw#1 idr=1 idr_pic_id=0 frame_num=0 poc=0 rec=e6e5e4 anc=e9e8e7'
want2='nohw#2 idr=0 idr_pic_id=1 frame_num=1 poc=2 rec=e9e8e7 anc=e6e5e4'
want3='nohw#3 idr=0 idr_pic_id=1 frame_num=2 poc=4 rec=e6e5e4 anc=e9e8e7'
for want in "$want1" "$want2" "$want3"; do
  grep -q "$want" "$log" || {
    echo "==> 帧序列不对，缺：$want" >&2
    grep -E 'nohw#' "$log" >&2 || echo '（一行 nohw# 都没有：三帧根本没编）' >&2
    exit 1
  }
done
grep -E 'nohw#' "$log"

# QP 表是每帧重填的（GXBB+ 的 FULL ucode 只认表里的值，不认 avc_prot_init 的
# quant 参数），所以表尾那个字必须等于本帧 QP 重复四次。
grep -oE 'nohw#[0-9]+ .*qp=[0-9]+ qtab=[0-9a-f]{8}' "$log" | while read -r line; do
  q=${line##*qp=}; q=${q%% *}
  want=$(printf '%02x%02x%02x%02x' "$q" "$q" "$q" "$q")
  [[ ${line##*qtab=} == "$want" ]] || {
    echo "==> QP 表没跟上：qp=$q 期望 qtab=$want，实际 ${line##*qtab=}" >&2
    exit 1
  }
done || exit 1
echo '==> V4L2 协议 + IDR/P/P 每帧寄存器编程，在 QEMU 上全过（无真码流：没有 ucode）'
