#!/usr/bin/env bash
set -Eeuo pipefail

# 把 meson-vdec 的解码微码下到 <outdir>，逐个校验 sha256。
#
# 为什么要单独下：上游 Armbian raw 镜像里 /lib/firmware/meson/ 整个目录都不存在
# （实机确认），而 meson-vdec 在 VIDIOC_STREAMON 时才 request_firmware ——
# 缺了就是 `Direct firmware load for meson/vdec/gxl_h264.bin failed with error -2`
# 后面跟一个 -EINVAL，`/dev/video0` 照样在，看不出来是固件的事。
#
# 为什么不入库：本仓库只放源码（CI 的 inspectTrackedFiles 盯着），而且这几个
# .bin 是 Amlogic 的可再分发二进制，不是 MIT。钉死 commit + sha256 就够可追溯。
#
# usage: scripts/fetch-vdec-firmware.sh <outdir>

usage() { echo "usage: $0 outdir" >&2; exit 2; }
[[ $# -eq 1 ]] || usage
out=$1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

for command in curl node; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

mkdir -p "$out"
# 一行一个 "文件名 sha256 url"。node 来读 JSON，免得在 bash 里手搓解析。
# 用 while-read 不用 mapfile：mapfile 要 bash 4+，macOS 自带的是 3.2，
# 而这个脚本本地手工跑也得能跑（真构建在 Linux 上）。
count=0
while read -r file digest url; do
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$out/$file"
  # 用 node 算摘要不用 sha256sum：macOS 自带那个 sha256sum 没有 --check，
  # 而 node 本来就是必需依赖。校验失败让 node 自己非零退出，set -e 接住。
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const [file, want] = process.argv.slice(1);
    const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (got !== want) {
      console.error(`vdec firmware digest mismatch: ${file}\n  want ${want}\n  got  ${got}`);
      process.exit(1);
    }
  ' "$out/$file" "$digest"
  echo "  vdec-fw: $file $(wc -c <"$out/$file" | tr -d ' ') 字节，sha256 已核对"
  count=$((count + 1))
done < <(node -e '
  const fs = require("fs");
  const board = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const spec = board.vdecFirmware;
  if (!spec || typeof spec.commit !== "string" || !/^[0-9a-f]{40}$/.test(spec.commit)) {
    throw new Error("board.json vdecFirmware.commit is invalid");
  }
  const files = Object.entries(spec.files ?? {});
  if (files.length === 0) throw new Error("board.json vdecFirmware.files is empty");
  for (const [file, digest] of files) {
    // 文件名要进 URL 也要进路径，只放白名单字符。
    if (!/^[a-z0-9_]+\.bin$/.test(file)) throw new Error(`firmware file name is invalid: ${file}`);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`firmware digest is invalid: ${file}`);
    const url = spec.urlTemplate.replace("{file}", file).replace("{commit}", spec.commit);
    console.log(`${file} ${digest} ${url}`);
  }
' "$root/config/board.json")
# 进程替换的失败不会被 pipefail 抓到，所以自己数一遍：一个都没下等于清单没读出来。
[[ "$count" -gt 0 ]] || { echo 'no vdec firmware was fetched: board.json vdecFirmware unreadable?' >&2; exit 1; }
