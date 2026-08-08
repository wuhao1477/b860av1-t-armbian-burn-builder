import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { replaceLinuxTargetDtb, validateBurnDtbRoles } from '../src/burn-dtb-roles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendorDtb = path.join(root, 'board-inputs/meson1.dtb');
const linuxDts = path.join(root, 'tests/fixtures/source-built-b860av11t.dts');
const burnCli = path.join(root, 'scripts/burn-image.mjs');
const partitionOverlay = path.join(root, 'board-overlays/burn-partitions.dtso');

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-dtb-roles-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceDtb = path.join(directory, 'linux.source.dtb');
  const linuxDtb = path.join(directory, 'linux.dtb');
  childProcess.execFileSync('dtc', ['-q', '-I', 'dts', '-O', 'dtb', '-o', sourceDtb, linuxDts]);
  childProcess.execFileSync(
    process.execPath,
    [burnCli, 'standalone-dtb', sourceDtb, partitionOverlay, linuxDtb],
  );
  return { directory, linuxDtb };
}

test('burn package keeps the vendor USB DTB separate from the Linux P212 DTB', (context) => {
  const { directory, linuxDtb } = fixture(context);
  const hybridDtb = path.join(directory, 'meson1.dtb');
  replaceLinuxTargetDtb(vendorDtb, linuxDtb, hybridDtb);

  const result = validateBurnDtbRoles(hybridDtb, linuxDtb);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.vendor.format, 'amlogic-multi-dtb-v2');
  assert.equal(result.vendor.size, 256000);
  assert.equal(result.vendor.selectedTarget, 'gxl_p211_1g');
  assert.deepEqual(result.vendor.targets, [
    'gxb_p200_1g', 'gxb_p200_2g', 'gxl_p211_1g', 'gxl_p211_2g',
    'gxl_p215_1g', 'gxl_p215_2g', 'gxl_p215hc100_2g',
  ]);
  assert.equal(result.linux.format, 'flattened-device-tree');
  assert.ok(result.linux.compatible.includes('amlogic,p212'));
  assert.equal(result.distinct, true);
  assert.equal(result.layoutMiB.system, 1144);
  assert.equal(result.layoutMiB.data, 2176);
});

test('burn DTB role validation rejects a plain FDT in the USB package slot', (context) => {
  const { linuxDtb } = fixture(context);

  assert.throws(
    () => validateBurnDtbRoles(linuxDtb, linuxDtb),
    /vendor meson1\.dtb is not Amlogic multi-DTB v2/,
  );
});

test('hybrid multi-DTB replaces only the BL33-selected P211 1 GB slot', (context) => {
  const { directory, linuxDtb } = fixture(context);
  const output = path.join(directory, 'meson1.dtb');
  const result = replaceLinuxTargetDtb(vendorDtb, linuxDtb, output);
  assert.equal(result.selectedTarget, 'gxl_p211_1g');
  assert.equal(result.vendor.targets.length, 7);
  assert.equal(result.linux.compatible[0], 'amlogic,p212');
  assert.equal(result.linux.fdtSize, fs.statSync(linuxDtb).size);
  assert.equal(result.slotOffset, 71680);
  assert.equal(result.slotSize, 36864);
  const bytes = fs.readFileSync(output);
  const vendorBytes = fs.readFileSync(vendorDtb);
  assert.equal(bytes.length, 256000);
  assert.deepEqual(bytes.subarray(0, result.slotOffset), vendorBytes.subarray(0, result.slotOffset));
  assert.deepEqual(
    bytes.subarray(result.slotOffset + result.slotSize),
    vendorBytes.subarray(result.slotOffset + result.slotSize),
  );
  assert.notDeepEqual(
    bytes.subarray(result.slotOffset, result.slotOffset + result.slotSize),
    vendorBytes.subarray(result.slotOffset, result.slotOffset + result.slotSize),
  );
  const linuxBytes = fs.readFileSync(linuxDtb);
  assert.deepEqual(
    bytes.subarray(result.slotOffset, result.slotOffset + result.linux.fdtSize),
    linuxBytes,
  );
  assert.ok(
    bytes.subarray(result.slotOffset + result.linux.fdtSize, result.slotOffset + result.slotSize)
      .every((byte) => byte === 0),
  );
});

test('hybrid multi-DTB rejects a Linux FDT larger than the fixed P211 slot', (context) => {
  const { directory, linuxDtb } = fixture(context);
  const expandedLinuxDtb = path.join(directory, 'linux-expanded.dtb');
  const output = path.join(directory, 'meson1.dtb');
  childProcess.execFileSync('dtc', [
    '-q', '-I', 'dtb', '-O', 'dtb', '-p', '8192', '-o', expandedLinuxDtb, linuxDtb,
  ]);

  assert.throws(
    () => replaceLinuxTargetDtb(vendorDtb, expandedLinuxDtb, output),
    /does not fit the selected vendor DTB slot/,
  );
  assert.equal(fs.existsSync(output), false);
});

test('burn DTB role validation rejects a stale P211 payload', (context) => {
  const { linuxDtb } = fixture(context);

  assert.throws(
    () => validateBurnDtbRoles(vendorDtb, linuxDtb),
    /BL33-selected P211 payload differs from the Linux FDT/,
  );
});

test('burn DTB role validation rejects a vendor multi-DTB as the Linux DTB', (context) => {
  fixture(context);

  assert.throws(
    () => validateBurnDtbRoles(vendorDtb, vendorDtb),
    /Linux boot DTB is not a plain FDT/,
  );
});
