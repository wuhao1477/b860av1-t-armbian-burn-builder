# hcenc — Stage 0 userspace H.264 encoder prototype

Drives the S905L HCODEC block from userspace over `/dev/mem` + one 32 MB
hugepage. No kernel module, no reflash. This is the register-value ground
truth for Stage 1 (see [`../../docs/hcodec-encoder-plan.md`](../../docs/hcodec-encoder-plan.md)).

**Verified on hardware 2026-09-05**: `1280x720` Baseline IDR frame, 4,579 bytes,
`ffprobe` reports `key_frame=1 pict_type=I`, and the decoded picture is
pixel-for-pixel the synthetic NV12 test pattern that went in.

## Run it

```bash
tools/hcenc/fetch-vendor.sh /tmp/hcv          # GPL slices, not vendored here
scp -r /tmp/hcv root@<board>:/root/hcenc
ssh root@<board> '
  cd /root/hcenc && gcc -O2 -w -o /root/hcenc.bin hcenc.c
  echo 1 > /sys/kernel/mm/hugepages/hugepages-32768kB/nr_hugepages
  sh /root/hcodec_up.sh          # power domain + clock + de-isolation
  /root/hcenc.bin 1280 720       # writes /root/out.h264, logs /root/hcenc.log
  sh /root/hcodec_down.sh
  echo 0 > /sys/kernel/mm/hugepages/hugepages-32768kB/nr_hugepages'
```

## Why the vendor code is not in this repo

`vendor.inc` and `venc_types.h` are verbatim slices of `khadas/linux`
(GPL-2.0); this repo is MIT. `fetch-vendor.sh` reproduces them from pinned
upstream files and checks their SHA-256 first, so the line ranges stay
verifiable without relicensing anything. Only `hcenc.c`, `kshim.h` and
`venc_defs.h` are ours.

## The two things that cost the most time

1. **`byte offset == vendor word index << 2`** for the whole DOS window, so
   `volatile uint32_t *dos` mapped at `0xC8820000` can be indexed directly by
   the vendor register name. That is what lets 2,300 lines of kernel driver
   compile as a userspace program against a 95-line shim.
2. **The VLC does not flush to DRAM at `ENCODER_SEQUENCE_DONE`.** `STATUS=7`
   and `VLC_TOTAL_BYTES=13` both look like success while `VLC_VB_WR_PTR` is
   still equal to `VLC_VB_START_PTR` and the buffer is all zeros — the SPS is
   in the VLC's internal FIFO. The vendor never reads there either: it goes
   straight on to `ENCODER_PICTURE` (venc.c:4045) and only reads after
   `PICTURE_DONE`. Follow that order or the bitstream looks lost.

Also load-bearing: `amvenc_start()` is called **only** when the ucode was
reloaded (`reload_flag`, venc.c:3316). Every normal command is issued by
writing `ENCODER_STATUS` alone — the AMRISC is already spinning in its idle
loop at PC `0xa05..0xa18`. And the VLC pads to 8 bytes **with `0xff`** between
commands, which breaks `rbsp_trailing_bits` for decoders that only strip
trailing zeros, so the two byte runs must be written out separately.
