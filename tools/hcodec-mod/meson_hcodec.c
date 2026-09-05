// SPDX-License-Identifier: MIT OR GPL-2.0
/*
 * meson_hcodec — Amlogic GXL (S905X/S905L) HCODEC H.264 编码器，树外模块。
 *
 * docs/hcodec-encoder-plan.md 的阶段 1a：把阶段 0 那个 /dev/mem 原型
 * （tools/hcenc/hcenc.c，实机出过 4579 字节的 1280x720 Baseline IDR）
 * 原封不动搬进内核 —— 同一套寄存器序列、同一份厂商切片、同一张合成图，
 * insmod 时自测编一帧，码流从 debugfs 出来给 ffprobe 看。
 *
 * 厂商切片（vendor.inc / venc_types.h / *_regs.h）不在本仓库里，
 * 由 tools/hcenc/fetch-vendor.sh 下载后拼到同一个目录再编，见 README.md。
 *
 * 有意的差别（阶段 0 的脚本在这两处会踩到 meson-vdec）：
 *   - HHI_VDEC_CLK_CNTL 只改 hcodec 那半个字（[27:16]），不整字覆盖 ——
 *     低半个字是 vdec_1 的时钟。
 *   - DOS_GCLK_EN0 用 |=，DOS_SW_RESET1 只打 hcodec 相关的位。
 */

#include <linux/debugfs.h>
#include <linux/dma-mapping.h>
#include <linux/firmware.h>
#include <linux/fs.h>
#include <linux/moduleparam.h>
#include <linux/platform_device.h>
#include <linux/vmalloc.h>

#include "kmshim.h"

void __iomem *hc_dos;
void __iomem *hc_dmc;
static void __iomem *hc_hhi;
static void __iomem *hc_ao;
u32 hc_log_level = LOG_ERROR;

static unsigned int width = 1280;
static unsigned int height = 720;
static unsigned int qp = 26;
static bool selftest = true;
static bool blanket_reset;
static unsigned int stage = 9;
static bool poweron = true;
static char *marklog = "/root/hcodec-stage.log";
module_param(width, uint, 0444);
MODULE_PARM_DESC(width, "自测帧宽度（默认 1280）");
module_param(height, uint, 0444);
MODULE_PARM_DESC(height, "自测帧高度（默认 720）");
module_param(qp, uint, 0444);
MODULE_PARM_DESC(qp, "固定 QP（默认 26）");
module_param(selftest, bool, 0444);
MODULE_PARM_DESC(selftest, "insmod 时编一帧合成 IDR（默认开）");
module_param(blanket_reset, bool, 0444);
MODULE_PARM_DESC(blanket_reset,
		 "上电时用厂商的 DOS_SW_RESET1=0xffffffff（会打断正在解码的 vdec）");
module_param(stage, uint, 0444);
MODULE_PARM_DESC(stage,
		 "只跑到第 N 步：1 映射 2 上电 3 scratch 4 ucode 5 起 AMRISC 6 编一帧（默认 9）");
module_param(poweron, bool, 0444);
MODULE_PARM_DESC(poweron, "自己做上电序列（关掉 = 相信外面已经上过电，默认开）");
module_param(marklog, charp, 0444);
MODULE_PARM_DESC(marklog,
		 "每步落盘一行的进度日志，硬挂之后最后一行就是挂住的那步（空串关掉）");
module_param_named(log_level, hc_log_level, uint, 0644);
MODULE_PARM_DESC(log_level, "厂商日志阈值：0 全开 3 只报错（默认 3）");

/* 厂商头 + 切片，由 fetch-vendor.sh 放到同一个目录里 */
#include "hcodec_regs.h"
#include "dos_regs.h"
#include "dmc_regs.h"
#include "venc_types.h"
#include "venc_defs.h"

/* canvas LUT 在 DMC 里，word 下标 */
#define DC_CAV_LUT_DATAL 0x12
#define DC_CAV_LUT_DATAH 0x13
#define DC_CAV_LUT_ADDR 0x14
#define DC_CAV_LUT_RDATAL 0x15
#define DC_CAV_LUT_RDATAH 0x16
#define CANVAS_LUT_WR_EN (1 << 9)
#define CANVAS_LUT_RD_EN (1 << 8)

