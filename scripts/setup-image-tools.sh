#!/usr/bin/env bash
set -Eeuo pipefail

# 把 ampack 和 gxlimg 按 config 里钉死的 commit 编出来，放进一个目录。
#
# 直刷相关的脚本都从 PATH 找这两个工具（可用 AMPACK / GXLIMG 覆盖），但仓库里
# 原本没有获取它们的入口 —— 新 clone 下来直接跑 build/validate 会停在
# "ampack is required"。这个脚本补上这一步。
#
#   eval "$(scripts/setup-image-tools.sh)"      # 装好并把它加进当前 shell 的 PATH
#   scripts/build-vendor-boot-burn.sh <src> out
#
# 默认装到 .tools/bin（已在 .gitignore 里）。传参可以换目录。

prefix=${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/.tools}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bin="$prefix/bin"
mkdir -p "$bin"

for command in git make cargo node; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

pinned() {
  node -e '
    const fs = require("node:fs");
    const [, file, key] = process.argv;
    const value = JSON.parse(fs.readFileSync(file, "utf8"))[key];
    console.log(`${value.repository}\n${value.commit}`);
  ' "$1" "$2"
}

# commit 必须精确匹配：这两个工具的输出字节直接进 burn.img，换版本等于换交付件。
fetch() {
  local target=$1 repository=$2 commit=$3
  if [[ -d "$target/.git" ]]; then
    git -C "$target" fetch --quiet origin "$commit" 2>/dev/null || true
  else
    rm -rf "$target"
    git clone --quiet --filter=blob:none "$repository" "$target"
  fi
  git -C "$target" checkout --quiet --detach "$commit"
  [[ "$(git -C "$target" rev-parse HEAD)" == "$commit" ]] || {
    echo "$target is not at the pinned commit" >&2
    exit 1
  }
}

mapfile -t ampack < <(pinned "$root/config/burn-tooling.json" ampack)
mapfile -t gxlimg < <(pinned "$root/config/mainline-boot.json" gxlimg)

echo "building ampack ${ampack[1]:0:12}" >&2
fetch "$prefix/ampack-src" "${ampack[0]}" "${ampack[1]}"
cargo build --quiet --release --manifest-path "$prefix/ampack-src/Cargo.toml"
install -m 0755 "$prefix/ampack-src/target/release/ampack" "$bin/ampack"

echo "building gxlimg ${gxlimg[1]:0:12}" >&2
fetch "$prefix/gxlimg-src" "${gxlimg[0]}" "${gxlimg[1]}"
make --quiet -C "$prefix/gxlimg-src" >/dev/null
install -m 0755 "$prefix/gxlimg-src/gxlimg" "$bin/gxlimg"

echo "export PATH=\"$bin:\$PATH\""
