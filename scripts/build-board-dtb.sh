#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

usage() {
  echo "usage: $0 resolved-sources.json output-dir" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
manifest=$1
output_dir=$2
[[ -f "$manifest" ]] || { echo "manifest not found: $manifest" >&2; exit 1; }
mkdir -p "$output_dir"

mapfile -t build_values < <(node - "$manifest" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const board = manifest.board;
const build = board?.dtbBuild;
if (manifest.schemaVersion !== 5 || !build || typeof build !== 'object' || Array.isArray(build)) {
  throw new Error('manifest must use the source-built DTB schema');
}
const text = (value, label, pattern) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
};
const repository = text(build.repository, 'DTB repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const sourcePath = text(
  build.sourcePath,
  'DTB source path',
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]+\.dts$/,
);
const commit = text(build.commit, 'DTB commit', /^[0-9a-f]{40}$/);
const sourceSha256 = text(build.sourceSha256, 'DTB source SHA-256', /^[0-9a-f]{64}$/);
const output = text(build.output, 'DTB output', /^[A-Za-z0-9][A-Za-z0-9._-]*\.dtb$/);
const rawSourceUrl = text(
  build.rawSourceUrl,
  'DTB raw source URL',
  /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/[A-Za-z0-9_.\/-]+\.dts$/,
);
const required = {
  repository: 'S-9527/meson-gxl-s905x-p212',
  sourcePath: 'repair/meson-gxl-s905x-p212.dts',
  commit: '624b3e57e27fd39476b3d6528e8a61867559d8c8',
  rawSourceUrl: 'https://raw.githubusercontent.com/S-9527/meson-gxl-s905x-p212/624b3e57e27fd39476b3d6528e8a61867559d8c8/repair/meson-gxl-s905x-p212.dts',
  sourceSha256: 'b52b6c6deea1d6b626d052042708f54eca65c9b7ffda56dfe8ca5fa0907cee7d',
  license: 'MIT',
  output: 'meson-gxl-s905x-p212-b860av11t.dtb',
};
if (Object.entries(required).some(([key, expected]) => build[key] !== expected)) {
  throw new Error('DTB source metadata does not match the project recipe');
}
const expectedUrl = `https://raw.githubusercontent.com/${repository}/${commit}/${sourcePath}`;
if (rawSourceUrl !== expectedUrl) throw new Error('DTB raw source URL is not bound to repository metadata');
if (board.dtb !== output) throw new Error('DTB output does not match the selected board DTB');
if (build.license !== 'MIT') throw new Error('DTB license is invalid');
if (build.reproducibleFromSource !== true) throw new Error('DTB build must be reproducible from source');
if (!Number.isSafeInteger(build.sourceDateEpoch) || build.sourceDateEpoch < 0) {
  throw new Error('DTB source date epoch is invalid');
}
for (const value of [repository, sourcePath, commit, rawSourceUrl, sourceSha256, output]) console.log(value);
console.log(build.license);
console.log(build.sourceDateEpoch);
NODE
)
[[ ${#build_values[@]} -eq 8 ]] || { echo 'DTB manifest extraction failed' >&2; exit 1; }
repository=${build_values[0]}
source_path=${build_values[1]}
commit=${build_values[2]}
raw_source_url=${build_values[3]}
source_sha256=${build_values[4]}
output_name=${build_values[5]}
license=${build_values[6]}
source_date_epoch=${build_values[7]}

for command in curl dtc fdtget node sha256sum; do
  command -v "$command" >/dev/null || { echo "$command is required to build the board DTB" >&2; exit 1; }
done

tmp_dir=$(mktemp -d)
cleanup() { rm -rf -- "$tmp_dir"; }
trap cleanup EXIT
source_file="$tmp_dir/device-tree-source.dts"
dtb_file="$tmp_dir/$output_name"
curl --fail --location --retry 3 --retry-delay 2 --output "$source_file" "$raw_source_url"
printf '%s  %s\n' "$source_sha256" "$source_file" | sha256sum --check --status
SOURCE_DATE_EPOCH="$source_date_epoch" dtc -I dts -O dtb -o "$dtb_file" "$source_file"
fdtget "$dtb_file" / compatible | node "$script_dir/validate-dtb-compatible.mjs" amlogic,p212
wifi_node='/soc/apb@d0000000/mmc@70000/wifi@1'
mmc_node='/soc/apb@d0000000/mmc@70000'
sdio_pwrseq_node='/sdio-pwrseq'
cma_node='/reserved-memory/linux,cma'
fdtget "$dtb_file" "$wifi_node" compatible | node "$script_dir/validate-dtb-compatible.mjs" realtek,rtl8189ftv
[[ "$(fdtget "$dtb_file" "$mmc_node" max-frequency)" == '200000000' ]] || {
  echo 'repair DTB SDIO max-frequency must be 200000000' >&2
  exit 1
}
read -r _ reset_gpio_cell _ <<< "$(fdtget -t x "$dtb_file" "$sdio_pwrseq_node" reset-gpios)"
[[ "$reset_gpio_cell" == '4c' ]] || {
  echo 'repair DTB SDIO reset GPIO must use cell 0x4c' >&2
  exit 1
}
[[ "$(fdtget -t x "$dtb_file" "$cma_node" size)" == '0 4000000' ]] || {
  echo 'repair DTB CMA size must be 64 MiB' >&2
  exit 1
}
dtb_sha256=$(sha256sum "$dtb_file" | awk '{print $1}')
dtb_size=$(node -e "console.log(require('node:fs').statSync(process.argv[1]).size)" "$dtb_file")

install -m 0644 -- "$source_file" "$output_dir/device-tree-source.dts"
install -m 0644 -- "$dtb_file" "$output_dir/$output_name"
REPOSITORY="$repository" SOURCE_PATH="$source_path" COMMIT="$commit" \
RAW_SOURCE_URL="$raw_source_url" SOURCE_SHA256="$source_sha256" LICENSE="$license" \
SOURCE_DATE_EPOCH="$source_date_epoch" OUTPUT_NAME="$output_name" DTB_SHA256="$dtb_sha256" \
DTB_SIZE="$dtb_size" OUTPUT="$output_dir/source-built-dtb.json" node - <<'NODE'
const fs = require('node:fs');
const result = {
  schemaVersion: 1,
  source: {
    repository: process.env.REPOSITORY,
    path: process.env.SOURCE_PATH,
    commit: process.env.COMMIT,
    url: process.env.RAW_SOURCE_URL,
    sha256: process.env.SOURCE_SHA256,
    license: process.env.LICENSE,
  },
  recipe: {
    compiler: 'dtc',
    compatible: 'amlogic,p212',
    sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH),
    reproducibleFromSource: true,
    semanticChecks: {
      wifiCompatible: 'realtek,rtl8189ftv',
      sdioMaxFrequencyHz: 200000000,
      resetGpioCell: 0x4c,
      cmaBytes: 64 * 1024 * 1024,
    },
  },
  sourceEvidence: { name: 'device-tree-source.dts', sha256: process.env.SOURCE_SHA256 },
  artifact: {
    name: process.env.OUTPUT_NAME,
    size: Number(process.env.DTB_SIZE),
    sha256: process.env.DTB_SHA256,
  },
};
fs.writeFileSync(process.env.OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
NODE