void canvas_config(u32 index, ulong addr, u32 cwidth, u32 cheight, u32 wrap,
		   u32 blkmode)
{
	WRITE_DMCREG(DC_CAV_LUT_DATAL, (((addr + 7) >> 3) & 0x1fffffff) |
					       ((((cwidth + 7) >> 3) & 0x7) << 29));
	WRITE_DMCREG(DC_CAV_LUT_DATAH, ((((cwidth + 7) >> 3) >> 3) & 0x1ff) |
					       ((cheight & 0x1fff) << 9) |
					       ((wrap & 0x3) << 23) |
					       ((blkmode & 0x3) << 24));
	WRITE_DMCREG(DC_CAV_LUT_ADDR, CANVAS_LUT_WR_EN | (index & 0xff));
	(void)READ_DMCREG(DC_CAV_LUT_DATAH);
}

static void canvas_read(u32 index, u32 *lo, u32 *hi)
{
	WRITE_DMCREG(DC_CAV_LUT_ADDR, CANVAS_LUT_RD_EN | (index & 0xff));
	(void)READ_DMCREG(DC_CAV_LUT_DATAH);
	*lo = READ_DMCREG(DC_CAV_LUT_RDATAL);
	*hi = READ_DMCREG(DC_CAV_LUT_RDATAH);
}

#include "vendor.inc"

/* ------------------------------------------------------------------ */
/* 缓冲区：1080p buffspec 要 0x1370000，ucode 挂在尾巴上              */
/* ------------------------------------------------------------------ */
#define HC_BUF_SIZE 0x1380000u
#define HC_UCODE_OFF 0x1370000u
#define HC_UCODE_LEN 0x4000u
#define HC_FW_NAME "video/h264_enc.bin"
#define HC_FW_GXL_OFF 51712u

/* amvenc_reset() 用的那一组，只碰 hcodec */
#define HC_RESET_BITS                                                       \
	((1 << 2) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 14) | (1 << 16) | \
	 (1 << 17))

static struct platform_device *hc_pdev;
static void *hc_va;
static dma_addr_t hc_pa;
static struct encode_wq_s hc_wq;
static struct dentry *hc_dir;
static struct debugfs_blob_wrapper hc_blob;
static void *hc_out;
static bool hc_powered;
static bool hc_running;

/* ------------------------------------------------------------------ */
/* 进度标记。硬挂（总线停等 → 看门狗复位）之后 dmesg / pstore 什么都不剩，    */
/* 所以每一步都往盘上写一行并 fsync：重启后最后一行就是挂住的那一步。       */
/* ------------------------------------------------------------------ */
static struct file *hc_logf;
static loff_t hc_logpos;

static void hc_mark(const char *what)
{
	char line[80];
	int n;

	pr_info("hcodec: >>> %s\n", what);
	if (!hc_logf)
		return;
	n = scnprintf(line, sizeof(line), "%s\n", what);
	if (kernel_write(hc_logf, line, n, &hc_logpos) > 0)
		vfs_fsync(hc_logf, 1);
}

/* ------------------------------------------------------------------ */
/* 上电 / 断电：厂商 avc_poweron() 的七步，和 tools/hcenc/hcodec_up.sh  */
/* 逐步对应，只是 AO / HHI / GCLK 三处改成读改写。                     */
/* ------------------------------------------------------------------ */
static void hc_poweron(void)
{
	u32 v;

	/* 1. hcodec 电域上电：SLEEP0[1:0] = 0 */
	v = readl(hc_ao + AO_PWR_SLEEP0_OFF);
	writel(v & ~0x3u, hc_ao + AO_PWR_SLEEP0_OFF);
	udelay(10);

	/* 2. 复位脉冲。默认只打 hcodec 的位，不动 vdec。 */
	WRITE_VREG(DOS_SW_RESET1, blanket_reset ? 0xffffffffu : HC_RESET_BITS);
	WRITE_VREG(DOS_SW_RESET1, 0);

	/* 3. hcodec 时钟：[27:25] sel=0 fclk_div4，[22:16] div=2（÷3），[24] en
	 *    → 166.7 MHz（实测 166,664,063 Hz）。低半个字是 vdec_1，别碰。
	 *    源 2 的 fclk_div5 被 CCF 当无人用关掉了，选它是 0 Hz。
	 */
	v = readl(hc_hhi + HHI_VDEC_CLK_CNTL_OFF);
	writel((v & ~0x0fff0000u) | 0x01020000u, hc_hhi + HHI_VDEC_CLK_CNTL_OFF);

	/* 4. DOS_GCLK_EN0[26:12]，vdec 的位保留 */
	WRITE_VREG(DOS_GCLK_EN0, READ_VREG(DOS_GCLK_EN0) | 0x07fff000u);

	/* 5. hcodec 内部 RAM 上电 */
	WRITE_VREG(DOS_MEM_PD_HCODEC, 0);

	/* 6. 解除隔离：ISO0[5:4] = 0。这一步之前读任何 hcodec 子块寄存器会挂总线。 */
	v = readl(hc_ao + AO_PWR_ISO0_OFF);
	writel(v & ~0x30u, hc_ao + AO_PWR_ISO0_OFF);
	udelay(10);

	/* 7. 踢一下自动时钟门 */
	WRITE_VREG(DOS_GEN_CTRL0, 1);
	WRITE_VREG(DOS_GEN_CTRL0, 0);

	/* 厂商 avc_poweron() 结尾的 mdelay(10)，别省。上电后立刻读 hcodec 子块
	 * （0xc8824xxx/0xc8826xxx）会挂总线：整机死等到看门狗复位，dmesg 不留字。
	 */
	mdelay(10);
	hc_powered = true;
}

