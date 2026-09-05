// SPDX-License-Identifier: MIT OR GPL-2.0
/*
 * meson_hcodec — Amlogic GXL (S905X/S905L) HCODEC H.264 编码器，树外模块。
 *
 * docs/hcodec-encoder-plan.md 的阶段 1：先把阶段 0 那个 /dev/mem 原型
 * （tools/hcenc/hcenc.c，实机出过 4579 字节的 1280x720 Baseline IDR）
 * 原封不动搬进内核（1a，insmod 时自测编一帧），再包成 V4L2 stateful M2M
 * 编码器（1b，OUTPUT 收 NV12/NV21/YUV420，CAPTURE 出 H.264），
 * 让 ffmpeg 的 h264_v4l2m2m 和 gstreamer 的 v4l2h264enc 零补丁能用。
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
#include <linux/workqueue.h>
#include <media/v4l2-ctrls.h>
#include <media/v4l2-device.h>
#include <media/v4l2-event.h>
#include <media/v4l2-ioctl.h>
#include <media/v4l2-mem2mem.h>
#include <media/videobuf2-dma-contig.h>

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

/* GXBB+ 的 FULL ucode 里真正生效的 QP 是量化表的第 0 个字节，不是
 * avc_prot_init() 的 quant 参数（vendor.inc:1509 起会用表里的值覆盖它）。
 * 所以每帧换 QP 都要重填这三张表。
 */
static void hc_set_qp(u32 q)
{
	struct encode_wq_s *wq = &hc_wq;
	u32 word = (q << 24) | (q << 16) | (q << 8) | q;
	int i;

	wq->pic.init_qppicture = q;
	for (i = 0; i < 8; i++) {
		wq->quant_tbl_i4[0][i] = word;
		wq->quant_tbl_i16[0][i] = word;
		wq->quant_tbl_me[0][i] = word;
	}
}

