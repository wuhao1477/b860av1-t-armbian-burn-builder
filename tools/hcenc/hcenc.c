/* hcenc — userspace H.264 encoder prototype for Amlogic S905L (B860AV1.1-T).
 *
 * Stage 0 of docs/hcodec-encoder-plan.md: drive the HCODEC block entirely from
 * userspace via /dev/mem + one hugepage, no kernel module, no reflash.
 *
 * Requires /root/hcodec_up.sh to have run first (power domain + clock + de-iso).
 *
 * usage: hcenc [width height [nframes]]
 *   writes /root/out.h264 and logs to /root/hcenc.log
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <errno.h>
#include <time.h>
#ifndef MAP_HUGETLB
#define MAP_HUGETLB 0x40000
#endif
#ifndef MAP_HUGE_SHIFT
#define MAP_HUGE_SHIFT 26
#endif

#include "kshim.h"

volatile uint32_t *dos;
volatile uint32_t *dmc;
FILE *lg;
u32 encode_print_level_shim = LOG_INFO;

#define PAGE_SIZE 4096
#define SZ_1M (1024 * 1024)

#include "hcodec_regs.h"
#include "dos_regs.h"
#include "dmc_regs.h"
#include "venc_types.h"
#include "venc_defs.h"

/* --- shim bodies the vendor code calls --- */

#define DC_CAV_LUT_DATAL 0x12
#define DC_CAV_LUT_DATAH 0x13
#define DC_CAV_LUT_ADDR 0x14
#define DC_CAV_LUT_RDATAL 0x15
#define DC_CAV_LUT_RDATAH 0x16
#define CANVAS_LUT_WR_EN (1 << 9)
#define CANVAS_LUT_RD_EN (1 << 8)

void canvas_config(u32 index, ulong addr, u32 width, u32 height, u32 wrap,
		   u32 blkmode)
{
	WRITE_DMCREG(DC_CAV_LUT_DATAL,
		     (((addr + 7) >> 3) & 0x1fffffff) |
			     ((((width + 7) >> 3) & 0x7) << 29));
	WRITE_DMCREG(DC_CAV_LUT_DATAH,
		     ((((width + 7) >> 3) >> 3) & 0x1ff) |
			     ((height & 0x1fff) << 9) |
			     ((wrap & 0x3) << 23) | ((blkmode & 0x3) << 24));
	WRITE_DMCREG(DC_CAV_LUT_ADDR, CANVAS_LUT_WR_EN | (index & 0xff));
	(void)READ_DMCREG(DC_CAV_LUT_DATAH);
	fprintf(lg, "canvas[%02x] addr=0x%lx %ux%u\n", index, addr, width,
		height);
}

static void canvas_read(u32 index, uint32_t *l, uint32_t *h)
{
	WRITE_DMCREG(DC_CAV_LUT_ADDR, CANVAS_LUT_RD_EN | (index & 0xff));
	(void)READ_DMCREG(DC_CAV_LUT_DATAH);
	*l = READ_DMCREG(DC_CAV_LUT_RDATAL);
	*h = READ_DMCREG(DC_CAV_LUT_RDATAH);
}

/* The DOS DMA engine is not IO-coherent; EL0 dc civac is legal (SCTLR_EL1.UCI). */
void clean_dcache_range(void *p, size_t len)
{
	char *end = (char *)p + len;
	for (char *l = (char *)((uintptr_t)p & ~63UL); l < end; l += 64)
		asm volatile("dc civac, %0" ::"r"(l) : "memory");
	asm volatile("dsb sy" ::: "memory");
}

/* Buffers live in one hugepage we own; flush the whole thing instead of
 * translating phys back to virt. Set by main(). */
static void *g_base_va;
static size_t g_base_len;

void dma_flush(u32 phys, u32 size)
{
	(void)phys;
	(void)size;
	if (g_base_va)
		clean_dcache_range(g_base_va, g_base_len);
}
void cache_flush(u32 phys, u32 size) { dma_flush(phys, size); }

unsigned long jiffies_shim(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * HZ + ts.tv_nsec / (1000000000L / HZ);
}
void udelay(unsigned long us) { usleep(us); }
void msleep(unsigned long ms) { usleep(ms * 1000); }

#define ENOMEM_ 12
#define EBUSY_ 16

#include "vendor.inc"

/* ------------------------------------------------------------------ */
/* firmware load: KCAP container, gxl_h264_enc.bin payload at 51712    */
/* ------------------------------------------------------------------ */
#define FW_PATH "/lib/firmware/video/h264_enc.bin"
#define GXL_OFF 51712
#define MC_SIZE_B (4096 * 4)