static void hc_poweroff(void)
{
	u32 v;

	if (!hc_powered)
		return;
	v = readl(hc_ao + AO_PWR_ISO0_OFF);
	writel(v | 0x30u, hc_ao + AO_PWR_ISO0_OFF);
	WRITE_VREG(DOS_MEM_PD_HCODEC, 0xffffffffu);
	v = readl(hc_hhi + HHI_VDEC_CLK_CNTL_OFF);
	writel(v & ~0x0fff0000u, hc_hhi + HHI_VDEC_CLK_CNTL_OFF);
	v = readl(hc_ao + AO_PWR_SLEEP0_OFF);
	writel(v | 0x3u, hc_ao + AO_PWR_SLEEP0_OFF);
	hc_powered = false;
}

/* 上电真的成了没成，靠 ENCODER_STATUS（= HENC_SCRATCH_0）能不能存住数判断。
 * 没上电时这里读回来是 0 或者直接挂总线。
 */
static int hc_scratch_test(void)
{
	static const u32 pat[] = { 0xa5a5a5a5, 0x5a5a5a5a, 0xdeadbeef, 0 };
	int i;

	for (i = 0; i < ARRAY_SIZE(pat); i++) {
		u32 got;

		WRITE_HREG(ENCODER_STATUS, pat[i]);
		got = READ_HREG(ENCODER_STATUS);
		if (got != pat[i]) {
			pr_err("hcodec: scratch 写 %08x 读回 %08x，上电失败\n",
			       pat[i], got);
			return -EIO;
		}
	}
	return 0;
}

/* ------------------------------------------------------------------ */
/* ucode：/lib/firmware/video/h264_enc.bin 是 KCAP 容器，gxl 那份载荷从   */
/* 偏移 51712 开始，只有头 16 KB 会 DMA 进 IMEM。                        */
/* ------------------------------------------------------------------ */
static int hc_load_ucode(struct device *dev)
{
	const struct firmware *fw;
	unsigned long spins = 0;
	int ret;

	hc_mark("4a ucode: request_firmware");
	ret = request_firmware(&fw, HC_FW_NAME, dev);
	if (ret) {
		dev_err(dev, "缺 %s（%d）\n", HC_FW_NAME, ret);
		return ret;
	}
	if (fw->size < HC_FW_GXL_OFF + HC_UCODE_LEN) {
		dev_err(dev, "%s 只有 %zu 字节，装不下 gxl 载荷\n", HC_FW_NAME,
			fw->size);
		release_firmware(fw);
		return -EINVAL;
	}
	memcpy((u8 *)hc_va + HC_UCODE_OFF, fw->data + HC_FW_GXL_OFF,
	       HC_UCODE_LEN);
	release_firmware(fw);

	hc_mark("4c ucode: IMEM DMA");
	WRITE_HREG(HCODEC_IMEM_DMA_ADR, (u32)(hc_pa + HC_UCODE_OFF));
	WRITE_HREG(HCODEC_IMEM_DMA_COUNT, 0x1000);
	WRITE_HREG(HCODEC_IMEM_DMA_CTRL, 0x8000 | (7 << 16));
	while (READ_HREG(HCODEC_IMEM_DMA_CTRL) & 0x8000) {
		if (++spins > 1000000UL) {
			dev_err(dev, "IMEM DMA 超时 ctrl=0x%08x\n",
				READ_HREG(HCODEC_IMEM_DMA_CTRL));
			return -ETIMEDOUT;
		}
		cpu_relax();
	}
	dev_info(dev, "ucode 已装载（%lu 轮，ctrl=0x%08x）\n", spins,
		 READ_HREG(HCODEC_IMEM_DMA_CTRL));
	return 0;
}