/* ------------------------------------------------------------------ */
/* 工作队列：create_encode_work_queue + CONFIG_INIT 的最小可用子集       */
/* ------------------------------------------------------------------ */
static void hc_wq_init(u32 w, u32 h)
{
	struct encode_wq_s *wq = &hc_wq;

	memset(wq, 0, sizeof(*wq));
	wq->ucode_index = UCODE_MODE_FULL;
	wq->pic.log2_max_frame_num = 4;
	wq->pic.log2_max_pic_order_cnt_lsb = 4;
	wq->pic.encoder_width = w;
	wq->pic.encoder_height = h;
	wq->pic.rows_per_slice = (h + 15) >> 4; /* 一帧一个 slice */
	wq->qp_table_id = 0;
	hc_set_qp(qp);
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
static u8 hc_hdr[64];	/* 缓存的 SPS+PPS，每个 IDR 前面重新贴一份 */
static u32 hc_hdr_len;

static int hc_headers(void)
{
	struct encode_wq_s *wq = &hc_wq;
	struct encode_request_s *rq = &hc_rq;
	u32 n;
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

	/* SPS+PPS 现在才在 DRAM 里。下一帧会重置 VB_WR_PTR 把它们盖掉，
	 * 所以立刻拷走；命令末尾那几个 0xff 对齐字节不要（会破坏
	 * rbsp_trailing_bits，只剥零的解码器会报 non-existing PPS）。
	 */
	hc_mark("6e PICTURE_DONE");
	n = READ_HREG(HCODEC_VLC_TOTAL_BYTES);
	if (!n || n > sizeof(hc_hdr))
		return -EIO;
	memcpy(hc_hdr, (u8 *)hc_va + wq->mem.bufspec.bitstream.buf_start, n);
	hc_hdr_len = n;
	return 0;
}

/* 一帧。照厂商 need_reset 那条路走全量重初始化 —— ISR 在每个 *_DONE
 * （除 SEQUENCE_DONE）之后都置 need_reset，所以厂商实际上每帧都走这一段。
 * 不能省：FRAME_NUMBER / PIC_ORDER_CNT_LSB / VLC_TOTAL_BYTES 只有
 * avc_init_encoder() 会写，不重初始化第二帧的 slice header 就是错的。
 */
static int hc_frame(bool idr, u32 src_phys, u32 fmt, u32 quant, u32 *bytes)
{
	struct encode_wq_s *wq = &hc_wq;
	struct encode_request_s *rq = &hc_rq;
	u32 cmd = idr ? ENCODER_IDR : ENCODER_NON_IDR;
	int ret;

	memset(rq, 0, sizeof(*rq));
	rq->parent = wq;
	rq->ucode_mode = UCODE_MODE_FULL;
	rq->cmd = cmd;
	rq->quant = quant;
	/* PHYSICAL_BUFF：src 就当物理地址用。LOCAL_BUFF 会强行改成
	 * dct_buff_start_addr（vendor.inc:1194），V4L2 的缓冲区就喂不进去了。
	 */
	rq->type = PHYSICAL_BUFF;
	rq->fmt = fmt;
	rq->src = src_phys;
	rq->src_w = wq->pic.encoder_width;
	rq->src_h = wq->pic.encoder_height;
	rq->framesize = wq->pic.encoder_width * wq->pic.encoder_height * 3 / 2;

	hc_set_qp(quant);
	amvenc_reset();
	avc_canvas_init(wq);
	avc_init_encoder(wq, idr);
	avc_init_input_buffer(wq);
	avc_init_output_buffer(wq);
	avc_prot_init(wq, rq, quant, idr);
	avc_init_assit_buffer(wq);
	avc_init_dblk_buffer(wq->mem.dblk_buf_canvas);
	avc_init_reference_buffer(wq->mem.ref_buf_canvas);
	if (set_input_format(wq, rq)) {
		pr_err("hcodec: set_input_format 失败\n");
		return -EINVAL;
	}
	ie_me_mb_type = idr ? HENC_MB_Type_I4MB :
			      ((HENC_SKIP_RUN_AUTO << 16) |
			       (HENC_MB_Type_AUTO << 4) | HENC_MB_Type_AUTO);
	avc_init_ie_me_parameter(wq, quant);
	WRITE_HREG(FIXED_SLICE_CFG, 0);
	WRITE_HREG(ENCODER_STATUS, cmd);
	ret = hc_wait(idr ? ENCODER_IDR_DONE : ENCODER_NON_IDR_DONE, 8000);
	if (ret)
		return ret;
	*bytes = READ_HREG(HCODEC_VLC_TOTAL_BYTES);

	/* 帧后推进，对应厂商的 AMVENC_AVC_IOC_SUBMIT（venc.c:3875）：计数器是
	 * 编完这帧才动的，所以 IDR 编出来是 frame_num=0，下一帧才是 1；
	 * 刚写好的 dblk 缓冲区变成下一帧的参考帧。
	 */
	if (idr) {
		wq->pic.idr_pic_id = (wq->pic.idr_pic_id + 1) & 0xffff;
		wq->pic.pic_order_cnt_lsb = 2;
		wq->pic.frame_number = 1;
	} else {
		wq->pic.frame_number = (wq->pic.frame_number + 1) & 0xffff;
		wq->pic.pic_order_cnt_lsb += 2;
	}
	swap(wq->mem.dblk_buf_canvas, wq->mem.ref_buf_canvas);
	return 0;
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
	u32 total = 0, nbytes;
	int ret;

	hc_mark("6a fill_frame");
	hc_fill_frame(width, height);

	ret = hc_headers();
	if (ret) {
		dev_err(dev, "SPS/PPS 没出来（%d）\n", ret);
		return ret;
	}

	hc_mark("6g ENCODER_IDR");
	ret = hc_frame(true, wq->mem.dct_buff_start_addr, FMT_NV12, qp, &total);
	if (ret) {
		dev_err(dev, "IDR 没出来（%d）\n", ret);
		return ret;
	}

	hc_mark("6h IDR_DONE，读字节数");
	nbytes = READ_HREG(HCODEC_VLC_VB_WR_PTR) -
		 READ_HREG(HCODEC_VLC_VB_START_PTR);
	if (!total || total > wq->mem.bufspec.bitstream.buf_size ||
	    nbytes < total) {
		dev_err(dev, "字节数不合理：total=%u vb=%u\n", total, nbytes);
		return -EIO;
	}

	/* 每帧都重跑 avc_init_output_buffer()，VB_WR_PTR 回到 BitstreamStart，
	 * 所以 IDR 是从 0 开始写的，不用再躲命令之间那几个 0xff 对齐字节。
	 */
	hc_out = kvmalloc(hc_hdr_len + total, GFP_KERNEL);
	if (!hc_out)
		return -ENOMEM;
	memcpy(hc_out, hc_hdr, hc_hdr_len);
	memcpy((u8 *)hc_out + hc_hdr_len,
	       (u8 *)hc_va + wq->mem.bufspec.bitstream.buf_start, total);

	hc_blob.data = hc_out;
	hc_blob.size = hc_hdr_len + total;
	debugfs_create_blob("out.h264", 0444, hc_dir, &hc_blob);
	dev_info(dev,
		 "自测通过：%ux%u QP%u → %u 字节（%u 头 + %u IDR），"
		 "从 /sys/kernel/debug/meson-hcodec/out.h264 取\n",
		 width, height, qp, hc_hdr_len + total, hc_hdr_len, total);
	return 0;
}

/* ------------------------------------------------------------------ */
/* 阶段 1b：V4L2 stateful M2M 编码器。OUTPUT 收 NV12/NV21/YUV420，        */
/* CAPTURE 出 H.264。硬件只有一份（一套 canvas、一份参考帧），所以同一时刻  */
/* 只允许一个 ctx，第二个 open() 直接 -EBUSY。                           */
/* ------------------------------------------------------------------ */
#define HC_BS_MAX 0x100000u /* = bufspec[1080P].bitstream.buf_size */
#define HC_BS_MIN 0x80000u

struct hc_ctx {
	struct v4l2_fh fh;
	struct v4l2_ctrl_handler ctrls;
	struct work_struct work;
	u32 fourcc;		/* OUTPUT 的像素格式 */
	u32 width, height;	/* 都是 16 的倍数：ucode 按整 MB 编，没有 crop */
	u32 bytesperline;	/* MFDIN 硬要求：NV12/21 对齐 32，YUV420 对齐 64 */
	u32 sizeimage, bs_size;
	u32 fps_num, fps_den;
	u32 gop, bitrate, qp_i, qp_p, qp_min, qp_max;
	u32 cur_qp, since_idr;
	bool force_idr, hw_ready;
};

static struct v4l2_device hc_v4l2;
static struct v4l2_m2m_dev *hc_m2m;
static struct workqueue_struct *hc_workq;
static DEFINE_MUTEX(hc_lock);
static bool hc_ctx_busy;

static const u32 hc_out_fourcc[] = {
	V4L2_PIX_FMT_NV12,
	V4L2_PIX_FMT_NV21,
	V4L2_PIX_FMT_YUV420,
};

static u32 hc_vendor_fmt(u32 fourcc)
{
	switch (fourcc) {
	case V4L2_PIX_FMT_NV21:
		return FMT_NV21;
	case V4L2_PIX_FMT_YUV420:
		return FMT_YUV420;
	default:
		return FMT_NV12;
	}
}

/* set_input_format() 会拿这个跨度去配 canvas，用户态必须按同一个跨度填。 */
static u32 hc_stride(u32 fourcc, u32 w)
{
	return fourcc == V4L2_PIX_FMT_YUV420 ? ALIGN(w, 64) : ALIGN(w, 32);
}

static void hc_fmt_out(struct hc_ctx *ctx, struct v4l2_pix_format *pix)
{
	pix->pixelformat = ctx->fourcc;
	pix->width = ctx->width;
	pix->height = ctx->height;
	pix->field = V4L2_FIELD_NONE;
	pix->bytesperline = ctx->bytesperline;
	pix->sizeimage = ctx->sizeimage;
	pix->colorspace = V4L2_COLORSPACE_REC709;
	pix->quantization = V4L2_QUANTIZATION_LIM_RANGE;
}

static void hc_fmt_cap(struct hc_ctx *ctx, struct v4l2_pix_format *pix)
{
	pix->pixelformat = V4L2_PIX_FMT_H264;
	pix->width = ctx->width;
	pix->height = ctx->height;
	pix->field = V4L2_FIELD_NONE;
	pix->bytesperline = 0;
	pix->sizeimage = ctx->bs_size;
	pix->colorspace = V4L2_COLORSPACE_REC709;
	pix->quantization = V4L2_QUANTIZATION_LIM_RANGE;
}

static inline struct hc_ctx *hc_fh(struct file *f)
{
	return container_of(f->private_data, struct hc_ctx, fh);
}

/* 几何一变就得重来一遍：wq_init 会重算 canvas 和各缓冲区偏移，ucode 也要重装。 */
static int hc_hw_setup(struct hc_ctx *ctx)
{
	struct device *dev = &hc_pdev->dev;
	int ret;

	if (ctx->hw_ready)
		return 0;
	if (hc_running) {
		amvenc_stop();
		hc_running = false;
	}
	if (!hc_powered)
		hc_poweron();

	hc_wq_init(ctx->width, ctx->height);
	ret = hc_hw_prep(dev);
	if (!ret)
		ret = hc_hw_go(dev);
	if (!ret)
		ret = hc_headers();
	if (ret) {
		dev_err(dev, "V4L2 启动失败（%d）\n", ret);
		return ret;
	}
	ctx->cur_qp = ctx->qp_i;
	ctx->hw_ready = true;
	return 0;
}

/* ponytail: 一拍反馈的码率控制，够 ffmpeg 用。真要 CBR 再上二次模型。 */
static void hc_rate(struct hc_ctx *ctx, u32 got)
{
	u32 target;

	if (!ctx->bitrate || !ctx->fps_den)
		return;
	target = ctx->bitrate / 8 * ctx->fps_num / ctx->fps_den;
	if (!target)
		return;
	if (got > target + target / 8 && ctx->cur_qp < ctx->qp_max)
		ctx->cur_qp++;
	else if (got < target - target / 4 && ctx->cur_qp > ctx->qp_min)
		ctx->cur_qp--;
}

/* device_run 不能直接编：hc_wait 要睡，而且 job_finish 会当场回调下一轮 →
 * 递归。照 vim2m 的做法丢进 work，work 里不拿 hc_lock（stop_streaming 拿着它
 * flush_workqueue）。
 */
static void hc_work(struct work_struct *w)
{
	struct hc_ctx *ctx = container_of(w, struct hc_ctx, work);
	struct vb2_v4l2_buffer *src, *dst;
	u32 total = 0, off = 0;
	bool idr;
	u8 *out;
	int ret, q;

	src = v4l2_m2m_next_src_buf(ctx->fh.m2m_ctx);
	dst = v4l2_m2m_next_dst_buf(ctx->fh.m2m_ctx);
	if (!src || !dst) {
		/* 不该发生（streamoff 会先等 job_finish），但漏了就是永久挂住 */
		v4l2_m2m_job_finish(hc_m2m, ctx->fh.m2m_ctx);
		return;
	}

	idr = ctx->force_idr || !ctx->since_idr ||
	      (ctx->gop && ctx->since_idr >= ctx->gop);
	ctx->force_idr = false;
	out = vb2_plane_vaddr(&dst->vb2_buf, 0);

	/* ponytail: 码流从 CMA memcpy 出来。1 MB/帧 @30fps 才 30 MB/s，
	 * 想零拷贝就得把 BitstreamStart 指到 CAPTURE 缓冲区上，等有人嫌慢再说。
	 */
	if (!out) {
		ret = -EFAULT;	/* DMABUF 进来的没有内核映射 */
		goto done;
	}
	if (idr) {
		memcpy(out, hc_hdr, hc_hdr_len);
		off = hc_hdr_len;
	}
	ctx->cur_qp = clamp(ctx->cur_qp, ctx->qp_min, ctx->qp_max);
	q = ctx->cur_qp;
	if (!idr)	/* I/P 的差值由控件给，反馈只动 cur_qp */
		q = clamp_t(int, q + (int)ctx->qp_p - (int)ctx->qp_i,
			    ctx->qp_min, ctx->qp_max);
	ret = hc_frame(idr, (u32)vb2_dma_contig_plane_dma_addr(&src->vb2_buf, 0),
		       hc_vendor_fmt(ctx->fourcc), q, &total);
	if (!ret && off + total > vb2_plane_size(&dst->vb2_buf, 0))
		ret = -ENOSPC;
	if (!ret) {
		memcpy(out + off,
		       (u8 *)hc_va + hc_wq.mem.bufspec.bitstream.buf_start,
		       total);
		vb2_set_plane_payload(&dst->vb2_buf, 0, off + total);
		ctx->since_idr = idr ? 1 : ctx->since_idr + 1;
		hc_rate(ctx, off + total);
	}

done:
	if (ret) {
		v4l2_err(&hc_v4l2, "编码失败（%d），idr=%d\n", ret, idr);
		vb2_set_plane_payload(&dst->vb2_buf, 0, 0);
	}
	v4l2_m2m_buf_copy_metadata(src, dst, false);
	dst->flags &= ~(V4L2_BUF_FLAG_KEYFRAME | V4L2_BUF_FLAG_PFRAME);
	dst->flags |= idr ? V4L2_BUF_FLAG_KEYFRAME : V4L2_BUF_FLAG_PFRAME;

	/* 这个 helper 顺手做 draining 的 V4L2_BUF_FLAG_LAST，别自己 remove+done */
	v4l2_m2m_buf_done_and_job_finish(hc_m2m, ctx->fh.m2m_ctx,
					 ret ? VB2_BUF_STATE_ERROR :
					       VB2_BUF_STATE_DONE);
}

static void hc_device_run(void *priv)
{
	struct hc_ctx *ctx = priv;

	queue_work(hc_workq, &ctx->work);
}

static int hc_queue_setup(struct vb2_queue *q, unsigned int *nbufs,
			  unsigned int *nplanes, unsigned int sizes[],
			  struct device *alloc_devs[])
{
	struct hc_ctx *ctx = vb2_get_drv_priv(q);
	u32 want = V4L2_TYPE_IS_OUTPUT(q->type) ? ctx->sizeimage : ctx->bs_size;

	if (*nplanes) {
		if (*nplanes != 1 || sizes[0] < want)
			return -EINVAL;
		return 0;
	}
	*nplanes = 1;
	sizes[0] = want;
	return 0;
}

static int hc_buf_prepare(struct vb2_buffer *vb)
{
	struct hc_ctx *ctx = vb2_get_drv_priv(vb->vb2_queue);
	bool is_out = V4L2_TYPE_IS_OUTPUT(vb->vb2_queue->type);
	u32 want = is_out ? ctx->sizeimage : ctx->bs_size;

	if (vb2_plane_size(vb, 0) < want)
		return -EINVAL;
	if (is_out)
		vb2_set_plane_payload(vb, 0, want);
	return 0;
}

static void hc_buf_queue(struct vb2_buffer *vb)
{
	struct hc_ctx *ctx = vb2_get_drv_priv(vb->vb2_queue);

	v4l2_m2m_buf_queue(ctx->fh.m2m_ctx, to_vb2_v4l2_buffer(vb));
}

static void hc_return_bufs(struct hc_ctx *ctx, struct vb2_queue *q,
			   enum vb2_buffer_state st)
{
	struct vb2_v4l2_buffer *vb;

	for (;;) {
		vb = V4L2_TYPE_IS_OUTPUT(q->type) ?
			     v4l2_m2m_src_buf_remove(ctx->fh.m2m_ctx) :
			     v4l2_m2m_dst_buf_remove(ctx->fh.m2m_ctx);
		if (!vb)
			return;
		v4l2_m2m_buf_done(vb, st);
	}
}

static int hc_start_streaming(struct vb2_queue *q, unsigned int count)
{
	struct hc_ctx *ctx = vb2_get_drv_priv(q);
	int ret = hc_hw_setup(ctx);

	if (ret) {
		hc_return_bufs(ctx, q, VB2_BUF_STATE_QUEUED);
		return ret;
	}
	ctx->since_idr = 0;
	ctx->force_idr = true;
	v4l2_m2m_update_start_streaming_state(ctx->fh.m2m_ctx, q);
	return 0;
}

static void hc_stop_streaming(struct vb2_queue *q)
{
	static const struct v4l2_event eos = { .type = V4L2_EVENT_EOS };
	struct hc_ctx *ctx = vb2_get_drv_priv(q);

	flush_workqueue(hc_workq);
	hc_return_bufs(ctx, q, VB2_BUF_STATE_ERROR);
	v4l2_m2m_update_stop_streaming_state(ctx->fh.m2m_ctx, q);
	if (V4L2_TYPE_IS_OUTPUT(q->type) &&
	    v4l2_m2m_has_stopped(ctx->fh.m2m_ctx))
		v4l2_event_queue_fh(&ctx->fh, &eos);
}

static const struct vb2_ops hc_vb2_ops = {
	.queue_setup = hc_queue_setup,
	.buf_prepare = hc_buf_prepare,
	.buf_queue = hc_buf_queue,
	.start_streaming = hc_start_streaming,
	.stop_streaming = hc_stop_streaming,
	.wait_prepare = vb2_ops_wait_prepare,
	.wait_finish = vb2_ops_wait_finish,
};

static int hc_queue_init(void *priv, struct vb2_queue *src,
			 struct vb2_queue *dst)
{
	struct hc_ctx *ctx = priv;
	struct vb2_queue *q;
	int i, ret;

	for (i = 0; i < 2; i++) {
		q = i ? dst : src;
		q->type = i ? V4L2_BUF_TYPE_VIDEO_CAPTURE :
			      V4L2_BUF_TYPE_VIDEO_OUTPUT;
		q->io_modes = VB2_MMAP | VB2_DMABUF;
		q->drv_priv = ctx;
		q->ops = &hc_vb2_ops;
		q->mem_ops = &vb2_dma_contig_memops;
		q->buf_struct_size = sizeof(struct v4l2_m2m_buffer);
		q->timestamp_flags = V4L2_BUF_FLAG_TIMESTAMP_COPY;
		q->lock = &hc_lock;
		q->dev = &hc_pdev->dev;
		ret = vb2_queue_init(q);
		if (ret)
			return ret;
	}
	return 0;
}

/* ucode 按整 MB 编，厂商驱动里也没有 SPS frame_cropping（crop_* 只喂 ge2d
 * 缩放器），所以宽高一律圆到 16 的倍数 —— 1080 会变成 1088。
 */
static void hc_set_geom(struct hc_ctx *ctx, u32 w, u32 h)
{
	ctx->width = clamp(ALIGN(w, 16), 16u, 1920u);
	ctx->height = clamp(ALIGN(h, 16), 16u, 1088u);
	ctx->bytesperline = hc_stride(ctx->fourcc, ctx->width);
	ctx->sizeimage = ctx->bytesperline * ctx->height * 3 / 2;
	ctx->bs_size = clamp(ctx->width * ctx->height / 2, HC_BS_MIN, HC_BS_MAX);
	ctx->hw_ready = false;
}

static int hc_querycap(struct file *f, void *p, struct v4l2_capability *cap)
{
	strscpy(cap->driver, "meson-hcodec", sizeof(cap->driver));
	strscpy(cap->card, "Amlogic GXL HCODEC H.264", sizeof(cap->card));
	snprintf(cap->bus_info, sizeof(cap->bus_info), "platform:%s",
		 dev_name(&hc_pdev->dev));
	return 0;
}

static int hc_enum_fmt_out(struct file *f, void *p, struct v4l2_fmtdesc *fd)
{
	if (fd->index >= ARRAY_SIZE(hc_out_fourcc))
		return -EINVAL;
	fd->pixelformat = hc_out_fourcc[fd->index];
	return 0;
}

static int hc_enum_fmt_cap(struct file *f, void *p, struct v4l2_fmtdesc *fd)
{
	if (fd->index)
		return -EINVAL;
	fd->pixelformat = V4L2_PIX_FMT_H264;
	return 0;
}

static int hc_g_fmt_out(struct file *f, void *p, struct v4l2_format *fmt)
{
	hc_fmt_out(hc_fh(f), &fmt->fmt.pix);
	return 0;
}

static int hc_g_fmt_cap(struct file *f, void *p, struct v4l2_format *fmt)
{
	hc_fmt_cap(hc_fh(f), &fmt->fmt.pix);
	return 0;
}

static int hc_try_fmt_out(struct file *f, void *p, struct v4l2_format *fmt)
{
	struct v4l2_pix_format *pix = &fmt->fmt.pix;
	struct hc_ctx probe = {};
	int i;

	for (i = 0; i < ARRAY_SIZE(hc_out_fourcc); i++)
		if (hc_out_fourcc[i] == pix->pixelformat)
			break;
	probe.fourcc = i < ARRAY_SIZE(hc_out_fourcc) ? pix->pixelformat :
						       V4L2_PIX_FMT_NV12;
	hc_set_geom(&probe, pix->width, pix->height);
	hc_fmt_out(&probe, pix);
	return 0;
}

static int hc_try_fmt_cap(struct file *f, void *p, struct v4l2_format *fmt)
{
	struct v4l2_pix_format *pix = &fmt->fmt.pix;
	struct hc_ctx probe = { .fourcc = hc_fh(f)->fourcc };

	hc_set_geom(&probe, pix->width, pix->height);
	hc_fmt_cap(&probe, pix);
	return 0;
}

static int hc_s_fmt_out(struct file *f, void *p, struct v4l2_format *fmt)
{
	struct hc_ctx *ctx = hc_fh(f);
	int ret = hc_try_fmt_out(f, p, fmt);

	if (ret)
		return ret;
	if (vb2_is_busy(v4l2_m2m_get_src_vq(ctx->fh.m2m_ctx)))
		return -EBUSY;
	ctx->fourcc = fmt->fmt.pix.pixelformat;
	hc_set_geom(ctx, fmt->fmt.pix.width, fmt->fmt.pix.height);
	hc_fmt_out(ctx, &fmt->fmt.pix);
	return 0;
}

/* stateful 编码器的 CAPTURE 几何本该跟着 OUTPUT 走，但 ffmpeg 的
 * h264_v4l2m2m 会先带着宽高 S_FMT(CAPTURE)，所以这里也收下。
 */
static int hc_s_fmt_cap(struct file *f, void *p, struct v4l2_format *fmt)
{
	struct hc_ctx *ctx = hc_fh(f);
	int ret = hc_try_fmt_cap(f, p, fmt);

	if (ret)
		return ret;
	if (vb2_is_busy(v4l2_m2m_get_dst_vq(ctx->fh.m2m_ctx)))
		return -EBUSY;
	hc_set_geom(ctx, fmt->fmt.pix.width, fmt->fmt.pix.height);
	hc_fmt_cap(ctx, &fmt->fmt.pix);
	return 0;
}

static int hc_g_parm(struct file *f, void *p, struct v4l2_streamparm *sp)
{
	struct hc_ctx *ctx = hc_fh(f);
	struct v4l2_fract *tpf;

	if (!V4L2_TYPE_IS_OUTPUT(sp->type))
		return -EINVAL;
	sp->parm.output.capability = V4L2_CAP_TIMEPERFRAME;
	tpf = &sp->parm.output.timeperframe;
	tpf->numerator = ctx->fps_num;
	tpf->denominator = ctx->fps_den;
	return 0;
}

static int hc_s_parm(struct file *f, void *p, struct v4l2_streamparm *sp)
{
	struct hc_ctx *ctx = hc_fh(f);
	struct v4l2_fract *tpf;

	if (!V4L2_TYPE_IS_OUTPUT(sp->type))
		return -EINVAL;
	tpf = &sp->parm.output.timeperframe;
	if (tpf->numerator && tpf->denominator) {
		ctx->fps_num = tpf->numerator;
		ctx->fps_den = tpf->denominator;
	}
	return hc_g_parm(f, p, sp);
}

static int hc_subscribe_event(struct v4l2_fh *fh,
			      const struct v4l2_event_subscription *sub)
{
	if (sub->type == V4L2_EVENT_EOS)
		return v4l2_event_subscribe(fh, sub, 0, NULL);
	return v4l2_ctrl_subscribe_event(fh, sub);
}

static const struct v4l2_ioctl_ops hc_ioctl_ops = {
	.vidioc_querycap = hc_querycap,
	.vidioc_enum_fmt_vid_out = hc_enum_fmt_out,
	.vidioc_enum_fmt_vid_cap = hc_enum_fmt_cap,
	.vidioc_g_fmt_vid_out = hc_g_fmt_out,
	.vidioc_g_fmt_vid_cap = hc_g_fmt_cap,
	.vidioc_try_fmt_vid_out = hc_try_fmt_out,
	.vidioc_try_fmt_vid_cap = hc_try_fmt_cap,
	.vidioc_s_fmt_vid_out = hc_s_fmt_out,
	.vidioc_s_fmt_vid_cap = hc_s_fmt_cap,
	.vidioc_g_parm = hc_g_parm,
	.vidioc_s_parm = hc_s_parm,
	.vidioc_reqbufs = v4l2_m2m_ioctl_reqbufs,
	.vidioc_create_bufs = v4l2_m2m_ioctl_create_bufs,
	.vidioc_querybuf = v4l2_m2m_ioctl_querybuf,
	.vidioc_qbuf = v4l2_m2m_ioctl_qbuf,
	.vidioc_dqbuf = v4l2_m2m_ioctl_dqbuf,
	.vidioc_prepare_buf = v4l2_m2m_ioctl_prepare_buf,
	.vidioc_expbuf = v4l2_m2m_ioctl_expbuf,
	.vidioc_streamon = v4l2_m2m_ioctl_streamon,
	.vidioc_streamoff = v4l2_m2m_ioctl_streamoff,
	.vidioc_try_encoder_cmd = v4l2_m2m_ioctl_try_encoder_cmd,
	.vidioc_encoder_cmd = v4l2_m2m_ioctl_encoder_cmd,
	.vidioc_subscribe_event = hc_subscribe_event,
	.vidioc_unsubscribe_event = v4l2_event_unsubscribe,
};

static int hc_s_ctrl(struct v4l2_ctrl *c)
{
	struct hc_ctx *ctx = container_of(c->handler, struct hc_ctx, ctrls);

	switch (c->id) {
	case V4L2_CID_MPEG_VIDEO_BITRATE:
		ctx->bitrate = c->val;
		break;
	case V4L2_CID_MPEG_VIDEO_GOP_SIZE:
		ctx->gop = c->val;
		break;
	case V4L2_CID_MPEG_VIDEO_H264_I_FRAME_QP:
		ctx->qp_i = c->val;
		break;
	case V4L2_CID_MPEG_VIDEO_H264_P_FRAME_QP:
		ctx->qp_p = c->val;
		break;
	case V4L2_CID_MPEG_VIDEO_H264_MIN_QP:
		ctx->qp_min = c->val;
		break;
	case V4L2_CID_MPEG_VIDEO_H264_MAX_QP:
		ctx->qp_max = c->val;
		break;
	case V4L2_CID_MPEG_VIDEO_FORCE_KEY_FRAME:
		ctx->force_idr = true;
		break;
	case V4L2_CID_MPEG_VIDEO_H264_PROFILE:
	case V4L2_CID_MPEG_VIDEO_HEADER_MODE:
	case V4L2_CID_MPEG_VIDEO_B_FRAMES:
		break;	/* 各只有一个合法取值，菜单 mask 已经挡住别的了 */
	default:
		return -EINVAL;
	}
	return 0;
}

static const struct v4l2_ctrl_ops hc_ctrl_ops = { .s_ctrl = hc_s_ctrl };

static int hc_ctrls_init(struct hc_ctx *ctx)
{
	struct v4l2_ctrl_handler *h = &ctx->ctrls;

	v4l2_ctrl_handler_init(h, 10);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_BITRATE,
			  32000, 40000000, 1000, ctx->bitrate);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_GOP_SIZE,
			  0, 300, 1, ctx->gop);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_H264_I_FRAME_QP,
			  10, 51, 1, ctx->qp_i);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_H264_P_FRAME_QP,
			  10, 51, 1, ctx->qp_p);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_H264_MIN_QP,
			  10, 51, 1, ctx->qp_min);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_H264_MAX_QP,
			  10, 51, 1, ctx->qp_max);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_B_FRAMES,
			  0, 0, 1, 0);
	v4l2_ctrl_new_std(h, &hc_ctrl_ops,
			  V4L2_CID_MPEG_VIDEO_FORCE_KEY_FRAME, 0, 0, 0, 0);
	/* ucode 只会 Baseline，头也只能贴在第一帧前面（每个 IDR 都重贴一份）。 */
	v4l2_ctrl_new_std_menu(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_H264_PROFILE,
			       V4L2_MPEG_VIDEO_H264_PROFILE_BASELINE,
			       ~BIT(V4L2_MPEG_VIDEO_H264_PROFILE_BASELINE),
			       V4L2_MPEG_VIDEO_H264_PROFILE_BASELINE);
	v4l2_ctrl_new_std_menu(h, &hc_ctrl_ops, V4L2_CID_MPEG_VIDEO_HEADER_MODE,
			       V4L2_MPEG_VIDEO_HEADER_MODE_JOINED_WITH_1ST_FRAME,
			       ~BIT(V4L2_MPEG_VIDEO_HEADER_MODE_JOINED_WITH_1ST_FRAME),
			       V4L2_MPEG_VIDEO_HEADER_MODE_JOINED_WITH_1ST_FRAME);
	if (h->error) {
		int ret = h->error;

		v4l2_ctrl_handler_free(h);
		return ret;
	}
	return v4l2_ctrl_handler_setup(h);
}