static int load_mc(uint32_t mc_phys, void *mc_va)
{
	int fd = open(FW_PATH, O_RDONLY);
	if (fd < 0) {
		fprintf(lg, "open %s: %s\n", FW_PATH, strerror(errno));
		return -1;
	}
	if (pread(fd, mc_va, MC_SIZE_B, GXL_OFF) != MC_SIZE_B) {
		fprintf(lg, "pread ucode failed\n");
		close(fd);
		return -1;
	}
	close(fd);
	clean_dcache_range(mc_va, MC_SIZE_B);

	WRITE_HREG(HCODEC_IMEM_DMA_ADR, mc_phys);
	WRITE_HREG(HCODEC_IMEM_DMA_COUNT, 0x1000);
	WRITE_HREG(HCODEC_IMEM_DMA_CTRL, (0x8000 | (7 << 16)));
	long spins = 0;
	while (READ_HREG(HCODEC_IMEM_DMA_CTRL) & 0x8000) {
		if (++spins > 20000000L) {
			fprintf(lg, "IMEM DMA timeout ctrl=0x%08x\n",
				READ_HREG(HCODEC_IMEM_DMA_CTRL));
			return -1;
		}
	}
	fprintf(lg, "ucode loaded, %ld spins, ctrl=0x%08x\n", spins,
		READ_HREG(HCODEC_IMEM_DMA_CTRL));
	return 0;
}

/* ------------------------------------------------------------------ */
/* physical address of a locked mapping, cross-checked via /dev/mem    */
/* ------------------------------------------------------------------ */
static int phys_of(void *va, int memfd, uint64_t *out)
{
	int pm = open("/proc/self/pagemap", O_RDONLY);
	if (pm < 0)
		return -1;
	uint64_t e;
	off_t off = ((uintptr_t)va / PAGE_SIZE) * 8;
	if (pread(pm, &e, 8, off) != 8) {
		close(pm);
		return -1;
	}
	close(pm);
	if (!(e & (1ULL << 63))) {
		fprintf(lg, "page not present\n");
		return -1;
	}
	uint64_t phys = (e & ((1ULL << 55) - 1)) * PAGE_SIZE;

	/* cross-check: a wrong PFN must fail here, not become a stray DMA */
	volatile uint32_t *v = (volatile uint32_t *)va;
	v[0] = 0xc0ffee01;
	v[1] = 0xc0ffee02;
	clean_dcache_range(va, 64);
	void *chk = mmap(NULL, PAGE_SIZE, PROT_READ, MAP_SHARED, memfd,
			 (off_t)phys);
	if (chk == MAP_FAILED) {
		fprintf(lg, "phys crosscheck mmap: %s\n", strerror(errno));
		return -1;
	}
	uint32_t a = ((volatile uint32_t *)chk)[0];
	uint32_t b = ((volatile uint32_t *)chk)[1];
	munmap(chk, PAGE_SIZE);
	if (a != 0xc0ffee01 || b != 0xc0ffee02) {
		fprintf(lg, "PHYS MISMATCH at 0x%llx: %08x %08x\n",
			(unsigned long long)phys, a, b);
		return -1;
	}
	fprintf(lg, "phys 0x%llx verified\n", (unsigned long long)phys);
	*out = phys;
	return 0;
}

/* ------------------------------------------------------------------ */
static void dump_state(const char *tag)
{
	fprintf(lg,
		"%-14s STATUS=%-4u MPSR=%08x CPSR=%08x PC=%04x/%04x/%04x/%04x TOTAL=%u\n",
		tag, READ_HREG(ENCODER_STATUS), READ_HREG(HCODEC_MPSR),
		READ_HREG(HCODEC_CPSR), READ_HREG(HCODEC_MPC_P),
		READ_HREG(HCODEC_MPC_D), READ_HREG(HCODEC_MPC_E),
		READ_HREG(HCODEC_MPC_W), READ_HREG(HCODEC_VLC_TOTAL_BYTES));
	fflush(lg);
}

static void dump_vb(const char *tag)
{
	u32 s = READ_HREG(HCODEC_VLC_VB_START_PTR);
	u32 wr = READ_HREG(HCODEC_VLC_VB_WR_PTR);
	fprintf(lg,
		"%-14s VB start=%08x wr=%08x rd=%08x end=%08x wr-start=%d ctl=%08x total=%u\n",
		tag, s, wr, READ_HREG(HCODEC_VLC_VB_SW_RD_PTR),
		READ_HREG(HCODEC_VLC_VB_END_PTR), (int)(wr - s),
		READ_HREG(HCODEC_VLC_STATUS_CTRL),
		READ_HREG(HCODEC_VLC_TOTAL_BYTES));
	fflush(lg);
}

