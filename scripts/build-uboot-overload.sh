#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd -- "$script_dir/.." && pwd)

usage() {
  echo "usage: $0 manifest.json output-dir" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
manifest=$1
output_dir=$2
[[ -f "$manifest" ]] || { echo "manifest not found: $manifest" >&2; exit 1; }
mkdir -p "$output_dir"

for command in git gzip make node sha256sum stat strings tar; do
  command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 1; }
done

mapfile -t values < <(node - "$manifest" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const source = manifest.sources?.ubootSource;
const board = manifest.board;
const build = board?.ubootOverloadBuild;
if (![4, 5].includes(manifest.schemaVersion) || build?.reproducibleFromSource !== true) {
  throw new Error('manifest does not describe a source-built U-Boot overload');
}
for (const value of [
  source?.repository,
  source?.ref,
  source?.commit,
  board?.ubootOverload,
  build?.patch,
  build?.patchSha256,
  build?.defconfig,
  build?.output,
  build?.crossCompile,
]) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('manifest U-Boot build field is missing');
  console.log(value);
}
if (!Number.isSafeInteger(build.sourceDateEpoch) || build.sourceDateEpoch < 0) {
  throw new Error('manifest U-Boot sourceDateEpoch is invalid');
}
console.log(build.sourceDateEpoch);
NODE
)
[[ ${#values[@]} -eq 10 ]] || { echo 'manifest U-Boot extraction failed' >&2; exit 1; }
source_repository=${values[0]}
source_ref=${values[1]}
source_commit=${values[2]}
overload_name=${values[3]}
patch_relative=${values[4]}
patch_sha256=${values[5]}
defconfig=${values[6]}
build_output=${values[7]}
cross_compile=${values[8]}
source_date_epoch=${values[9]}

[[ "$source_commit" =~ ^[[:xdigit:]]{40}$ ]] || { echo 'invalid U-Boot source commit' >&2; exit 1; }
[[ "$patch_sha256" =~ ^[[:xdigit:]]{64}$ ]] || { echo 'invalid U-Boot patch SHA-256' >&2; exit 1; }
for name in "$overload_name" "$defconfig" "$build_output"; do
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid U-Boot build name: $name" >&2; exit 1; }
done
[[ "$cross_compile" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*-$ ]] || { echo 'invalid cross compiler prefix' >&2; exit 1; }
[[ "$source_date_epoch" =~ ^[0-9]+$ ]] || { echo 'invalid SOURCE_DATE_EPOCH' >&2; exit 1; }

patch_path=$(realpath --canonicalize-existing "$project_root/$patch_relative")
[[ "$patch_path" == "$project_root"/* ]] || { echo 'U-Boot patch escapes the repository' >&2; exit 1; }
printf '%s  %s\n' "$patch_sha256" "$patch_path" | sha256sum --check --status

case "$source_repository" in
  https://*|http://*|git@*|file://*) repository_url=$source_repository ;;
  */*) repository_url="https://github.com/${source_repository}.git" ;;
  *) echo "unsupported U-Boot repository: $source_repository" >&2; exit 1 ;;
esac

tmp_dir=$(mktemp -d)
cleanup() { rm -rf -- "$tmp_dir"; }
trap cleanup EXIT
source_dir="$tmp_dir/source"
build_dir="$tmp_dir/build"
git clone --filter=blob:none --no-checkout --quiet "$repository_url" "$source_dir"
git -C "$source_dir" fetch --quiet --depth=1 origin "$source_commit"
git -C "$source_dir" checkout --detach --quiet "$source_commit"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$source_commit" ]] || {
  echo 'exact U-Boot checkout failed' >&2
  exit 1
}
git -C "$source_dir" apply --check "$patch_path"
git -C "$source_dir" apply "$patch_path"
git -C "$source_dir" diff --check
source_tree_sha256=$(node "$script_dir/hash-source-tree.mjs" "$source_dir")

compiler="${cross_compile}gcc"
command -v "$compiler" >/dev/null || { echo "cross compiler is missing: $compiler" >&2; exit 1; }
build_timestamp=$(date --utc --date "@$source_date_epoch" '+%Y-%m-%d %H:%M:%S %z')
export ARCH=arm
export CROSS_COMPILE="$cross_compile"
export SOURCE_DATE_EPOCH="$source_date_epoch"
export KBUILD_BUILD_TIMESTAMP="$build_timestamp"
export KBUILD_BUILD_USER=github-actions
export KBUILD_BUILD_HOST=b860av1-t
export KBUILD_BUILD_VERSION=1
make -C "$source_dir" O="$build_dir" "$defconfig"
make -C "$source_dir" O="$build_dir" -j "$(nproc)"

source_built_overload="$output_dir/$overload_name"
install -m 0644 -- "$build_dir/$build_output" "$source_built_overload"
[[ -s "$source_built_overload" ]] || { echo 'source-built U-Boot overload is empty' >&2; exit 1; }
strings "$source_built_overload" | grep -F 'U-Boot 2020.07' >/dev/null
artifact_sha256=$(sha256sum "$source_built_overload" | awk '{print $1}')
artifact_size=$(stat -c %s "$source_built_overload")
config_sha256=$(sha256sum "$build_dir/.config" | awk '{print $1}')
compiler_identity="$compiler $("$compiler" -dumpfullversion -dumpversion)"
source_archive="$output_dir/u-boot-source.tar.gz"
tar --create --format=gnu --sort=name --mtime="@$source_date_epoch" --owner=0 --group=0 --numeric-owner \
  --exclude=.git --directory "$source_dir" . | gzip --no-name > "$source_archive"
source_archive_sha256=$(sha256sum "$source_archive" | awk '{print $1}')
source_archive_size=$(stat -c %s "$source_archive")
archive_check_dir="$tmp_dir/archive-check"
mkdir -p "$archive_check_dir"
tar --extract --gzip --file "$source_archive" --directory "$archive_check_dir"
archive_tree_sha256=$(node "$script_dir/hash-source-tree.mjs" "$archive_check_dir")
[[ "$archive_tree_sha256" == "$source_tree_sha256" ]] || {
  echo 'U-Boot source archive tree digest mismatch' >&2
  exit 1
}

SOURCE_REPOSITORY="$source_repository" SOURCE_REF="$source_ref" SOURCE_COMMIT="$source_commit" \
PATCH_RELATIVE="$patch_relative" PATCH_SHA256="$patch_sha256" DEFCONFIG="$defconfig" \
BUILD_OUTPUT="$build_output" CROSS_COMPILE="$cross_compile" SOURCE_DATE_EPOCH="$source_date_epoch" \
OVERLOAD_NAME="$overload_name" ARTIFACT_SHA256="$artifact_sha256" ARTIFACT_SIZE="$artifact_size" \
CONFIG_SHA256="$config_sha256" COMPILER_IDENTITY="$compiler_identity" \
SOURCE_ARCHIVE_SHA256="$source_archive_sha256" SOURCE_ARCHIVE_SIZE="$source_archive_size" \
SOURCE_TREE_SHA256="$source_tree_sha256" \
node - "$output_dir/uboot-build.json" <<'NODE'
const fs = require('node:fs');
const result = {
  schemaVersion: 1,
  source: {
    repository: process.env.SOURCE_REPOSITORY,
    ref: process.env.SOURCE_REF,
    commit: process.env.SOURCE_COMMIT,
  },
  recipe: {
    patch: process.env.PATCH_RELATIVE,
    patchSha256: process.env.PATCH_SHA256,
    defconfig: process.env.DEFCONFIG,
    output: process.env.BUILD_OUTPUT,
    crossCompile: process.env.CROSS_COMPILE,
    sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH),
  },
  artifact: {
    name: process.env.OVERLOAD_NAME,
    sha256: process.env.ARTIFACT_SHA256,
    size: Number(process.env.ARTIFACT_SIZE),
  },
  sourceArchive: {
    name: 'u-boot-source.tar.gz',
    sha256: process.env.SOURCE_ARCHIVE_SHA256,
    size: Number(process.env.SOURCE_ARCHIVE_SIZE),
    treeSha256: process.env.SOURCE_TREE_SHA256,
  },
  environment: {
    arch: 'arm',
    configSha256: process.env.CONFIG_SHA256,
    compiler: process.env.COMPILER_IDENTITY,
  },
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
NODE
node "$script_dir/validate-uboot-build.mjs" "$manifest" "$output_dir/uboot-build.json" >/dev/null
printf '%s\n' "$source_built_overload"
