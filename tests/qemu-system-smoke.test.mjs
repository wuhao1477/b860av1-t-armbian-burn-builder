import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeScript = path.join(root, 'scripts/qemu-system-smoke.sh');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function createFixture(t, qemuResult, { emitKernelRelease = true, serialCrLf = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-qemu-smoke-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const qemu = path.join(bin, 'qemu-system-aarch64');
  const releaseNewline = serialCrLf ? '\\r\\n' : '\\n';
  const releaseResult = emitKernelRelease
    ? `if [[ "$command" =~ (B860_QEMU_KERNEL_RELEASE_[0-9a-f]{32})_%s ]]; then
  printf '%s${releaseNewline}' "\${BASH_REMATCH[1]}_5.10.260-ophub"
fi`
    : '';
  fs.writeFileSync(qemu, `#!/usr/bin/env bash
if [[ \${1:-} == --version ]]; then
  printf '%s\\n' 'QEMU emulator version 9.2.0-test'
  exit 0
fi
printf '# '
IFS= read -r command
printf '%s\\n' "$command"
${releaseResult}
${qemuResult}
IFS= read -r command
`);
  fs.chmodSync(qemu, 0o755);

  const raw = path.join(directory, 'candidate.img');
  const kernelSource = path.join(directory, 'zImage');
  const kernel = path.join(directory, 'Image');
  const initrdSource = path.join(directory, 'uInitrd');
  const initrd = path.join(directory, 'initrd.img');
  const manifest = path.join(directory, 'resolved-sources.json');
  const output = path.join(directory, 'qemu-system-smoke.json');
  fs.writeFileSync(raw, 'raw-image');
  fs.writeFileSync(kernelSource, 'kernel-source');
  fs.writeFileSync(kernel, 'kernel');
  fs.writeFileSync(initrdSource, 'initrd-source');
  fs.writeFileSync(initrd, 'initrd');
  fs.writeFileSync(manifest, `${JSON.stringify({
    fingerprint: 'a'.repeat(64),
    sources: { kernel: { version: '5.10.260' } },
  })}\n`);
  const args = [
    raw,
    'zImage',
    kernelSource,
    kernel,
    'uInitrd',
    initrdSource,
    initrd,
    '12345678-1234-1234-1234-123456789abc',
    manifest,
    output,
  ];
  const options = {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    timeout: 10_000,
  };
  return { args, directory, options, output, raw };
}

test('QEMU system smoke script binds the raw image and console evidence', (t) => {
  const fixture = createFixture(t, "printf '%s\\n' 'B860_QEMU_SYSTEM_SMOKE_OK'");
  execFileSync(smokeScript, fixture.args, fixture.options);

  const consolePath = path.join(fixture.directory, 'qemu-system-smoke.log');
  const console = fs.readFileSync(consolePath);
  const evidence = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));
  assert.match(console.toString('utf8'), /B860_QEMU_SYSTEM_SMOKE_OK/);
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.rawSha256, sha256('raw-image'));
  assert.equal(evidence.kernelPath, 'zImage');
  assert.equal(evidence.kernelSourceSha256, sha256('kernel-source'));
  assert.equal(evidence.kernelSha256, sha256('kernel'));
  assert.equal(evidence.kernelRelease, '5.10.260-ophub');
  assert.match(evidence.kernelReleaseMarker, /^B860_QEMU_KERNEL_RELEASE_[0-9a-f]{32}$/);
  assert.equal(evidence.initrdPath, 'uInitrd');
  assert.equal(evidence.initrdSourceSha256, sha256('initrd-source'));
  assert.equal(evidence.initrdSha256, sha256('initrd'));
  assert.equal(evidence.consoleLogSha256, sha256(console));
  assert.equal(evidence.manifestFingerprint, 'a'.repeat(64));
  assert.equal(evidence.qemuVersion, 'QEMU emulator version 9.2.0-test');
  assert.equal(fs.readFileSync(fixture.raw, 'utf8'), 'raw-image');
});

test('QEMU system smoke accepts guest CRLF after host PTY translation', (t) => {
  const fixture = createFixture(
    t,
    "printf 'B860_QEMU_SYSTEM_SMOKE_OK\\r\\n'; sleep 1; exit 0",
    { serialCrLf: true },
  );

  execFileSync(smokeScript, fixture.args, fixture.options);

  const console = fs.readFileSync(path.join(fixture.directory, 'qemu-system-smoke.log'), 'utf8');
  const evidence = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));
  assert.match(console, /B860_QEMU_SYSTEM_SMOKE_OK\r{2,}\n/);
  assert.equal(evidence.kernelRelease, '5.10.260-ophub');
});

test('QEMU command echo cannot satisfy the success marker', (t) => {
  const fixture = createFixture(t, 'sleep 1; exit 0');
  const result = spawnSync(smokeScript, fixture.args, fixture.options);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString('utf8'), /QEMU system smoke test failed/);
  assert.equal(fs.existsSync(fixture.output), false);
});

test('QEMU command echo cannot satisfy the kernel release marker', (t) => {
  const fixture = createFixture(
    t,
    "printf '%s\\n' 'B860_QEMU_SYSTEM_SMOKE_OK'",
    { emitKernelRelease: false },
  );
  const result = spawnSync(smokeScript, fixture.args, fixture.options);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString('utf8'), /QEMU kernel release marker is missing/i);
  assert.equal(fs.existsSync(fixture.output), false);
});
