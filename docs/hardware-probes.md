# 硬件实测记录

这里记的是在**跑着的系统上**用 `/dev/mem` 做的硬件探测结论——CI 验证不了，
只能实机跑。每条都写清楚了怎么复现、以及会把板子搞重启的坑。

和 [`docs/known-issues.md`](known-issues.md) 的分工：那边是「还没修好的问题」，
这边是「这块硅片到底有什么能力」。

## 1. HCODEC H.264 硬件编码器是活的（2026-09-05）

**结论：这块 B860AV1-T 的 S905L 上，HCODEC 硬件编码块完整可用，没被 IPTV 阉割。
原厂 ucode 已经实测在 AMRISC 核上跑起来了。**

之前评估硬编可行性时唯一的未知项（S905L 是不是熔断了编码块）到此关闭。
全部证据都是在 5.10.268-ophub 上取的，不刷机、不编内核模块，只用 `/dev/mem`。

### 证据链

| 层次 | 观测 | 结论 |
| --- | --- | --- |
| 时钟 | `/sys/kernel/debug/meson-clk-msr/clks/hcodec` 实测 **166,664,063 Hz**（之前恒为 0） | SoC 自带频率计确认时钟真在跑 |
| 寄存器 | `HENC_SCRATCH_0/1`（`0xc8826b00/04`）稳定存取 `0xa5a5a5a5` / `0x5a5a5a5a` / `0xdeadbeef` / `0x0` | 寄存器堆通电可用 |
| DMA | `IMEM_DMA_CTRL = 0x00071000 after 64 spins -> COMPLETED` | 块自己做总线主控，从 DRAM 读了 16 KB 进 IMEM |
| 执行 | `MPC_P/D/E/W` 从 0 跳到 `0xa05`–`0xa18`，50 ms 内 12 次采样全落在这 20 条指令的窗口 | **AMRISC 真在取指执行，四级流水线错位推进** |
| 固件行为 | `MPSR` 从我们写的 `0x1` 自己变成 `0x5`（bit2 是固件置的）；`ENCODER_STATUS` 保持 `0` = `ENCODER_IDLE`，预埋在 `SCRATCH_1..9` 的 `0xdead000N` 一个没动 | 固件坐在等命令的空转循环里，行为完全正确 |
| 收尾 | `avc_poweroff` 后 hcodec 回 0 Hz，PC 回 0，板子 `up 8:35` 没重启 | 上电/断电两个方向都可控 |

**判断 AMRISC 是否真在执行指令要看 `MPC_P`（`0xc8824c18`），不能看 `MPSR` bit0
——那位是我们自己写进去的。** `MPC_D/E/W` 是同一条流水线的 D/E/W 级
（`0xc8824c1c/20/24`），四个值互相错开几条指令才说明流水线在推进。

### 上电序列

字节地址（厂商头文件里是**字索引**，`<<2` 才是字节偏移）。板上脚本
`/root/hcodec_up.sh`，逐条 `sync` 写进 `/root/hcodec-c.log`，总线挂了也能看出死在哪步。

| 步 | 地址 | 值 | 说明 |
| --- | --- | --- | --- |
| 1 | `0xc81000e8` `AO_SLEEP0` | `&= ~0x3` | 给 hcodec 电源域上电 |
| 2 | `0xc882fc1c` `DOS_SW_RESET1` | `0xffffffff` → `0x0` | 复位脉冲 |
| 3 | `0xc883c1e0` `HHI_VDEC_CLK_CNTL` | `0x01020000` | sel=0 fclk_div4，div=2（/3），enable bit24 |
| 4 | `0xc882fc04` `DOS_GCLK_EN0` | `0x07fff000` | 位 `[26:12]` 全开 |
| 5 | `0xc882fcc8` `DOS_MEM_PD_HCODEC` | `0x0` | hcodec 内部 RAM 上电 |
| 6 | `0xc81000ec` `AO_ISO0` | `&= ~0x30` | 解除隔离 |
| 7 | `0xc882fc08` `DOS_GEN_CTRL0` | `0x1` → `0x0` | 踢一下自动门控 |

断电是反序（`/root/hcodec_down.sh`）：隔离 → RAM 断电 → `DOS_GCLK_EN0=0` →
时钟关 → `SLEEP0 |= 0x3`。第 1、5 步用读改写，别硬写常量。

**验证映射正确的零风险手法**（只读，不碰 hcodec 子块）：`HHI_VPU_CLK_CNTL`
`0xc883c1bc` 应为 `0x300`（sel=1 + enable，对应内核报的 vpu 666 MHz）；
`HHI_MPEG_CLK_CNTL` `0xc883c174` 的 div 字段应为 2（500/3 = clk81 166.67 MHz）。
两个都对得上，映射就是对的，可以往下写。

### 固件不是裸 ucode，是 KCAP 包

`/lib/firmware/video/h264_enc.bin`（76288 B）的结构：

```
0      256 B   包头: "KCAP" + size(0x12900) + crc(0x01a74fbc)
256    25344 B item 0
25600  25344 B item 1
50944  25344 B item 2
```

每个 item = 256 B 名字块 + 256 B `"EDOC"` 头 + 256 B 填充 + **24576 B 数据**。
`EDOC` 头里 `+4` 是 crc、`+8` 起是 name/cpu/format/version/author/date/commit
各 32 B、`+192` 是数据长度（`0x6000`）、`+196` 是时间戳。

