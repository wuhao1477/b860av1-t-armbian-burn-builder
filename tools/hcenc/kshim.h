/* Minimal shims so the vendor kernel code compiles as a userspace program.
 * Valid because DOS/HCODEC byte offset == vendor word index << 2, so a
 * volatile uint32_t * can be indexed directly by the vendor register name.
 */
#ifndef KSHIM_H
#define KSHIM_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <unistd.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t s32;
typedef unsigned long ulong;

struct list_head { void *a, *b; };
typedef struct { int c; } atomic_t;
typedef struct { int c; } wait_queue_head_t;
typedef struct { int c; } spinlock_t;
struct page;

/* ---- MMIO ---- */
#define DOS_BASE 0xC8820000UL
#define DOS_SIZE 0x10000
#define DMC_BASE 0xC8838000UL
#define DMC_SIZE 0x1000

extern volatile uint32_t *dos;
extern volatile uint32_t *dmc;

#define WRITE_HREG(r, v) (dos[(r) & 0x3fff] = (uint32_t)(v))
#define READ_HREG(r) (dos[(r) & 0x3fff])
#define WRITE_VREG(r, v) (dos[(r) & 0x3fff] = (uint32_t)(v))
#define READ_VREG(r) (dos[(r) & 0x3fff])
#define WRITE_DMCREG(r, v) (dmc[(r) & 0x3ff] = (uint32_t)(v))
#define READ_DMCREG(r) (dmc[(r) & 0x3ff])

/* ---- logging ---- */
extern FILE *lg;
#define LOG_ALL 0
#define LOG_INFO 1
#define LOG_DEBUG 2
#define LOG_ERROR 3
extern u32 encode_print_level_shim;
#define enc_pr(level, x...)                       \
	do {                                      \
		if ((level) >= LOG_INFO) {        \
			fprintf(lg, x);           \
			fflush(lg);               \
		}                                 \
	} while (0)

/* ---- cpu type: this board is GXL ---- */
#define MESON_CPU_MAJOR_ID_M8B 0x1b
#define MESON_CPU_MAJOR_ID_MTVD 0x1c
#define MESON_CPU_MAJOR_ID_M8M2 0x1D
#define MESON_CPU_MAJOR_ID_GXBB 0x1F
#define MESON_CPU_MAJOR_ID_GXTVBB 0x20
#define MESON_CPU_MAJOR_ID_GXL 0x21
#define MESON_CPU_MAJOR_ID_GXM 0x22
#define MESON_CPU_MAJOR_ID_TXL 0x23
#define get_cpu_type() MESON_CPU_MAJOR_ID_GXL

/* ---- canvas ---- */
#define CANVAS_ADDR_NOWRAP 0
#define CANVAS_ADDR_WRAPX 1
#define CANVAS_ADDR_WRAPY 2
#define CANVAS_BLKMODE_LINEAR 0
#define CANVAS_BLKMODE_32X32 1
#define CANVAS_BLKMODE_64X32 2
void canvas_config(u32 index, ulong addr, u32 width, u32 height, u32 wrap,
		   u32 blkmode);

/* ---- cache / dma ---- */
void clean_dcache_range(void *p, size_t len);
void dma_flush(u32 phys, u32 size);
void cache_flush(u32 phys, u32 size);

/* ---- time ---- */
#define HZ 100
unsigned long jiffies_shim(void);
#define jiffies jiffies_shim()
#define time_after(a, b) ((long)((b) - (a)) < 0)
void udelay(unsigned long us);
void msleep(unsigned long ms);

/* things vendor code references but we do not use */
#define DEFINE_SPINLOCK(x) int x##_unused_
#define abort_vdec2_flag 0

#endif