static int hc_open(struct file *file)
{
	struct hc_ctx *ctx;
	int ret;

	if (mutex_lock_interruptible(&hc_lock))
		return -ERESTARTSYS;
	if (hc_ctx_busy) {	/* 硬件只有一份参考帧和一套 canvas */
		ret = -EBUSY;
		goto unlock;
	}
	ctx = kzalloc(sizeof(*ctx), GFP_KERNEL);
	if (!ctx) {
		ret = -ENOMEM;
		goto unlock;
	}
	ctx->fourcc = V4L2_PIX_FMT_NV12;
	ctx->fps_num = 1;
	ctx->fps_den = 30;
	ctx->gop = 30;
	ctx->bitrate = 4000000;
	ctx->qp_i = qp;
	ctx->qp_p = qp + 2;
	ctx->qp_min = 16;
	ctx->qp_max = 45;
	hc_set_geom(ctx, width, height);
	INIT_WORK(&ctx->work, hc_work);
	v4l2_fh_init(&ctx->fh, video_devdata(file));
	file->private_data = &ctx->fh;

	ret = hc_ctrls_init(ctx);
	if (ret)
		goto free;
	ctx->fh.ctrl_handler = &ctx->ctrls;
	ctx->fh.m2m_ctx = v4l2_m2m_ctx_init(hc_m2m, ctx, hc_queue_init);
	if (IS_ERR(ctx->fh.m2m_ctx)) {
		ret = PTR_ERR(ctx->fh.m2m_ctx);
		v4l2_ctrl_handler_free(&ctx->ctrls);
		goto free;
	}
	v4l2_fh_add(&ctx->fh);
	hc_ctx_busy = true;
	mutex_unlock(&hc_lock);
	return 0;

free:
	v4l2_fh_exit(&ctx->fh);
	kfree(ctx);
unlock:
	mutex_unlock(&hc_lock);
	return ret;
}

