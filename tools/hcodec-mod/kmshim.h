/* SPDX-License-Identifier: MIT OR GPL-2.0 */
/*
 * 内核侧 shim：让 khadas 3.14 的 encoder.c 切片（vendor.inc）能在
 * 5.10.268-ophub 上编译。和 tools/hcenc/kshim.h 用的是同一个技巧 ——
 * 整个 DOS 窗口里「字节偏移 == 厂商的 word 下标 << 2」，所以厂商的寄存器名
 * 直接就是 ioremap 出来的基址加位移，不需要改一行厂商代码。
 *
 * 与 kshim.h 的唯一区别：那边是 mmap 出来的 volatile u32 *，这边是
 * ioremap + readl/writel。
 */
#ifndef MESON_HCODEC_KMSHIM_H
#define MESON_HCODEC_KMSHIM_H

#include <linux/atomic.h>
#include <linux/delay.h>
#include <linux/io.h>
#include <linux/jiffies.h>
#include <linux/kernel.h>
#include <linux/list.h>
#include <linux/mm_types.h>
#include <linux/module.h>
#include <linux/printk.h>
#include <linux/slab.h>
#include <linux/spinlock.h>
#include <linux/string.h>
#include <linux/types.h>
#include <linux/wait.h>

/* MMIO 窗口（物理地址） */
#define HC_DOS_BASE 0xc8820000UL
#define HC_DOS_SIZE 0x10000
#define HC_DMC_BASE 0xc8838000UL
#define HC_DMC_SIZE 0x1000
#define HC_HHI_BASE 0xc883c000UL
#define HC_HHI_SIZE 0x400
#define HC_AO_BASE 0xc8100000UL
#define HC_AO_SIZE 0x200

/* 窗口内的字节偏移 */
#define HHI_VDEC_CLK_CNTL_OFF 0x1e0
#define AO_PWR_SLEEP0_OFF 0xe8
#define AO_PWR_ISO0_OFF 0xec

extern void __iomem *hc_dos;
extern void __iomem *hc_dmc;
extern u32 hc_log_level;

#define WRITE_HREG(r, v) writel((u32)(v), hc_dos + (((r) & 0x3fff) << 2))
#define READ_HREG(r) readl(hc_dos + (((r) & 0x3fff) << 2))
#define WRITE_VREG(r, v) WRITE_HREG(r, v)
#define READ_VREG(r) READ_HREG(r)
#define WRITE_DMCREG(r, v) writel((u32)(v), hc_dmc + (((r) & 0x3ff) << 2))
#define READ_DMCREG(r) readl(hc_dmc + (((r) & 0x3ff) << 2))

/* 厂商日志宏。默认只放 LOG_ERROR，靠 log_level 模块参数放开。 */
#define LOG_ALL 0
#define LOG_INFO 1
#define LOG_DEBUG 2
#define LOG_ERROR 3
#define enc_pr(level, fmt, ...)                            \
	do {                                               \
		if ((level) >= hc_log_level)               \
			pr_info("hcodec: " fmt, ##__VA_ARGS__); \
	} while (0)

/* 厂商代码里的 CPU 分支：这块板固定是 GXL(S905X/S905L)。 */
#define MESON_CPU_MAJOR_ID_M8 0x19
#define MESON_CPU_MAJOR_ID_MTVD 0x1a
#define MESON_CPU_MAJOR_ID_M8B 0x1b
#define MESON_CPU_MAJOR_ID_MG9TV 0x1c
#define MESON_CPU_MAJOR_ID_M8M2 0x1d
#define MESON_CPU_MAJOR_ID_GXBB 0x1f
#define MESON_CPU_MAJOR_ID_GXTVBB 0x20
#define MESON_CPU_MAJOR_ID_GXL 0x21
#define MESON_CPU_MAJOR_ID_GXM 0x22
#define MESON_CPU_MAJOR_ID_TXL 0x23
static inline int get_cpu_type(void)
{
	return MESON_CPU_MAJOR_ID_GXL;
}

/* canvas：厂商用的三个宏 + 我们自己实现的 canvas_config()。 */
#define CANVAS_ADDR_NOWRAP 0x00
#define CANVAS_ADDR_WRAPX 0x01
#define CANVAS_ADDR_WRAPY 0x02
#define CANVAS_BLKMODE_LINEAR 0x00
#define CANVAS_BLKMODE_32X32 0x01
#define CANVAS_BLKMODE_64X32 0x02
void canvas_config(u32 index, ulong addr, u32 width, u32 height, u32 wrap,
		   u32 blkmode);

/* dma_alloc_coherent 拿来的内存本身是 uncached 的，不需要刷缓存。 */
static inline void dma_flush(u32 buf_start, u32 buf_size) {}
static inline void cache_flush(u32 buf_start, u32 buf_size) {}

/* 厂商代码在 vdec2 分支里引用，这块板没有 vdec2。 */
#define abort_vdec2_flag 0

#endif /* MESON_HCODEC_KMSHIM_H */
