#!/bin/sh
# Vendor avc_poweron() replayed with single-word MMIO writes, one step per line,
# log fsync'd after each so a bus abort still shows where it died.
M=/root/mmio
L=/root/hcodec-c.log

say() { printf '%s\n' "$*" | tee -a "$L"; sync; }
poke() { say "$($M "$1" "$2")"; }
peek() { say "$($M "$1")"; }

say "=== avc_poweron $(date -Is) ==="
say "-- before --"
peek 0xc81000e8   # AO_RTI_GEN_PWR_SLEEP0
peek 0xc81000ec   # AO_RTI_GEN_PWR_ISO0
peek 0xc883c1e0   # HHI_VDEC_CLK_CNTL
peek 0xc882fc04   # DOS_GCLK_EN0

say "-- 1. power on hcodec domain (SLEEP0[1:0]=0) --"
poke 0xc81000e8 0xfffffcfc

say "-- 2. DOS_SW_RESET1 pulse --"
poke 0xc882fc1c 0xffffffff
poke 0xc882fc1c 0x0

# fclk_div5 measures 0 Hz - CCF gated it off as unused, so source 2 is dead.
# fclk_div4 (source 0) has 3 users and measures live via clk81.
say "-- 3. hcodec clock: fclk_div4 / 3 = 166.7 MHz, enabled --"
poke 0xc883c1e0 0x01020000

say "-- 4. DOS_GCLK_EN0[26:12] = 0x7fff --"
poke 0xc882fc04 0x07fff000

say "-- 5. DOS_MEM_PD_HCODEC = 0 (power up hcodec RAMs) --"
poke 0xc882fcc8 0x0

say "-- 6. remove isolation (ISO0[5:4]=0) --"
poke 0xc81000ec 0xffffffcf

say "-- 7. kick auto clock gate --"
poke 0xc882fc08 0x1
poke 0xc882fc08 0x0

say "-- 8. measured hcodec clock --"
say "hcodec = $(cat /sys/kernel/debug/meson-clk-msr/clks/hcodec)"
say "vdec   = $(cat /sys/kernel/debug/meson-clk-msr/clks/vdec)"

say "=== bring-up survived; scratch test is a separate run ==="