static int hc_release(struct file *file)
{
	struct hc_ctx *ctx = hc_fh(file);

	v4l2_fh_del(&ctx->fh);
	v4l2_fh_exit(&ctx->fh);
	v4l2_ctrl_handler_free(&ctx->ctrls);
	mutex_lock(&hc_lock);
	v4l2_m2m_ctx_release(ctx->fh.m2m_ctx);
	hc_ctx_busy = false;
	mutex_unlock(&hc_lock);
	kfree(ctx);
	return 0;
}

static const struct v4l2_file_operations hc_fops = {
	.owner = THIS_MODULE,
	.open = hc_open,
	.release = hc_release,
	.poll = v4l2_m2m_fop_poll,
	.unlocked_ioctl = video_ioctl2,
	.mmap = v4l2_m2m_fop_mmap,
};

static const struct v4l2_m2m_ops hc_m2m_ops = {
	.device_run = hc_device_run,
};

static struct video_device hc_vdev = {
	.name = "meson-hcodec",
	.vfl_dir = VFL_DIR_M2M,
	.fops = &hc_fops,
	.ioctl_ops = &hc_ioctl_ops,
	.minor = -1,
	.release = video_device_release_empty,
	.device_caps = V4L2_CAP_VIDEO_M2M | V4L2_CAP_STREAMING,
	.lock = &hc_lock,
};