static int wait_status(u32 want, int ms)
{
	for (int i = 0; i < ms * 10; i++) {
		u32 s = READ_HREG(ENCODER_STATUS);
		if (s == want)
			return 0;
		if (s == ENCODER_ERROR) {
			fprintf(lg, "ucode reported ENCODER_ERROR\n");
			return -1;
		}
		usleep(100);
	}
	return -1;
}

int main(int argc, char **argv)
{
	u32 w = 1280, h = 720;
	if (argc >= 3) {
		w = strtoul(argv[1], NULL, 0);
		h = strtoul(argv[2], NULL, 0);
	}

	lg = fopen("/root/hcenc.log", "a");
	if (!lg)
		lg = stderr;
	setvbuf(lg, NULL, _IOLBF, 0);
	fprintf(lg, "\n=== hcenc %ux%u ===\n", w, h);

	int memfd = open("/dev/mem", O_RDWR | O_SYNC);
	if (memfd < 0) {
		fprintf(lg, "open /dev/mem: %s\n", strerror(errno));
		return 1;
	}
	dos = mmap(NULL, DOS_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, memfd,
		   DOS_BASE);
	dmc = mmap(NULL, DMC_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, memfd,
		   DMC_BASE);
	if (dos == MAP_FAILED || dmc == MAP_FAILED) {
		fprintf(lg, "mmap mmio: %s\n", strerror(errno));
		return 1;
	}

	/* one 32 MB hugepage covers the whole 1080p buffspec (0x1370000) */
	g_base_len = 32UL << 20;
	g_base_va = mmap(NULL, g_base_len, PROT_READ | PROT_WRITE,
			 MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB |
				 (25 << MAP_HUGE_SHIFT),
			 -1, 0);
	if (g_base_va == MAP_FAILED) {
		fprintf(lg, "hugepage 32M: %s (echo 1 > /sys/kernel/mm/hugepages/hugepages-32768kB/nr_hugepages)\n",
			strerror(errno));
		return 1;
	}
	memset(g_base_va, 0, g_base_len);
	if (mlock(g_base_va, g_base_len)) {
		fprintf(lg, "mlock: %s\n", strerror(errno));
		return 1;
	}
	uint64_t base_phys;
	if (phys_of(g_base_va, memfd, &base_phys))
		return 1;

	/* canvas 0xE4..0xEF must be unused by the kernel */
	for (u32 i = 0; i < 12; i++) {
		uint32_t l, hi;
		canvas_read(ENC_CANVAS_OFFSET + i, &l, &hi);
		fprintf(lg, "canvas[%02x] before: %08x %08x%s\n",
			ENC_CANVAS_OFFSET + i, l, hi,
			(l || hi) ? "   <-- IN USE" : "");
	}

	/* ---- work queue, mirroring create_encode_work_queue + CONFIG_INIT ---- */
	static struct encode_wq_s wq_s;
	struct encode_wq_s *wq = &wq_s;
	wq->ucode_index = UCODE_MODE_FULL;
	wq->pic.init_qppicture = 26;
	wq->pic.log2_max_frame_num = 4;
	wq->pic.log2_max_pic_order_cnt_lsb = 4;
	wq->pic.encoder_width = w;
	wq->pic.encoder_height = h;
	wq->pic.rows_per_slice = (h + 15) >> 4; /* one slice per frame */
	wq->qp_table_id = 0;
	for (int i = 0; i < 8; i++) {
		u32 q = wq->pic.init_qppicture;
		u32 word = (q << 24) | (q << 16) | (q << 8) | q;
		wq->quant_tbl_i4[0][i] = word;
		wq->quant_tbl_i16[0][i] = word;
		wq->quant_tbl_me[0][i] = word;
	}
	wq->mem.buf_start = (u32)base_phys;
	wq->mem.buf_size = g_base_len;
	wq->mem.cur_buf_lev = AMVENC_BUFFER_LEVEL_1080P;
	memcpy(&wq->mem.bufspec, &amvenc_buffspec[AMVENC_BUFFER_LEVEL_1080P],
	       sizeof(struct BuffInfo_s));
	wq->mem.inter_bits_info_ddr_start_addr =
		wq->mem.buf_start + wq->mem.bufspec.inter_bits_info.buf_start;
	wq->mem.inter_mv_info_ddr_start_addr =
		wq->mem.buf_start + wq->mem.bufspec.inter_mv_info.buf_start;
	wq->mem.intra_bits_info_ddr_start_addr =
		wq->mem.buf_start + wq->mem.bufspec.intra_bits_info.buf_start;
	wq->mem.intra_pred_info_ddr_start_addr =
		wq->mem.buf_start + wq->mem.bufspec.intra_pred_info.buf_start;
	wq->mem.sw_ctl_info_start_addr =
		wq->mem.buf_start + wq->mem.bufspec.qp_info.buf_start;
	wq->mem.scaler_buff_start_addr =
		wq->mem.buf_start + wq->mem.bufspec.scale_buff.buf_start;
	wq->mem.dump_info_ddr_start_addr =
		wq->mem.inter_bits_info_ddr_start_addr;
	avc_buffspec_init(wq);

	InitEncodeWeight();

	/* ---- amvenc_avc_start(), minus avc_poweron (hcodec_up.sh did it) ---- */
	avc_canvas_init(wq);
	WRITE_HREG(HCODEC_ASSIST_MMC_CTRL1, 0x32);

	/* ucode goes at the tail of the hugepage, past every encode buffer */
	uint32_t mc_phys = (uint32_t)(base_phys + (31UL << 20));
	void *mc_va = (char *)g_base_va + (31UL << 20);
	if (load_mc(mc_phys, mc_va))
		return 1;

	amvenc_reset();
	avc_init_encoder(wq, true);
	avc_init_input_buffer(wq);
	avc_init_output_buffer(wq);
	ie_me_mode = (0 & ME_PIXEL_MODE_MASK) << ME_PIXEL_MODE_SHIFT;
	avc_prot_init(wq, NULL, wq->pic.init_qppicture, true);
	avc_init_dblk_buffer(wq->mem.dblk_buf_canvas);
	avc_init_reference_buffer(wq->mem.ref_buf_canvas);
	avc_init_assit_buffer(wq);
	ie_me_mb_type = 0;
	avc_init_ie_me_parameter(wq, wq->pic.init_qppicture);
	WRITE_HREG(ENCODER_STATUS, ENCODER_IDLE);
	WRITE_HREG(FIXED_SLICE_CFG, 0);
	dump_state("before-start");
	amvenc_start();
	usleep(20000);
	dump_state("running");

	/* ---- de-risking step: SPS/PPS only ---- */
	struct encode_request_s rq;
	memset(&rq, 0, sizeof(rq));
	rq.parent = wq;
	rq.ucode_mode = UCODE_MODE_FULL;
	rq.cmd = ENCODER_SEQUENCE;
	rq.quant = wq->pic.init_qppicture;
	rq.type = LOCAL_BUFF;
	rq.fmt = FMT_NV12;
	rq.src = wq->mem.dct_buff_start_addr;
	rq.framesize = w * h * 3 / 2;
	rq.src_w = w;
	rq.src_h = h;

	/* first command takes the vendor's need_reset path (venc.c:3150). No
	 * amvenc_start() here — reload_flag is 0, the AMRISC is already running
	 * and amvenc_reset() does not touch DOS_SW_RESET1 bits 11/12. */
	amvenc_reset();
	avc_canvas_init(wq);
	avc_init_encoder(wq, false);
	avc_init_input_buffer(wq);
	avc_init_output_buffer(wq);
	avc_prot_init(wq, &rq, rq.quant, false);
	avc_init_assit_buffer(wq);
	ie_me_mb_type = 0;
	avc_init_ie_me_parameter(wq, rq.quant);
	WRITE_HREG(FIXED_SLICE_CFG, 0);
	dump_vb("pre-sequence");
	WRITE_HREG(ENCODER_STATUS, ENCODER_SEQUENCE);

	int rc = wait_status(ENCODER_SEQUENCE_DONE, 2000);
	dump_state("after-sequence");
	dump_vb("after-sequence");
	if (rc) {
		fprintf(lg, "SEQUENCE did not complete\n");
		amvenc_stop();
		return 1;
	}
	u32 sps = READ_HREG(HCODEC_VLC_TOTAL_BYTES);

	/* venc.c:4045 — SEQUENCE_DONE is followed straight by ENCODER_PICTURE;
	 * the vendor only reads the bitstream after PICTURE_DONE. */
	WRITE_HREG(ENCODER_STATUS, ENCODER_PICTURE);
	rc = wait_status(ENCODER_PICTURE_DONE, 2000);
	dump_state("after-picture");
	dump_vb("after-picture");
	if (rc) {
		fprintf(lg, "PICTURE did not complete\n");
		amvenc_stop();
		return 1;
	}

	u32 hdr = READ_HREG(HCODEC_VLC_TOTAL_BYTES);

	/* ---- IDR frame on a synthetic NV12 picture ---- */
	u32 cw = ((w + 31) >> 5) << 5;
	u32 py = ((h + 15) >> 4) << 4;
	unsigned char *fy = (unsigned char *)g_base_va;
	unsigned char *fuv = fy + cw * py;
	for (u32 y = 0; y < py; y++)
		for (u32 x = 0; x < cw; x++)
			fy[y * cw + x] = (unsigned char)(16 + ((x * 8 / cw) * 27));
	for (u32 y = 0; y < py / 2; y++)
		for (u32 x = 0; x < cw; x += 2) {
			fuv[y * cw + x] = (unsigned char)(128 + 100 * (x > cw / 2));
			fuv[y * cw + x + 1] = (unsigned char)(128 - 100 * (y > py / 4));
		}
	clean_dcache_range(fy, (size_t)cw * py * 3 / 2);

	rq.cmd = ENCODER_IDR;
	rq.flush_flag = AMVENC_FLUSH_FLAG_INPUT;
	rq.framesize = cw * py * 3 / 2;
	/* per-frame path only (venc.c:3167+); need_reset was consumed above */
	avc_init_dblk_buffer(wq->mem.dblk_buf_canvas);
	avc_init_reference_buffer(wq->mem.ref_buf_canvas);
	if (set_input_format(wq, &rq)) {
		fprintf(lg, "set_input_format failed\n");
		amvenc_stop();
		return 1;
	}
	ie_me_mb_type = HENC_MB_Type_I4MB;
	avc_init_ie_me_parameter(wq, rq.quant);
	WRITE_HREG(FIXED_SLICE_CFG, 0);
	WRITE_HREG(ENCODER_STATUS, ENCODER_IDR);
	rc = wait_status(ENCODER_IDR_DONE, 8000);
	dump_state("after-idr");
	dump_vb("after-idr");
	if (rc)
		fprintf(lg, "IDR did not complete (keeping SPS/PPS)\n");

	u32 real = READ_HREG(HCODEC_VLC_TOTAL_BYTES);
	u32 nbytes = READ_HREG(HCODEC_VLC_VB_WR_PTR) -
		     READ_HREG(HCODEC_VLC_VB_START_PTR);
	fprintf(lg, "SPS=%u PPS=%u total_counter=%u vb_bytes=%u\n", sps,
		hdr - sps, real, nbytes);
	if (nbytes == 0 || nbytes > wq->mem.bufspec.bitstream.buf_size) {
		fprintf(lg, "implausible size, stopping\n");
		amvenc_stop();
		return 1;
	}

	/* where did it actually land? */
	u32 vb_start = READ_HREG(HCODEC_VLC_VB_START_PTR);
	u32 vb_wr = READ_HREG(HCODEC_VLC_VB_WR_PTR);
	u32 vb_rd = READ_HREG(HCODEC_VLC_VB_SW_RD_PTR);
	u32 vb_end = READ_HREG(HCODEC_VLC_VB_END_PTR);
	fprintf(lg,
		"VB start=%08x wr=%08x rd=%08x end=%08x  wr-start=%d ctl=%08x\n",
		vb_start, vb_wr, vb_rd, vb_end, (int)(vb_wr - vb_start),
		READ_HREG(HCODEC_VLC_STATUS_CTRL));

	unsigned char *bs = (unsigned char *)g_base_va +
			    wq->mem.bufspec.bitstream.buf_start;
	clean_dcache_range(bs, nbytes + 64);
	fprintf(lg, "head:");
	for (u32 i = 0; i < 32; i++)
		fprintf(lg, " %02x", bs[i]);
	fprintf(lg, "\ntail:");
	for (u32 i = (nbytes > 16 ? nbytes - 16 : 0); i < nbytes; i++)
		fprintf(lg, " %02x", bs[i]);
	fprintf(lg, "\n");

	/* The VLC pads to an 8-byte boundary between commands with 0xff, which
	 * corrupts the preceding NAL's rbsp_trailing_bits for any decoder that
	 * only strips trailing zeros. Emit the two runs, drop the fill. */
	u32 hdr_pad = (hdr + 7) & ~7u;
	FILE *out = fopen("/root/out.h264", "wb");
	if (out) {
		fwrite(bs, 1, hdr, out);
		fwrite(bs + hdr_pad, 1, real - hdr, out);
		fclose(out);
		fprintf(lg, "wrote /root/out.h264 (%u bytes: %u hdr + %u idr)\n",
			real, hdr, real - hdr);
	}

	amvenc_stop();
	dump_state("stopped");
	fprintf(lg, "=== done ===\n");
	return 0;
}
