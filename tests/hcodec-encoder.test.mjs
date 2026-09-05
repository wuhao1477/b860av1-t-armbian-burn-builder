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
