#!/usr/bin/env bash
# Fetch the GPL-2.0 vendor encoder sources and slice out the parts hcenc.c
# needs. Those slices are NOT vendored into this repo: khadas/linux is
# GPL-2.0, this repo is MIT, and the ranges below are mechanically
# reproducible from the pinned upstream files.
#
# usage: tools/hcenc/fetch-vendor.sh <outdir>
set -euo pipefail

OUT=${1:?usage: fetch-vendor.sh <outdir>}
RAW=https://raw.githubusercontent.com/khadas/linux/khadas-vim-3.14.y
mkdir -p "$OUT"

curl -fsSL "$RAW/drivers/amlogic/amports/encoder.c" -o "$OUT/venc.c"
curl -fsSL "$RAW/drivers/amlogic/amports/encoder.h" -o "$OUT/v_encoder.h"
curl -fsSL "$RAW/drivers/amlogic/amports/arch/regs/hcodec_regs.h" -o "$OUT/hcodec_regs.h"
curl -fsSL "$RAW/drivers/amlogic/amports/arch/regs/dos_regs.h" -o "$OUT/dos_regs.h"
curl -fsSL "$RAW/drivers/amlogic/amports/arch/regs/dmc_regs.h" -o "$OUT/dmc_regs.h"

# Digests of the exact revisions the line ranges below were taken against.
# A mismatch means upstream moved and the ranges must be re-derived.
cat >"$OUT/EXPECTED.sha256" <<'EOF'
bb81ea089b3c50fa2029eb3ee6901bbd30c12156be4ecc5f4fd5ef477a0540dd  venc.c
48f045985708f1cf2e216a3f5a756aa1e62bbbdceaa885cdf4e6785116da4313  v_encoder.h
8f9feef74d24308fa6a1484c233191f01c957a6cd062c986350dc048289df34b  hcodec_regs.h
975f6ef5b00df2e801474a0d60cb0be43c540bbf5d900e939d903745817e0f2d  dos_regs.h
2779e0db1fcb0cf73c2f5ed2ed31910bc2430950c485304055607dcb85eda9a5  dmc_regs.h
EOF
( cd "$OUT" && shasum -a 256 -c EXPECTED.sha256 ) ||
	echo "WARNING: upstream digests changed, line ranges below may be stale" >&2

# venc_types.h — enums, encode structs, SCRATCH aliases and STATUS codes.
# 339 (not 345) stops at the end of struct encode_wq_s; 890 (not 891) drops
# the file's closing include-guard #endif.
{
	sed -n '130,186p' "$OUT/v_encoder.h"
	sed -n '188,339p' "$OUT/v_encoder.h"
	sed -n '390,890p' "$OUT/v_encoder.h"
} >"$OUT/venc_types.h"

# vendor.inc — the function bodies, verbatim. 656 (not 657) picks up the
# opening "#ifndef USE_OLD_DUMP_MC"; line 209 DEFINE_SPINLOCK is skipped.
{
	sed -n '88,208p'   "$OUT/venc.c"   # statics, me_*/p_* config words, tnr/snr
	sed -n '210,555p'  "$OUT/venc.c"   # v3_mv_sad[64], amvenc_buffspec[]
	sed -n '656,814p'  "$OUT/venc.c"   # hcodec_prog_qtbl, InitEncodeWeight
	sed -n '817,1028p' "$OUT/venc.c"   # avc_init_*_buffer, avc_init_encoder,
	                                   # avc_canvas_init, avc_buffspec_init
	sed -n '1038,1109p' "$OUT/venc.c"  # avc_init_ie_me_parameter
	sed -n '1112,1122p' "$OUT/venc.c"  # MFDIN_REGC..REG16 aliases
	sed -n '1124,1327p' "$OUT/venc.c"  # mfdin_basic
	sed -n '1473,1716p' "$OUT/venc.c"  # set_input_format
	sed -n '1718,2565p' "$OUT/venc.c"  # avc_prot_init
	sed -n '2567,2637p' "$OUT/venc.c"  # amvenc_reset / _start / _stop
} >"$OUT/vendor.inc"

cp "$(dirname "$0")"/{hcenc.c,kshim.h,venc_defs.h} "$OUT/"
echo "ready: cd $OUT && gcc -O2 -w -o hcenc hcenc.c"
