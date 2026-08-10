import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as burnImage from '../scripts/burn-image.mjs';

const cli = fileURLToPath(new URL('../scripts/burn-image.mjs', import.meta.url));

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-burn-report-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const burn = path.join(directory, 'burn.img');
  const source = path.join(directory, 'Armbian_test.img.gz');
  const boot = path.join(directory, 'boot-contract.json');
  const dtb = path.join(directory, 'dtb-contract.json');
  const rootfs = path.join(directory, 'rootfs-contract.json');
  fs.writeFileSync(burn, 'burn');
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(boot, JSON.stringify({ initrdCodec: 'gzip', rootUuid: 'root-uuid' }));
  fs.writeFileSync(dtb, JSON.stringify({ target: 'gxl_p211_1g', layoutMiB: { data: 2176 } }));
  fs.writeFileSync(rootfs, JSON.stringify({ logicalBytes: 3145728000, availableBytes: 5584080896 }));
  return { boot, burn, directory, dtb, rootfs, source };
}

test('burn report binds the image to boot, DTB, and rootfs evidence', async (context) => {
  const { boot, burn, dtb, rootfs, source } = fixture(context);

  assert.equal(typeof burnImage.buildBurnReport, 'function');
  const result = await burnImage.buildBurnReport({
    bootContractPath: boot,
    burnPath: burn,
    dtbContractPath: dtb,
    rawSourcePath: source,
    rootfsContractPath: rootfs,
  });

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.status, 'format-valid / hardware-unverified');
  assert.equal(result.board, 'ZXV10 B860AV1.1-T');
  assert.deepEqual(result.boot, { initrdCodec: 'gzip', rootUuid: 'root-uuid' });
  assert.deepEqual(result.deviceTree, { target: 'gxl_p211_1g', layoutMiB: { data: 2176 } });
  assert.deepEqual(result.rootfs, { logicalBytes: 3145728000, availableBytes: 5584080896 });
  assert.equal(result.burn.size, 4);
  assert.equal(result.source.name, 'Armbian_test.img.gz');
  assert.equal(result.source.size, 6);
  assert.match(result.burn.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.source.sha256, /^[0-9a-f]{64}$/);
});

test('burn report validation rejects substituted boot evidence', async (context) => {
  const { boot, burn, directory, dtb, rootfs, source } = fixture(context);
  const reportPath = path.join(directory, 'burn-report.json');
  const report = await burnImage.buildBurnReport({
    bootContractPath: boot,
    burnPath: burn,
    dtbContractPath: dtb,
    rawSourcePath: source,
    rootfsContractPath: rootfs,
  });
  fs.writeFileSync(reportPath, JSON.stringify(report));
  fs.writeFileSync(boot, JSON.stringify({ initrdCodec: 'xz', rootUuid: 'root-uuid' }));

  assert.equal(typeof burnImage.validateBurnReport, 'function');
  await assert.rejects(
    () => burnImage.validateBurnReport({
      bootContractPath: boot,
      burnPath: burn,
      dtbContractPath: dtb,
      rawSourcePath: source,
      reportPath,
      rootfsContractPath: rootfs,
    }),
    /burn report does not match independently validated evidence/,
  );
});

test('burn report CLI emits machine-readable bound evidence', (context) => {
  const { boot, burn, dtb, rootfs, source } = fixture(context);
  const result = childProcess.spawnSync(process.execPath, [
    cli, 'report', burn, source, boot, dtb, rootfs,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.burn.name, 'burn.img');
  assert.equal(report.deviceTree.target, 'gxl_p211_1g');
});
