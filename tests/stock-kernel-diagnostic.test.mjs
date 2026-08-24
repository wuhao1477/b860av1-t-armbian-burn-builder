import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import * as burnImage from '../scripts/burn-image.mjs';

const PAGE_SIZE = 2048;
const ROOT = new URL('../', import.meta.url);

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-stock-diagnostic-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function align(value, boundary = 4) {
  return Math.ceil(value / boundary) * boundary;
}

function newc(entries) {
  const chunks = [];
  let inode = 1;
  const append = (name, mode, contents) => {
    const data = Buffer.from(contents);
    const encodedName = Buffer.from(`${name}\0`);
    const fields = [
      inode, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, encodedName.length, 0,
    ];
    inode += 1;
    chunks.push(Buffer.from(`070701${fields.map((value) => value.toString(16).padStart(8, '0')).join('')}`));
    chunks.push(encodedName, Buffer.alloc(align(110 + encodedName.length) - 110 - encodedName.length));
    chunks.push(data, Buffer.alloc(align(data.length) - data.length));
  };
  for (const entry of entries) append(entry.name, entry.mode, entry.contents);
  append('TRAILER!!!', 0, Buffer.alloc(0));
  return Buffer.concat(chunks);
}

function arm64Elf(label) {
  const elf = Buffer.alloc(128);
  elf.write('\x7fELF', 0, 'binary');
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(0xb7, 18);
  elf.write(label, 64, 'ascii');
  return elf;
}

function diagnosticInitramfs() {
  return gzipSync(newc([
    {
      name: 'init',
      mode: 0o100755,
      contents: '#!/bin/busybox sh\nB860_STOCK_KERNEL_DIAGNOSTIC=1\nhttpd -p 80 -h /www\n',
    },
    { name: 'bin/busybox', mode: 0o100755, contents: arm64Elf('busybox') },
    { name: 'www/index.html', mode: 0o100644, contents: 'B860 diagnostic\n' },
    {
      name: 'etc/b860-diagnostic-release',
      mode: 0o100644,
      contents: 'B860_STOCK_KERNEL_DIAGNOSTIC=1\n',
    },
  ]), { level: 9, mtime: 0 });
}

function bootId(kernel, ramdisk, second) {
  const hash = crypto.createHash('sha1');
  for (const payload of [kernel, ramdisk, second]) {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);
    hash.update(payload);
    hash.update(size);
  }
  return hash.digest();
}

function androidBoot(kernel, ramdisk, second) {
  const header = Buffer.alloc(PAGE_SIZE);
  header.write('ANDROID!', 0, 'ascii');
  header.writeUInt32LE(kernel.length, 8);
  header.writeUInt32LE(0x01080000, 12);
  header.writeUInt32LE(ramdisk.length, 16);
  header.writeUInt32LE(0x01000000, 20);
  header.writeUInt32LE(second.length, 24);
  header.writeUInt32LE(0x00f00000, 28);
  header.writeUInt32LE(0x00000100, 32);
  header.writeUInt32LE(PAGE_SIZE, 36);
  header.write('stock-b860', 48, 'ascii');
  header.write('rootfstype=ramfs init=/init console=ttyS0,115200', 64, 'ascii');
  bootId(kernel, ramdisk, second).copy(header, 576);
  const chunks = [header];
  for (const payload of [kernel, ramdisk, second]) {
    chunks.push(payload, Buffer.alloc(align(payload.length, PAGE_SIZE) - payload.length));
  }
  return Buffer.concat(chunks);
}

function stockFixture(context, stockRamdisk) {
  const directory = fixture(context);
  const kernel = gzipSync(Buffer.from('Linux version 3.14.29-g57f7ee1\0stock-kernel'));
  const initramfsPayload = diagnosticInitramfs();
  const ramdisk = stockRamdisk ?? Buffer.alloc(initramfsPayload.length + 4096, 0x5c);
  const second = Buffer.alloc(4096, 0x5a);
  second.write('AML_', 0, 'ascii');
  second.write('gxl_p212_1g', 128, 'ascii');
  const source = path.join(directory, 'stock-boot.PARTITION');
  const initramfs = path.join(directory, 'diagnostic-initramfs.cpio.gz');
  const output = path.join(directory, 'boot.PARTITION');
  fs.writeFileSync(source, androidBoot(kernel, ramdisk, second));
  fs.writeFileSync(initramfs, initramfsPayload);
  return { directory, source, initramfs, output, kernel, ramdisk, second };
}