static int hc_wait(u32 want, unsigned int ms)
{
	unsigned int i;

	for (i = 0; i < ms * 10; i++) {
		u32 s = READ_HREG(ENCODER_STATUS);

		if (s == want)
			return 0;
		if (s == ENCODER_ERROR) {
			pr_err("hcodec: ucode 报 ENCODER_ERROR\n");
			return -EIO;
		}
		usleep_range(80, 160);
	}
	pr_err("hcodec: 等 status=%u 超时，现在是 %u\n", want,
	       READ_HREG(ENCODER_STATUS));
	return -ETIMEDOUT;
}

/* ------------------------------------------------------------------ */
/* 工作队列：create_encode_work_queue + CONFIG_INIT 的最小可用子集       */
/* ------------------------------------------------------------------ */
static void hc_wq_init(u32 w, u32 h)
{
	struct encode_wq_s *wq = &hc_wq;
	int i;

	memset(wq, 0, sizeof(*wq));
	wq->ucode_index = UCODE_MODE_FULL;
	wq->pic.init_qppicture = qp;
	wq->pic.log2_max_frame_num = 4;
	wq->pic.log2_max_pic_order_cnt_lsb = 4;
	wq->pic.encoder_width = w;
	wq->pic.encoder_height = h;
	wq->pic.rows_per_slice = (h + 15) >> 4; /* 一帧一个 slice */
	wq->qp_table_id = 0;
	for (i = 0; i < 8; i++) {
		u32 word = (qp << 24) | (qp << 16) | (qp << 8) | qp;

		wq->quant_tbl_i4[0][i] = word;
		wq->quant_tbl_i16[0][i] = word;
		wq->quant_tbl_me[0][i] = word;
	}
	wq->mem.buf_start = (u32)hc_pa;
	wq->mem.buf_size = HC_BUF_SIZE;
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
}

/* amvenc_avc_start() 去掉 avc_poweron（上面单独做了）的部分。拆成 prep（canvas
 * + ucode）和 go（复位 + 初始化 + 放 AMRISC 跑），好让 stage= 停在中间。
 */
static int hc_hw_prep(struct device *dev)
{
	struct encode_wq_s *wq = &hc_wq;
	u32 lo, hi, i;

	/* canvas 0xE4..0xEF 必须没人占 */
	hc_mark("4-pre canvas_read x12");
	for (i = 0; i < 12; i++) {
		canvas_read(ENC_CANVAS_OFFSET + i, &lo, &hi);
		if (lo || hi)
			dev_warn(dev, "canvas[%02x] 已被占用：%08x %08x\n",
				 ENC_CANVAS_OFFSET + i, lo, hi);
	}

	hc_mark("4-pre avc_canvas_init");
	avc_canvas_init(wq);
	hc_mark("4-pre ASSIST_MMC_CTRL1");
	WRITE_HREG(HCODEC_ASSIST_MMC_CTRL1, 0x32);

	return hc_load_ucode(dev);
}

