#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# 不用板子验证 meson_hcodec 的 V4L2 那一半：拿冻结内核包里的真 Image 在 QEMU
# virt 上起一个 initramfs，insmod 模块（stage=1，只映射不碰硬件），然后跑
# v4l2-ctl / v4l2-compliance。
#
# 能验的：模块能不能加载、/dev/videoN 出不出来、格式协商（16 对齐、MFDIN 跨度）、
# 控件范围、缓冲区分配、ioctl 状态机。
# 验不上的：ucode 和真编码 —— HCODEC 的 MMIO 在 QEMU 里根本不存在，碰一下就是
# 同步外部 abort，所以模块要带 nohw=1 加载（编出来的帧长度为 0）。
# 真编码只能实机跑（见 docs/hcodec-encoder-plan.md）。
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

# 2) 厂商 GPL 切片 + 本仓库的模块源码，拼到一个目录
[[ -f "$work/build/meson_hcodec.c" ]] || "$root/tools/hcenc/fetch-vendor.sh" "$work/build"

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
mkdir -p "$ir"/{bin,sbin,proc,sys,dev,lib,usr/bin,usr/sbin}
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
echo '==> V4L2 那一半在 QEMU 上全过'