test('diagnostic initramfs requires an ARM64 BusyBox HTTP-only runtime', (context) => {
  const paths = stockFixture(context);

  assert.equal(typeof burnImage.validateDiagnosticInitramfs, 'function');
  const result = burnImage.validateDiagnosticInitramfs(paths.initramfs);

  assert.equal(result.format, 'gzip-newc');
  assert.equal(result.architecture, 'arm64');
  assert.equal(result.marker, 'B860_STOCK_KERNEL_DIAGNOSTIC=1');
  assert.equal(result.remoteAccess, 'http-only');
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test('diagnostic initramfs rejects a missing HTTP status server', (context) => {
  const directory = fixture(context);
  const input = path.join(directory, 'incomplete.cpio.gz');
  fs.writeFileSync(input, gzipSync(newc([
    { name: 'init', mode: 0o100755, contents: 'B860_STOCK_KERNEL_DIAGNOSTIC=1\n' },
    { name: 'bin/busybox', mode: 0o100755, contents: arm64Elf('busybox') },
    { name: 'www/index.html', mode: 0o100644, contents: 'B860 diagnostic\n' },
    {
      name: 'etc/b860-diagnostic-release',
      mode: 0o100644,
      contents: 'B860_STOCK_KERNEL_DIAGNOSTIC=1\n',
    },
  ])));

  assert.throws(
    () => burnImage.validateDiagnosticInitramfs(input),
    /HTTP status server/,
  );
});

test('diagnostic boot rejects a ramdisk larger than the stock envelope', (context) => {
  const paths = stockFixture(context, Buffer.alloc(1));
  burnImage.replaceAndroidBootRamdisk(paths.source, paths.initramfs, paths.output);
  const config = path.join(paths.directory, 'diagnostic.json');
  fs.writeFileSync(config, `${JSON.stringify({
    stockBoot: {
      sha256: crypto.createHash('sha256').update(fs.readFileSync(paths.source)).digest('hex'),
      size: fs.statSync(paths.source).size,
    },
  })}\n`);

  assert.throws(
    () => burnImage.validateStockDiagnosticBoot(
      paths.source,
      paths.output,
      paths.initramfs,
      config,
    ),
    /exceeds the stock ramdisk size/,
  );
});

test('ramdisk replacement preserves the stock kernel, multi-DTB, addresses, and command line', (context) => {
  const paths = stockFixture(context);
  const before = fs.readFileSync(paths.source);

  assert.equal(typeof burnImage.replaceAndroidBootRamdisk, 'function');
  const result = burnImage.replaceAndroidBootRamdisk(
    paths.source,
    paths.initramfs,
    paths.output,
  );
  const after = fs.readFileSync(paths.output);

  assert.equal(result.kernelSha256, crypto.createHash('sha256').update(paths.kernel).digest('hex'));
  assert.equal(result.secondSha256, crypto.createHash('sha256').update(paths.second).digest('hex'));
  assert.equal(after.readUInt32LE(16), fs.statSync(paths.initramfs).size);
  assert.deepEqual(after.subarray(12, 16), before.subarray(12, 16));
  assert.deepEqual(after.subarray(20, 40), before.subarray(20, 40));
  assert.deepEqual(after.subarray(48, 576), before.subarray(48, 576));
});

test('diagnostic boot validator rejects any stock-kernel mutation', (context) => {
  const paths = stockFixture(context);
  burnImage.replaceAndroidBootRamdisk(paths.source, paths.initramfs, paths.output);
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(paths.source)).digest('hex');
  const config = path.join(paths.directory, 'diagnostic.json');
  fs.writeFileSync(config, `${JSON.stringify({
    schemaVersion: 1,
    stockBoot: { sha256: sourceSha256, size: fs.statSync(paths.source).size },
  })}\n`);

  assert.equal(typeof burnImage.validateStockDiagnosticBoot, 'function');
  const accepted = burnImage.validateStockDiagnosticBoot(
    paths.source,
    paths.output,
    paths.initramfs,
    config,
  );
  assert.equal(accepted.kernelVersion, '3.14.29-g57f7ee1');
  assert.equal(accepted.onlyRamdiskChanged, true);

  const modified = fs.readFileSync(paths.output);
  modified[PAGE_SIZE + 4] ^= 0xff;
  fs.writeFileSync(paths.output, modified);
  assert.throws(
    () => burnImage.validateStockDiagnosticBoot(
      paths.source,
      paths.output,
      paths.initramfs,
      config,
    ),
    /stock kernel differs/,
  );
});

test('repository diagnostic inputs are byte-exact stock B860 payloads', () => {
  const boardInputs = new URL('board-inputs/', ROOT);
  const config = new URL('config/burn-inputs.json', ROOT);

  assert.equal(typeof burnImage.validateStockDiagnosticInputs, 'function');
  const result = burnImage.validateStockDiagnosticInputs(boardInputs, config);

  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'hardware-unverified',
    stockBootSha256: 'c2686dabba33436d57397fbe690021d92c9d81951ccbed31db90889edf3da999',
    stockBootSize: 8326952,
    kernelVersion: '3.14.29-g57f7ee1',
    logoSha256: '2fa846726b8cbfac807698335c46377bb25d2199ebdae6606b795674b38d6335',
    logoSize: 9195984,
    busyboxCommit: '1a64f6a20aaf6ea4dbba68bbfa8cc1ab7e5c57c4',
  });
});