static int hc_hw_go(struct device *dev)
{
	struct encode_wq_s *wq = &hc_wq;

	hc_mark("5a amvenc_reset");
	amvenc_reset();
	hc_mark("5b avc_init_encoder");
	avc_init_encoder(wq, true);
	hc_mark("5c avc_init_input/output_buffer");
	avc_init_input_buffer(wq);
	avc_init_output_buffer(wq);
	ie_me_mode = (0 & ME_PIXEL_MODE_MASK) << ME_PIXEL_MODE_SHIFT;
	hc_mark("5d avc_prot_init");
	avc_prot_init(wq, NULL, wq->pic.init_qppicture, true);
	hc_mark("5e dblk/ref/assit buffer");
	avc_init_dblk_buffer(wq->mem.dblk_buf_canvas);
	avc_init_reference_buffer(wq->mem.ref_buf_canvas);
	avc_init_assit_buffer(wq);
	ie_me_mb_type = 0;
	hc_mark("5f avc_init_ie_me_parameter");
	avc_init_ie_me_parameter(wq, wq->pic.init_qppicture);
	WRITE_HREG(ENCODER_STATUS, ENCODER_IDLE);
	WRITE_HREG(FIXED_SLICE_CFG, 0);
	hc_mark("5g amvenc_start (MPSR=1)");
	amvenc_start();
	hc_running = true;
	usleep_range(20000, 25000);
	hc_mark("5h AMRISC 起来了");
	dev_info(dev, "AMRISC 起来了：MPSR=%08x CPSR=%08x PC=%04x\n",
		 READ_HREG(HCODEC_MPSR), READ_HREG(HCODEC_CPSR),
		 READ_HREG(HCODEC_MPC_P));
	return 0;
}

/* ------------------------------------------------------------------ */
/* 编码核心。SEQUENCE → PICTURE → IDR 的顺序和等待点都不能改：VLC 在      */
/* SEQUENCE_DONE 时并不落盘，只有 PICTURE_DONE 之后 VB_WR_PTR 才动。     */
/* ------------------------------------------------------------------ */
static struct encode_request_s hc_rq;

static int hc_headers(u32 *hdr_bytes)
{
	struct encode_wq_s *wq = &hc_wq;
	struct encode_request_s *rq = &hc_rq;
	int ret;

	memset(rq, 0, sizeof(*rq));
	rq->parent = wq;
	rq->ucode_mode = UCODE_MODE_FULL;
	rq->cmd = ENCODER_SEQUENCE;
	rq->quant = wq->pic.init_qppicture;
	rq->type = LOCAL_BUFF;
	rq->fmt = FMT_NV12;
	rq->src = wq->mem.dct_buff_start_addr;
	rq->framesize = wq->pic.encoder_width * wq->pic.encoder_height * 3 / 2;
	rq->src_w = wq->pic.encoder_width;
	rq->src_h = wq->pic.encoder_height;

	/* 第一条命令走厂商的 need_reset 路径；这里不能再 amvenc_start()，
	 * AMRISC 已经在跑，amvenc_reset() 不碰 DOS_SW_RESET1 的 11/12 位。
	 */
	hc_mark("6b headers: reset + re-init");
	amvenc_reset();
	avc_canvas_init(wq);
	avc_init_encoder(wq, false);
	avc_init_input_buffer(wq);
	avc_init_output_buffer(wq);
	avc_prot_init(wq, rq, rq->quant, false);
	avc_init_assit_buffer(wq);
	ie_me_mb_type = 0;
	avc_init_ie_me_parameter(wq, rq->quant);
	WRITE_HREG(FIXED_SLICE_CFG, 0);
	hc_mark("6c ENCODER_SEQUENCE");
	WRITE_HREG(ENCODER_STATUS, ENCODER_SEQUENCE);
	ret = hc_wait(ENCODER_SEQUENCE_DONE, 2000);
	if (ret)
		return ret;

	hc_mark("6d ENCODER_PICTURE");
	WRITE_HREG(ENCODER_STATUS, ENCODER_PICTURE);
	ret = hc_wait(ENCODER_PICTURE_DONE, 2000);
	if (ret)
		return ret;

	hc_mark("6e PICTURE_DONE");
	*hdr_bytes = READ_HREG(HCODEC_VLC_TOTAL_BYTES);
	return 0;
}

static int hc_encode_idr(u32 src_phys, u32 framesize)
{
	struct encode_wq_s *wq = &hc_wq;
	struct encode_request_s *rq = &hc_rq;

	rq->cmd = ENCODER_IDR;
	rq->flush_flag = AMVENC_FLUSH_FLAG_INPUT;
	rq->src = src_phys;
	rq->framesize = framesize;

	avc_init_dblk_buffer(wq->mem.dblk_buf_canvas);
	avc_init_reference_buffer(wq->mem.ref_buf_canvas);
	hc_mark("6f set_input_format");
	if (set_input_format(wq, rq)) {
		pr_err("hcodec: set_input_format 失败\n");
		return -EINVAL;
	}
	ie_me_mb_type = HENC_MB_Type_I4MB;
	avc_init_ie_me_parameter(wq, rq->quant);
	WRITE_HREG(FIXED_SLICE_CFG, 0);
	hc_mark("6g ENCODER_IDR");
	WRITE_HREG(ENCODER_STATUS, ENCODER_IDR);
	return hc_wait(ENCODER_IDR_DONE, 8000);
}