| item | 数据偏移 | 名字 | cpu |
| --- | --- | --- | --- |
| 0 | 1024 | `ga_h264_enc_cabac.bin` | ga |
| 1 | 26368 | `txl_h264_enc_cavlc.bin` | txl |
| 2 | **51712** | **`gxl_h264_enc.bin`** | **gxl ← S905L 用这个** |

厂商只把数据的**前 16 KB**（`MC_SIZE`）DMA 进 IMEM：
`IMEM_DMA_COUNT = 0x1000`，单位是 32 位字。三个 item 的头四个字都一样
（`06810001 06800000 0d000001 07400040`），别拿这个当选对了的依据——要看 cpu 字段。

寄存器定义在 khadas 3.14 内核的
`drivers/amlogic/amports/arch/regs/hcodec_regs.h`，加载协议在同目录
`encoder.c` 的 `amvenc_loadmc()` / `amvenc_start()` / `amvenc_stop()`。

### 四个会让板子当场重启的坑

一共踩掉 4 次重启，无数据损坏。按踩到的概率排序：

1. **Python 的 `mmap` + `struct.pack_into` 不能用来写 MMIO。** 它不保证发出单条对齐
   的 32 位存储，逐字节写 HHI/DOS 寄存器会触发总线 abort → 看门狗复位。表现极具
   误导性：连「把读回来的原值写回去」这种空操作都会重启。ctypes `from_buffer` 一样
   不行（也是 memcpy）。**必须用 C 的 `volatile uint32_t *`**，板上的 `/root/mmio`
   就是干这个的（一次进程一次访问）。
2. **上电/去隔离之前读任何 hcodec 子块寄存器都会挂总线。** DOS **公共**块
   （`0xc882fc00`–`0xc882fccc`）随时可读，因为 clk81 的 `dos` 门在硬件里本来就是开的
   （`HHI_GCLK_MPEG0` = `0xffffffff`）；挂的是 hcodec 子块（`0xc8824xxx`、`0xc8826xxx`）。
   **CCF 里 enable-count 为 0 不等于硬件门控位为 0。**
3. **`fclk_div5` 被 CCF 当无人使用关掉了**（频率计实测 0 Hz），所以厂商默认的时钟源
   `source=2` 是死的。用 `source=0`（fclk_div4，3 个使用者，实测在跑）。这个坑不重启，
   但会给出「上电成功可是时钟读 0」的假阴性。
4. **有风险的读不要和测量放在同一个进程里。** 一次崩溃会把还没 flush 的日志一起带走。
   板上脚本因此拆成 `hcodec_up.sh`（上电+测频）和 `hcodec_scratch.sh`（碰寄存器）两次跑。

顺带两条：AO 域寄存器（`SLEEP0`/`ISO0`）**能扛过看门狗复位**，复位前写进去的值还在；
`/sys/kernel/debug/meson-clk-msr/clks/<name>` 是 SoC 自带的硬件频率计，是这套探测里
唯一的真值仪器，用之前先拿 `clk81`（166,664,063 Hz）和 `vpu`（666,625,000 Hz）
对一下 `clk_summary` 做正对照。

### 用户态怎么拿到物理连续缓冲区

不用内核模块也能做 DMA：

1. `mmap(..., MAP_HUGETLB)` 拿一个 2 MB 大页 → `mlock`；
2. 从 `/proc/self/pagemap` 读 PFN（bit 63 是 present，bit[54:0] 是 PFN），
   物理地址 = PFN × 4096；
3. **把同一个物理地址再从 `/dev/mem` 映一遍读回来核对**，PFN 算错会在这步暴露，
   而不是变成一次乱写 DMA；
4. DOS 的 DMA 引擎不是 IO 一致的，写完缓冲区要用 EL0 的 `dc civac` + `dsb sy` 清 cache
   （Linux 置了 `SCTLR_EL1.UCI`，用户态执行这条是合法的）。

本机 `/sys/kernel/mm/hugepages/` 有 `hugepages-32768kB`，**一个 32 MB 大页就够覆盖
1080p 编码所需的 0x1370000（19.4 MB）连续内存**，不需要 CMA、也不需要内核模块。
备用方案：`mem=1024M` 之上的 `0x38000000`–`0x40000000` 是真实存在但不在 System RAM
里的 DRAM（厂商 U-Boot 的 logo 缓冲就在 `0x3d800000`），`/dev/mem` 可直接映射。

### 板上工具

| 文件 | 作用 |
| --- | --- |
| `/root/mmio` | 单次对齐 32 位 MMIO 读/写，其他脚本都靠它 |
| `/root/hcodec_up.sh` / `hcodec_down.sh` | `avc_poweron()` / `avc_poweroff()` 复刻 |
| `/root/hcodec_scratch.sh` | scratch 寄存器读写测试 |
| `/root/hcodec_mc` | 装载厂商 `fix_mc[]` 四指令程序（最小可行验证） |
| `/root/hcodec_fw` | 装载真固件 `gxl_h264_enc.bin` 并采样 `MPC_P`，`usage: hcodec_fw [offset]` |

日志 `/root/hcodec-c.log`、`/root/hcodec-mc.log`、`/root/hcodec-fw.log`。
**跑 `hcodec_fw` 之前必须先跑 `hcodec_up.sh`**，否则第 2 条坑当场生效。

### 还差什么

只差驱动。mainline 5.10 一行 Amlogic 编码代码都没有（`meson-vdec` 只解码）。
实施规划见 [`docs/hcodec-encoder-plan.md`](hcodec-encoder-plan.md)。