test('repository stock diagnostic runtime excludes Dropbear and starts HTTP', () => {
  const init = fs.readFileSync(new URL('../config/stock-diagnostic-init', import.meta.url), 'utf8');
  const builder = fs.readFileSync(
    new URL('../scripts/build-stock-diagnostic-initramfs.sh', import.meta.url),
    'utf8',
  );

  assert.match(init, /httpd -p 80 -h \/www/);
  assert.doesNotMatch(init, /dropbear|SSH/iu);
  assert.doesNotMatch(builder, /dropbear/iu);
});

function diagnosticConfig(paths) {
  const config = path.join(paths.directory, 'diagnostic.json');
  fs.writeFileSync(config, `${JSON.stringify({
    schemaVersion: 1,
    stockBoot: {
      sha256: crypto.createHash('sha256').update(fs.readFileSync(paths.source)).digest('hex'),
      size: fs.statSync(paths.source).size,
    },
  })}\n`);
  return config;
}

function emptyCmdlineFixture(context) {
  const paths = stockFixture(context);
  const source = fs.readFileSync(paths.source);
  source.fill(0, 64, 576);
  fs.writeFileSync(paths.source, source);
  return paths;
}

test('repository stock boot leaves the Android command line field empty', () => {
  const stock = fs.readFileSync(new URL('board-inputs/stock-boot.PARTITION', ROOT));
  const field = stock.subarray(64, 576);

  // verbose 变体建立在“原厂没有占用该字段”之上，这个前提必须持续成立。
  assert.deepEqual(field, Buffer.alloc(512));
});

test('repository console command line adds HDMI logging and drops quiet', () => {
  assert.equal(typeof burnImage.diagnosticConsoleCmdline, 'function');
  const cmdline = burnImage.diagnosticConsoleCmdline(new URL('config/stock-environment.json', ROOT));

  assert.match(cmdline, /(^| )console=ttyS0,115200( |$)/u);
  assert.match(cmdline, /(^| )console=tty0( |$)/u);
  assert.match(cmdline, /(^| )ignore_loglevel$/u);
  assert.match(cmdline, /(^| )init=\/init( |$)/u);
  assert.match(cmdline, /(^| )vout=720p50hz,enable( |$)/u);
  assert.doesNotMatch(cmdline, /\bquiet\b/u);
  assert.doesNotMatch(cmdline, /\$/u);
  assert.ok(cmdline.length < 512, `command line must fit the header field: ${cmdline.length}`);
});

