#!/usr/bin/env bash
set -Eeuo pipefail

# 把树外的 H.264 硬件编码模块 meson_hcodec.ko 编出来放到 <outdir>。
#
# 为什么要在构建包的时候编：mainline 5.10 一行 Amlogic 编码代码都没有
# （meson-vdec 只解码），所以硬编只能靠这个树外模块。它不进内核也不进 initrd，
# 只是 rootfs 里的一个 .ko —— 刷完机就能 modprobe，见 apply-rootfs-defaults.sh §7。
#
# 为什么能在 x86 的 runner 上编：冻结的内核包里那份 header-<release>.tar.gz 就是
# 板上的 /usr/src/linux-headers-<release>，vermagic 和板子逐字一致。它自带的
# scripts/basic/fixdep、scripts/mod/modpost 是 **aarch64 ELF**，在 x86 上跑不了，
# 但源码也在同一个目录里 —— 拿 host 的 cc 重编这两个小工具，再
# ARCH=arm64 CROSS_COMPILE= 交叉编模块，实测 9 秒。
# （在 arm64 机器上原生编也走同一条路，只是 CROSS_COMPILE 为空。）
#
# 厂商那几片 GPL-2.0 代码不入库，由 tools/hcenc/fetch-vendor.sh 按钉死的 sha256
# 现取，见 THIRD_PARTY_SOURCES.md。
#
# usage: scripts/build-hcodec-module.sh <outdir>
# env:   HCODEC_KERNEL_TARBALL=<路径>  已经下好的 5.10.268.tar.gz，省掉 80 MB 下载

usage() { echo "usage: $0 outdir" >&2; exit 2; }
[[ $# -eq 1 ]] || usage
out=$(mkdir -p "$1" && cd -- "$1" && pwd)
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

for command in curl node tar make cc; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

# 交叉前缀：host 已经是 aarch64 就不用交叉。
cross=''
if [[ "$(uname -m)" != aarch64 && "$(uname -m)" != arm64 ]]; then
  cross=aarch64-linux-gnu-
  command -v "${cross}gcc" >/dev/null || {
    echo "${cross}gcc is required to cross-build the module (apt install gcc-aarch64-linux-gnu)" >&2
    exit 1
  }
fi

# ---- 1. 拿冻结的内核包 --------------------------------------------------
read -r kernel_url kernel_digest kernel_version < <(node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).kernel;
  for (const key of ["repository", "releaseTag", "version", "digest"]) {
    if (typeof s?.[key] !== "string" || !s[key]) throw new Error(`sources.json kernel.${key} is missing`);
  }
  if (!/^[0-9a-f]{64}$/.test(s.digest)) throw new Error("sources.json kernel.digest is invalid");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(s.version)) throw new Error("sources.json kernel.version is invalid");
  if (!/^[A-Za-z0-9._\/-]+$/.test(s.repository)) throw new Error("sources.json kernel.repository is invalid");
  console.log([
    `https://github.com/${s.repository}/releases/download/${s.releaseTag}/${s.version}.tar.gz`,
    s.digest, s.version,
  ].join(" "));
' "$root/config/sources.json")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tarball=${HCODEC_KERNEL_TARBALL-}
if [[ -z "$tarball" ]]; then
  tarball="$work/kernel.tar.gz"
  curl -fsSL --retry 3 --retry-delay 2 "$kernel_url" -o "$tarball"
fi
# 摘要用 node 算：macOS 自带的 sha256sum 没有 --check，而 node 本来就是必需依赖。
node -e '
  const fs = require("fs"), crypto = require("crypto");
  const [file, want] = process.argv.slice(1);
  const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (got !== want) {
    console.error(`frozen kernel package digest mismatch\n  want ${want}\n  got  ${got}`);
    process.exit(1);
  }
' "$tarball" "$kernel_digest"

# 内核 release（vermagic 的头一段）就写在头文件包的名字里，别硬编。
header_entry=$(tar tzf "$tarball" | grep -E "^${kernel_version}/header-.*\.tar\.gz$" | head -n1)
[[ -n "$header_entry" ]] || { echo "no header-*.tar.gz inside $kernel_url" >&2; exit 1; }
release=${header_entry##*/header-}
release=${release%.tar.gz}
[[ "$release" == "$kernel_version"-* ]] || {
  echo "unexpected kernel release in the frozen package: $release" >&2
  exit 1
}

mkdir -p "$work/hdr" "$work/build"
tar xzf "$tarball" -O "$header_entry" | tar xz -C "$work/hdr"
[[ -f "$work/hdr/Makefile" && -f "$work/hdr/Module.symvers" ]] || {
  echo "the header tree looks incomplete: $header_entry" >&2
  exit 1
}

# ---- 2. 拼源码：本目录 + 厂商 GPL 切片 ---------------------------------
"$root/tools/hcenc/fetch-vendor.sh" "$work/build" >/dev/null

# ---- 3. host 工具重编，然后交叉编模块 ----------------------------------
# 头文件包里带的是 aarch64 的 fixdep/modpost，x86 上 exec 不了（native 时重编也
# 无害）。scripts_basic 那个 make 目标要 .config，而头文件包只有
# include/config/auto.conf，所以直接 cc 这两个自包含的小程序，别绕 kbuild。
( cd "$work/hdr"
  rm -f scripts/basic/fixdep scripts/mod/modpost scripts/mod/mk_elfconfig scripts/mod/*.o
  cc -O2 -o scripts/basic/fixdep scripts/basic/fixdep.c
  cc -O2 -Iscripts/mod -o scripts/mod/modpost \
    scripts/mod/modpost.c scripts/mod/file2alias.c scripts/mod/sumversion.c )
make -s -C "$work/hdr" ARCH=arm64 CROSS_COMPILE="$cross" M="$work/build" modules

# ---- 4. 断言：vermagic 必须就是这颗内核 --------------------------------
ko="$work/build/meson_hcodec.ko"
[[ -f "$ko" ]] || { echo 'the module did not build' >&2; exit 1; }
vermagic=$(strings "$ko" | sed -n 's/^vermagic=//p' | head -n1)
[[ "$vermagic" == "$release "* ]] || {
  echo "module vermagic does not match the frozen kernel: '$vermagic' vs '$release'" >&2
  exit 1
}
depends=$(strings "$ko" | sed -n 's/^depends=//p' | head -n1)
# 这两个在 ophub 内核里是 =m，modprobe 靠 depmod 出来的 modules.dep 自己带上。
[[ "$depends" == *v4l2-mem2mem* && "$depends" == *videobuf2-dma-contig* ]] || {
  echo "unexpected module dependencies: '$depends'" >&2
  exit 1
}

cp "$ko" "$out/meson_hcodec.ko"
printf '%s\n' "$release" > "$out/kernel-release"
echo "  hcodec: meson_hcodec.ko $(wc -c <"$out/meson_hcodec.ko" | tr -d ' ') 字节，vermagic=$vermagic"
