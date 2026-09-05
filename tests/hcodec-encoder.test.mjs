import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// 源码契约测试。真正的验证是 kbuild 编译（见 docs/hcodec-encoder-plan.md 的
// 「编译验证」表）和实机跑，这里只锁住几个已经踩过一次的坑，防止改回去。
const src = fs.readFileSync(new URL('../tools/hcodec-mod/meson_hcodec.c', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../tools/hcodec-mod/README.md', import.meta.url), 'utf8');

test('slice QP 只能跟着 PPS 走，非 IDR 帧用缓存的 pic_init_qp', () => {
  // GXL 的 FULL ucode 把 slice_qp_delta 恒写 0（实测 8 个码流，PPS 说多少 slice
  // 就是多少）。所以 QP 只能在重发 SPS/PPS 的地方换，也就是 IDR；非 IDR 帧必须
  // 沿用头里那个值，否则重建帧自洽而解码器按 PPS 反量化，整帧饱和（实测 4.4 dB）。
  assert.match(src, /q = idr \? \(int\)ctx->cur_qp : \(int\)hc_hdr_qp;/);
  assert.match(src, /if \(idr && q != \(int\)hc_hdr_qp\) \{\s*\n\s*hc_set_qp\(\(u32\)q\);\s*\n\s*ret = hc_headers\(\);/);
  // streamon 也要先定 QP 再发头，否则第一个 IDR 白发一次 SPS/PPS。
  const son = src.slice(src.indexOf('static int hc_hw_setup('));
  assert.match(son.slice(0, son.indexOf('ret = hc_headers();')), /hc_set_qp\(ctx->cur_qp\);/);
});

test('mb_qp_delta 的幅度必须夹成 0', () => {
  // 厂商开 ±26/25，但 ucode 只把 delta 写进码流、量化器不按它走：同一输入的 10 个
  // IDR 解出来 7~26 dB 且每次不同。夹成 0 之后全部 51.8 dB、字节数 ±0.4%。
  assert.match(src, /WRITE_HREG\(HCODEC_QDCT_VLC_QUANT_CTL_1, 0\);/);
});

test('IDR_DONE 和 NON_IDR_DONE 互认', () => {
  // GXL 的 FULL ucode 收到 ENCODER_NON_IDR 之后照样报 9（IDR_DONE），
  // 只等 10 会一直超时。
  const done = src.slice(src.indexOf('static bool hc_done('));
  assert.match(done.slice(0, done.indexOf('\n}')),
    /want == ENCODER_IDR_DONE \|\| want == ENCODER_NON_IDR_DONE[\s\S]*?s == ENCODER_IDR_DONE \|\| s == ENCODER_NON_IDR_DONE/);
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

const qemu = fs.readFileSync(new URL('../scripts/hcodec-v4l2-qemu.sh', import.meta.url), 'utf8');

test('nohw 是 RAM 假硬件，不是「什么都不碰」', () => {
  // 四个窗口换成 vzalloc，厂商那整套寄存器序列照跑，QEMU 上才能断言每帧编程。
  assert.match(src, /nohw \? \(void __iomem \*\)vzalloc\(size\) : ioremap\(base, size\)/);
  // hw_setup / hc_work 里不能再有 nohw 早退，否则又回到「帧根本没编」。
  const setup = src.slice(src.indexOf('static int hc_hw_setup('), src.indexOf('static void hc_return_bufs('));
  for (const chunk of [setup, hcWork]) assert.doesNotMatch(chunk, /if \(nohw\)\s*\{/);
});

test('nohw 的逐帧日志字段和 QEMU 断言对得上', () => {
  // 脚本 grep 的是这一行；改了格式就等于把三帧断言悄悄废掉。
  assert.match(src, /nohw#%u idr=%d idr_pic_id=%u frame_num=%u poc=%u rec=%06x anc=%06x qp=%u qtab=%08x/);
  for (const want of ['nohw#1 idr=1 idr_pic_id=0 frame_num=0 poc=0 rec=e6e5e4 anc=e9e8e7',
                      'nohw#2 idr=0 idr_pic_id=1 frame_num=1 poc=2 rec=e9e8e7 anc=e6e5e4',
                      'nohw#3 idr=0 idr_pic_id=1 frame_num=2 poc=4 rec=e6e5e4 anc=e9e8e7'])
    assert.ok(qemu.includes(want), `脚本里缺断言：${want}`);
});

test('三帧测试的分辨率必须页对齐（v4l2-ctl 按 g_length 读文件）', () => {
  // read_one_frame 每帧读 mmap 缓冲区长度，vb2 会 PAGE_ALIGN 它。sizeimage 不是
  // 4096 的整数倍时读第二帧就跨过文件尾，只喂得进一帧（640x480 实测踩过）。
  const sets = [...qemu.matchAll(/--set-fmt-video-out=width=(\d+),height=(\d+),pixelformat=NV12/g)];
  const [, w, h] = sets.at(-1); // 三帧那次是最后一个 set-fmt
  const sizeimage = +w * +h * 3 / 2;
  assert.equal(sizeimage % 4096, 0, `${w}x${h} NV12 的 sizeimage ${sizeimage} 不是页整数倍`);
  assert.ok(qemu.includes(`bs=${sizeimage} count=`), `dd 的 bs 要等于 sizeimage ${sizeimage}`);
  assert.match(qemu, /--stream-out-mmap 4 --stream-count 3/); // 不给数量就只有 1 个缓冲区
});

const builder = fs.readFileSync(new URL('../scripts/build-hcodec-module.sh', import.meta.url), 'utf8');

test('构建脚本必须核对冻结内核包的摘要，并按包里的名字取 release', () => {
  // 头文件树决定 vermagic；换了内核包而没重编模块，实机就是「没有 /dev/videoN」。
  assert.match(builder, /frozen kernel package digest mismatch/);
  assert.match(builder, /kernel\.digest is invalid/);
  // release 写在 header-<release>.tar.gz 的名字里，硬编就会在上游改版号时静默错。
  assert.match(builder, /header_entry=\$\(tar tzf "\$tarball" \| grep -E "\^\$\{kernel_version\}\/header-/);
  assert.match(builder, /module vermagic does not match the frozen kernel/);
  // x86 runner 上头文件树自带的 fixdep/modpost 是 aarch64 ELF，必须用 host cc 重编。
  assert.match(builder, /cc -O2 -o scripts\/basic\/fixdep scripts\/basic\/fixdep\.c/);
  assert.match(builder, /ARCH=arm64 CROSS_COMPILE="\$cross" M="\$work\/build" modules/);
});
