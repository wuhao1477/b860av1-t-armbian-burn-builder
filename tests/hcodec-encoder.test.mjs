import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// 源码契约测试。真正的验证是 kbuild 编译（见 docs/hcodec-encoder-plan.md 的
// 「编译验证」表）和实机跑，这里只锁住几个已经踩过一次的坑，防止改回去。
const src = fs.readFileSync(new URL('../tools/hcodec-mod/meson_hcodec.c', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../tools/hcodec-mod/README.md', import.meta.url), 'utf8');

test('P 帧 QP 差值走有符号运算', () => {
  // qp_p < qp_i 时 u32 会下溢，clamp 反而吸到 qp_max —— 正好反了。
  assert.match(src, /clamp_t\(int,\s*q \+ \(int\)ctx->qp_p - \(int\)ctx->qp_i/);
});

const hcWork = src.slice(src.indexOf('static void hc_work('), src.indexOf('static void hc_device_run('));

test('hc_work 的早退路径也要 job_finish', () => {
  // 不调用的话 streamoff 里的 v4l2_m2m_cancel_job 会永久等下去。
  assert.match(hcWork, /if \(!src \|\| !dst\) \{[^}]*v4l2_m2m_job_finish\(/s);
});

test('收尾用 buf_done_and_job_finish（draining 的 LAST 标志靠它）', () => {
  // 自己 remove + buf_done 会漏掉 V4L2_BUF_FLAG_LAST，encoder_cmd 就废了。
  // （hc_return_bufs 里的 *_buf_remove 是 streamoff 清队列，另一回事。）
  assert.match(hcWork, /v4l2_m2m_buf_done_and_job_finish\(/);
  assert.doesNotMatch(hcWork, /v4l2_m2m_(src|dst)_buf_remove\(/);
});

test('MFDIN 跨度：NV12/NV21 对齐 32，YUV420 对齐 64', () => {
  assert.match(src, /V4L2_PIX_FMT_YUV420 \? ALIGN\(w, 64\) : ALIGN\(w, 32\)/);
  assert.match(src, /ALIGN\(w, 16\), 16u, 1920u/); // 没有 SPS crop，只能圆到整 MB
});

test('README 记着两个 =m 依赖', () => {
  // modpost 实测 depends: v4l2-mem2mem,videobuf2-dma-contig
  assert.match(readme, /modprobe v4l2-mem2mem videobuf2-dma-contig/);
});

// 下面三条是 QEMU 跑出来的（scripts/hcodec-v4l2-qemu.sh）。

test('v4l2_device 的名字必须自己填', () => {
  // hc_pdev 是 register_simple 出来的，dev->driver 是空的；名字留空时
  // v4l2_device_register 会去读 dev->driver->name —— QEMU 上实测 insmod 当场 oops。
  const reg = src.slice(src.indexOf('static int hc_v4l2_register('));
  assert.match(reg.slice(0, reg.indexOf('v4l2_device_register(')), /strscpy\(hc_v4l2\.name,/);
});

test('ENUM_FRAMESIZES 不能少', () => {
  // v4l2-compliance 对 stateful 编码器强制要求它（v4l2-test-formats.cpp:304），
  // 少了会连带判「H264 not reported by ENUM_FMT」。
  assert.match(src, /\.vidioc_enum_framesizes\s*=\s*hc_enum_framesizes,/);
});

test('独占闸设在 STREAMON，不设在 open', () => {
  // 拦在 open() 上，gstreamer 探测设备会失败，v4l2-compliance 也判「second open」不合规。
  const open = src.slice(src.indexOf('static int hc_open('), src.indexOf('static int hc_release('));
  assert.doesNotMatch(open, /EBUSY/);
  assert.match(src, /if \(hc_streamer && hc_streamer != ctx\)\s*\n\s*ret = -EBUSY;/);
});

test('colorimetry 原样 round-trip 并带到 CAPTURE', () => {
  // 硬编码 REC709 时 v4l2-test-formats.cpp:953 判 S_FMT 不合规。
  for (const f of ['colorspace', 'ycbcr_enc', 'quantization', 'xfer_func']) {
    assert.match(src, new RegExp(`ctx->${f} = fmt->fmt\\.pix\\.${f};`));
    assert.equal(src.match(new RegExp(`pix->${f} = ctx->${f};`, 'g'))?.length, 2); // OUTPUT + CAPTURE
  }
});

test('MIN_BUFFERS_FOR_OUTPUT 控件不能少', () => {
  // v4l2-test-controls.cpp:1182 对 stateful 编码器强制要求。
  assert.match(src, /V4L2_CID_MIN_BUFFERS_FOR_OUTPUT, 1, 32, 1, 1\)/);
});
