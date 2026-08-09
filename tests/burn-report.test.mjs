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
  const emmcBoot = path.join(directory, 'emmc-boot-contract.json');
  const mainlineFip = path.join(directory, 'mainline-fip-contract.json');
  const rootfs = path.join(directory, 'rootfs-contract.json');
  fs.writeFileSync(burn, 'burn');
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(emmcBoot, JSON.stringify({
    strategy: 'vendor-fip-mainline-bl33-fit', rootUuid: 'root-uuid',
  }));
  fs.writeFileSync(mainlineFip, JSON.stringify({
    strategy: 'vendor-fip-mainline-bl33-fit',
    uboot: { fitSectors: 8 },
  }));
  fs.writeFileSync(rootfs, JSON.stringify({ logicalBytes: 3145728000, availableBytes: 5584080896 }));
  return { burn, directory, emmcBoot, mainlineFip, rootfs, source };
}

test('burn report binds the image to eMMC, FIP and rootfs evidence', async (context) => {
  const { burn, emmcBoot, mainlineFip, rootfs, source } = fixture(context);
  const result = await burnImage.buildBurnReport({
    burnPath: burn,
    emmcBootContractPath: emmcBoot,
    mainlineFipContractPath: mainlineFip,
    rawSourcePath: source,
    rootfsContractPath: rootfs,
  });

  assert.equal(result.schemaVersion, 4);
  assert.equal(result.status, 'format-valid / hardware-unverified');
  assert.equal(result.board, 'ZXV10 B860AV1.1-T');
  assert.equal(result.emmcBoot.strategy, 'vendor-fip-mainline-bl33-fit');
  assert.equal(result.mainlineFip.uboot.fitSectors, 8);
  assert.deepEqual(result.rootfs, { logicalBytes: 3145728000, availableBytes: 5584080896 });
  assert.equal(result.burn.size, 4);
  assert.equal(result.source.name, 'Armbian_test.img.gz');
  assert.match(result.burn.sha256, /^[0-9a-f]{64}$/u);
  assert.match(result.source.sha256, /^[0-9a-f]{64}$/u);
});

test('burn report validation rejects substituted eMMC boot evidence', async (context) => {
  const { burn, directory, emmcBoot, mainlineFip, rootfs, source } = fixture(context);
  const reportPath = path.join(directory, 'burn-report.json');
  const inputs = {
    burnPath: burn,
    emmcBootContractPath: emmcBoot,
    mainlineFipContractPath: mainlineFip,
    rawSourcePath: source,
    rootfsContractPath: rootfs,
  };
  fs.writeFileSync(reportPath, JSON.stringify(await burnImage.buildBurnReport(inputs)));
  fs.writeFileSync(emmcBoot, JSON.stringify({
    strategy: 'stock-fip-storeboot', rootUuid: 'root-uuid',
  }));

  await assert.rejects(
    () => burnImage.validateBurnReport({ ...inputs, reportPath }),
    /burn report does not match independently validated evidence/u,
  );
});

test('burn report CLI emits machine-readable bound evidence', (context) => {
  const { burn, emmcBoot, mainlineFip, rootfs, source } = fixture(context);
  const result = childProcess.spawnSync(process.execPath, [
    cli, 'report', burn, source, emmcBoot, mainlineFip, rootfs,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.burn.name, 'burn.img');
  assert.equal(report.emmcBoot.strategy, 'vendor-fip-mainline-bl33-fit');
});