test('repository stock environment exposes every pinned vendor variable', () => {
  assert.equal(typeof burnImage.parseStockEnvironment, 'function');
  const environment = burnImage.parseStockEnvironment(new URL('config/stock-environment.json', ROOT));

  assert.equal(environment.size, 81);
  assert.equal(environment.get('bootcmd'), 'run storeboot');
  assert.equal(environment.get('outputmode'), '720p50hz');
});

test('verbose diagnostic boot writes the console command line and records it', (context) => {
  const paths = emptyCmdlineFixture(context);
  const cmdline = 'rootfstype=ramfs init=/init console=ttyS0,115200 console=tty0 ignore_loglevel';

  const result = burnImage.replaceAndroidBootRamdisk(
    paths.source, paths.initramfs, paths.output, cmdline,
  );
  const after = fs.readFileSync(paths.output);
  const accepted = burnImage.validateStockDiagnosticBoot(
    paths.source, paths.output, paths.initramfs, diagnosticConfig(paths), cmdline,
  );

  assert.equal(result.consoleCmdline, cmdline);
  assert.equal(after.toString('ascii', 64, 64 + cmdline.length), cmdline);
  assert.equal(after[64 + cmdline.length], 0);
  assert.equal(accepted.consoleCmdline, cmdline);
  assert.equal(accepted.onlyRamdiskChanged, false);
  assert.equal(accepted.kernelSha256, result.kernelSha256);
  assert.equal(accepted.secondSha256, result.secondSha256);
});

test('verbose diagnostic boot still refuses to touch the kernel or multi-DTB', (context) => {
  const paths = emptyCmdlineFixture(context);
  const cmdline = 'console=tty0 ignore_loglevel';
  burnImage.replaceAndroidBootRamdisk(paths.source, paths.initramfs, paths.output, cmdline);
  const config = diagnosticConfig(paths);
  const tampered = fs.readFileSync(paths.output);
  tampered[PAGE_SIZE + 4] ^= 0xff;
  fs.writeFileSync(paths.output, tampered);

  assert.throws(
    () => burnImage.validateStockDiagnosticBoot(
      paths.source, paths.output, paths.initramfs, config, cmdline,
    ),
    /stock kernel differs/,
  );
});

test('verbose diagnostic boot validator rejects a substituted command line', (context) => {
  const paths = emptyCmdlineFixture(context);
  burnImage.replaceAndroidBootRamdisk(
    paths.source, paths.initramfs, paths.output, 'console=tty0 ignore_loglevel',
  );

  assert.throws(
    () => burnImage.validateStockDiagnosticBoot(
      paths.source, paths.output, paths.initramfs, diagnosticConfig(paths), 'console=tty0',
    ),
    /command line differs from its contract/,
  );
});

test('verbose diagnostic boot refuses to overwrite a populated stock command line', (context) => {
  const paths = stockFixture(context);

  // 夹具的原厂头带着 cmdline，verbose 变体必须拒绝覆盖而不是静默丢弃。
  assert.throws(
    () => burnImage.replaceAndroidBootRamdisk(
      paths.source, paths.initramfs, paths.output, 'console=tty0',
    ),
    /refusing to overwrite/,
  );
});

test('console command line rejects oversized and non-ASCII payloads', (context) => {
  const paths = emptyCmdlineFixture(context);

  assert.throws(
    () => burnImage.replaceAndroidBootRamdisk(
      paths.source, paths.initramfs, paths.output, 'a'.repeat(512),
    ),
    /exceeds 511 bytes/,
  );
  assert.throws(
    () => burnImage.replaceAndroidBootRamdisk(
      paths.source, paths.initramfs, paths.output, 'console=tty0 温度',
    ),
    /printable ASCII/,
  );
});