/* ------------------------------------------------------------------ */
/* 自测：和阶段 0 一模一样的合成 NV12 图，好让字节数能直接对照           */
/* （1280x720 QP26 那次是 4579 字节）。码流从 debugfs 出去。            */
/* ------------------------------------------------------------------ */
static void hc_fill_frame(u32 w, u32 h)
{
	u32 cw = ((w + 31) >> 5) << 5;
	u32 py = ((h + 15) >> 4) << 4;
	u8 *fy = hc_va;
	u8 *fuv = fy + cw * py;
	u32 x, y;

	for (y = 0; y < py; y++)
		for (x = 0; x < cw; x++)
			fy[y * cw + x] = (u8)(16 + ((x * 8 / cw) * 27));
	for (y = 0; y < py / 2; y++)
		for (x = 0; x < cw; x += 2) {
			fuv[y * cw + x] = (u8)(128 + 100 * (x > cw / 2));
			fuv[y * cw + x + 1] = (u8)(128 - 100 * (y > py / 4));
		}
}

static int hc_selftest(struct device *dev)
{
	struct encode_wq_s *wq = &hc_wq;
	u32 cw = ((width + 31) >> 5) << 5;
	u32 py = ((height + 15) >> 4) << 4;
	u32 hdr = 0, hdr_pad, total, nbytes;
	const u8 *bs;
	int ret;

	hc_mark("6a fill_frame");
	hc_fill_frame(width, height);

	ret = hc_headers(&hdr);
	if (ret) {
		dev_err(dev, "SPS/PPS 没出来（%d）\n", ret);
		return ret;
	}

	ret = hc_encode_idr(wq->mem.dct_buff_start_addr, cw * py * 3 / 2);
	if (ret) {
		dev_err(dev, "IDR 没出来（%d）\n", ret);
		return ret;
	}

	hc_mark("6h IDR_DONE，读字节数");
	total = READ_HREG(HCODEC_VLC_TOTAL_BYTES);
	nbytes = READ_HREG(HCODEC_VLC_VB_WR_PTR) -
		 READ_HREG(HCODEC_VLC_VB_START_PTR);
	if (!total || total > wq->mem.bufspec.bitstream.buf_size ||
	    nbytes < total) {
		dev_err(dev, "字节数不合理：total=%u vb=%u\n", total, nbytes);
		return -EIO;
	}

	/* 命令之间 VLC 会用 0xff 把上一段 NAL 补到 8 字节边界，那几个字节会
	 * 破坏 rbsp_trailing_bits，所以两段分别拷、把填充丢掉。
	 */
	hdr_pad = (hdr + 7) & ~7u;
	hc_out = kvmalloc(total, GFP_KERNEL);
	if (!hc_out)
		return -ENOMEM;
	bs = (const u8 *)hc_va + wq->mem.bufspec.bitstream.buf_start;
	memcpy(hc_out, bs, hdr);
	memcpy((u8 *)hc_out + hdr, bs + hdr_pad, total - hdr);

	hc_blob.data = hc_out;
	hc_blob.size = total;
	debugfs_create_blob("out.h264", 0444, hc_dir, &hc_blob);
	dev_info(dev,
		 "自测通过：%ux%u QP%u → %u 字节（%u 头 + %u IDR），"
		 "从 /sys/kernel/debug/meson-hcodec/out.h264 取\n",
		 width, height, qp, total, hdr, total - hdr);
	return 0;
}

/* ------------------------------------------------------------------ */
static void hc_teardown(void)
{
	if (hc_running) {
		amvenc_stop();
		hc_running = false;
	}
	hc_poweroff();
	debugfs_remove_recursive(hc_dir);
	hc_dir = NULL;
	kvfree(hc_out);
	hc_out = NULL;
	if (hc_va) {
		dma_free_coherent(&hc_pdev->dev, HC_BUF_SIZE, hc_va, hc_pa);
		hc_va = NULL;
	}
	if (hc_pdev) {
		platform_device_unregister(hc_pdev);
		hc_pdev = NULL;
	}
	if (hc_ao)
		iounmap(hc_ao);
	if (hc_hhi)
		iounmap(hc_hhi);
	if (hc_dmc)
		iounmap(hc_dmc);
	if (hc_dos)
		iounmap(hc_dos);
	hc_ao = hc_hhi = NULL;
	hc_dmc = hc_dos = NULL;
	if (hc_logf) {
		filp_close(hc_logf, NULL);
		hc_logf = NULL;
	}
}