static int hc_v4l2_register(struct device *dev)
{
	int ret;

	hc_workq = alloc_ordered_workqueue("meson-hcodec", WQ_MEM_RECLAIM);
	if (!hc_workq)
		return -ENOMEM;
	ret = v4l2_device_register(dev, &hc_v4l2);
	if (ret)
		return ret;
	hc_m2m = v4l2_m2m_init(&hc_m2m_ops);
	if (IS_ERR(hc_m2m)) {
		ret = PTR_ERR(hc_m2m);
		hc_m2m = NULL;
		return ret;
	}
	hc_vdev.v4l2_dev = &hc_v4l2;
	ret = video_register_device(&hc_vdev, VFL_TYPE_VIDEO, -1);
	if (ret)
		return ret;
	v4l2_info(&hc_v4l2, "V4L2 M2M 编码器就绪：/dev/video%d\n", hc_vdev.num);
	return 0;
}

/* ------------------------------------------------------------------ */
static void hc_teardown(void)
{
	if (video_is_registered(&hc_vdev))
		video_unregister_device(&hc_vdev);
	if (hc_m2m) {
		v4l2_m2m_release(hc_m2m);
		hc_m2m = NULL;
	}
	if (hc_v4l2.dev)
		v4l2_device_unregister(&hc_v4l2);
	if (hc_workq) {
		destroy_workqueue(hc_workq);
		hc_workq = NULL;
	}
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

	hc_mark("7 注册 V4L2 节点");
	ret = hc_v4l2_register(dev);
	if (ret)
		goto out;
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
MODULE_DESCRIPTION("Amlogic GXL HCODEC H.264 encoder (out-of-tree, V4L2 M2M)");
MODULE_LICENSE("Dual MIT/GPL");
MODULE_FIRMWARE(HC_FW_NAME);







