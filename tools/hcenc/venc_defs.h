/* Defines lifted from the top of the vendor encoder.c (venc.c 55-87) that the
 * extracted function bodies depend on. */
#ifndef VENC_DEFS_H
#define VENC_DEFS_H

#define AMVENC_CANVAS_INDEX 0xE4
#define AMVENC_CANVAS_MAX_INDEX 0xEF
#define MIN_SIZE 20
#define DUMP_INFO_BYTES_PER_MB 80
#define ADJUSTED_QP_FLAG 64
#define MULTI_SLICE_MC
#define INTRA_IN_P_TOP
#define ENC_CANVAS_OFFSET AMVENC_CANVAS_INDEX
#define UCODE_MODE_FULL 0
#define UCODE_MODE_SW_MIX 1

/* v_encoder.h 39-40 */
#define HCODEC_IRQ_MBOX_CLR HCODEC_ASSIST_MBOX2_CLR_REG
#define HCODEC_IRQ_MBOX_MASK HCODEC_ASSIST_MBOX2_MASK

/* Only the two fields the extracted code reads. UCODE_MODE_FULL, and
 * dblk_fix_flag is false on GXL (vendor sets it only on >= MG9TV). */
struct {
	u32 ucode_index;
	bool dblk_fix_flag;
} encode_manager = { UCODE_MODE_FULL, false };

#endif