static int __init hc_init(void)
{
	struct device *dev;
	int ret;

	if (width < 16 || height < 16 || width > 1920 || height > 1088)
		return -EINVAL;

	if (marklog && *marklog) {
		hc_logf = filp_open(marklog, O_WRONLY | O_CREAT | O_TRUNC, 0644);
		if (IS_ERR(hc_logf))
			hc_logf = NULL;
		hc_logpos = 0;
	}
	hc_mark("0 insmod");

	/* DOS 窗口和 meson-vdec 是同一块，所以不能 request_mem_region。
	 * 我们只碰 hcodec 的子块，见 docs/hcodec-encoder-plan.md 阶段 1 第 5 点。
	 */
	hc_mark("1a ioremap");
	hc_dos = ioremap(HC_DOS_BASE, HC_DOS_SIZE);
	hc_dmc = ioremap(HC_DMC_BASE, HC_DMC_SIZE);
	hc_hhi = ioremap(HC_HHI_BASE, HC_HHI_SIZE);
	hc_ao = ioremap(HC_AO_BASE, HC_AO_SIZE);
	if (!hc_dos || !hc_dmc || !hc_hhi || !hc_ao) {
		ret = -ENOMEM;
		goto out;
	}

	hc_mark("1b platform_device + dma_alloc_coherent");
	hc_pdev = platform_device_register_simple("meson-hcodec", -1, NULL, 0);
	if (IS_ERR(hc_pdev)) {
		ret = PTR_ERR(hc_pdev);
		hc_pdev = NULL;
		goto out;
	}
	dev = &hc_pdev->dev;
	ret = dma_coerce_mask_and_coherent(dev, DMA_BIT_MASK(32));
	if (ret)
		goto out;

	hc_va = dma_alloc_coherent(dev, HC_BUF_SIZE, &hc_pa, GFP_KERNEL);
	if (!hc_va) {
		dev_err(dev, "CMA 里拿不到 %u 字节（看 /proc/meminfo 的 CmaFree）\n",
			HC_BUF_SIZE);
		ret = -ENOMEM;
		goto out;
	}
	if (hc_pa + HC_BUF_SIZE > 0x100000000ULL) {
		dev_err(dev, "缓冲区跨过 4 GB：%pad\n", &hc_pa);
		ret = -ENOMEM;
		goto out;
	}
	dev_info(dev, "缓冲区 %u 字节 @ %pad\n", HC_BUF_SIZE, &hc_pa);

	hc_dir = debugfs_create_dir("meson-hcodec", NULL);

	if (stage < 2) {
		hc_mark("1 只做映射，停在这里");
		return 0;
	}

	if (poweron) {
		hc_mark("2 hc_poweron");
		hc_poweron();
	}
	if (stage < 3) {
		hc_mark("2 上电完，停在这里");
		return 0;
	}

	hc_mark("3 scratch test");
	ret = hc_scratch_test();
	if (ret)
		goto out;
	if (stage < 4) {
		hc_mark("3 scratch 过了，停在这里");
		return 0;
	}

	hc_mark("4 wq_init");
	hc_wq_init(width, height);
	ret = hc_hw_prep(dev);
	if (ret)
		goto out;
	if (stage < 5) {
		hc_mark("4 ucode 装好了，停在这里");
		return 0;
	}

	ret = hc_hw_go(dev);
	if (ret)
		goto out;
	if (stage < 6) {
		hc_mark("5 AMRISC 在跑，停在这里");
		return 0;
	}

	if (selftest) {
		ret = hc_selftest(dev);
		if (ret)
			goto out;
	}
	hc_mark("6 全过");
	return 0;

out:
	hc_teardown();
	return ret;
}

static void __exit hc_exit(void)
{
	hc_teardown();
}

module_init(hc_init);
module_exit(hc_exit);
MODULE_DESCRIPTION("Amlogic GXL HCODEC H.264 encoder (out-of-tree, stage 1a)");
MODULE_LICENSE("Dual MIT/GPL");
MODULE_FIRMWARE(HC_FW_NAME);







