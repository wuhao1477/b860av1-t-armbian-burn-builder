import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as mainline from '../src/mainline-boot-contract.mjs';

const ROOT_UUID = '50031852-ee90-4285-ada7-ab9dc14670c9';
const FIT_BYTES = 4096;
const CLI = fileURLToPath(new URL('../scripts/mainline-boot.mjs', import.meta.url));

function component(name, size, sha256 = mainline.STOCK_FIP_COMPONENTS[name]) {
  return { size, sha256 };
}

function validEvidence() {
  return {
    schemaVersion: 1,
    status: 'format-valid / hardware-unverified',
    strategy: 'vendor-fip-mainline-bl33-fit',
    fip: {
      size: 865_792,
      sha256: 'a'.repeat(64),
      components: {
        bl2: component('bl2', 49_152),
        bl30: component('bl30', 29_696),
        bl301: component('bl301', 8_704),
        bl31: component('bl31', 103_424),
        bl33: component('bl33', 636_416, 'b'.repeat(64)),
      },
    },
    uboot: {
      version: 'U-Boot 2023.01 r3300l',
      defaultBootCommand: mainline.createMainlineBootCommand(ROOT_UUID, FIT_BYTES),
      bootTargets: ['usb0', 'mmc0', 'mmc1', 'pxe', 'dhcp'],
      fitLoadAddress: '0x08000000',
      fitSectors: 8,
      fitStartLba: 2_260_992,
      rootUuid: ROOT_UUID,
      kernelCompAddress: '0x0d080000',
      kernelCompSize: '0x02000000',
      rawSha256: 'c'.repeat(64),
    },
  };
}

test('FIT source binds the compressed kernel, initrd and B860 device tree', () => {
  const source = mainline.createFitSource();

  assert.match(source, /data = \/incbin\/\("Image\.gz"\)/);
  assert.match(source, /compression = "gzip"/);
  assert.match(source, /data = \/incbin\/\("initrd\.img"\)/);
  assert.match(source, /data = \/incbin\/\("linux\.dtb"\)/);
  assert.match(source, /kernel = "kernel"/);
  assert.match(source, /ramdisk = "ramdisk"/);
  assert.match(source, /fdt = "fdt"/);
});

test('fixed U-Boot command reads the raw FIT from the named boot partition offset', () => {
  const command = mainline.createMainlineBootCommand(ROOT_UUID, FIT_BYTES);

  assert.match(command, new RegExp(`root=UUID=${ROOT_UUID}`));
  assert.match(command, /blkdevparts=mmcblk2:/);
  assert.match(command, /mmc dev 1/);
  assert.match(command, /mmc read 0x08000000 0x00228000 0x00000008/);
  assert.match(command, /bootm 0x08000000/);
  assert.doesNotMatch(command, /distro_bootcmd|storeboot|imgread|ANDROID!/);
  assert.deepEqual(mainline.inspectMainlineBootCommand(command), {
    fitLoadAddress: '0x08000000',
    fitSectors: 8,
    fitStartLba: 2_260_992,
    rootUuid: ROOT_UUID,
  });
});

test('mainline boot CLI emits FIT source and the matching fixed boot command', () => {
  const fit = childProcess.spawnSync(process.execPath, [CLI, 'fit-source'], { encoding: 'utf8' });
  const boot = childProcess.spawnSync(
    process.execPath,
    [CLI, 'boot-command', ROOT_UUID, String(FIT_BYTES)],
    { encoding: 'utf8' },
  );

  assert.equal(fit.status, 0, fit.stderr);
  assert.match(fit.stdout, /\/incbin\/\("Image\.gz"\)/);
  assert.equal(boot.status, 0, boot.stderr);
  assert.equal(mainline.inspectMainlineBootCommand(boot.stdout).fitSectors, 8);
});

test('mainline FIP evidence preserves vendor stages and fixes FIT boot on eMMC', () => {
  const evidence = mainline.validateMainlineFipEvidence(validEvidence());

  assert.equal(evidence.strategy, 'vendor-fip-mainline-bl33-fit');
  assert.equal(evidence.fip.components.bl2.sha256, mainline.STOCK_FIP_COMPONENTS.bl2);
  assert.equal(evidence.uboot.fitStartLba, 2_260_992);
  assert.equal(evidence.uboot.fitSectors, 8);
  assert.equal(evidence.uboot.rootUuid, ROOT_UUID);
  assert.equal(evidence.uboot.kernelCompAddress, '0x0d080000');
  assert.equal(evidence.uboot.kernelCompSize, '0x02000000');
});

test('mainline FIP evidence rejects a changed vendor BL31 stage', () => {
  const evidence = validEvidence();
  evidence.fip.components.bl31.sha256 = 'd'.repeat(64);

  assert.throws(
    () => mainline.validateMainlineFipEvidence(evidence),
    /vendor FIP component differs: bl31/,
  );
});

test('mainline FIP evidence rejects Android boot commands and FIT contract drift', () => {
  const android = validEvidence();
  android.uboot.defaultBootCommand = 'run storeboot';
  assert.throws(
    () => mainline.validateMainlineFipEvidence(android),
    /default boot command/,
  );

  const wrongSectors = validEvidence();
  wrongSectors.uboot.fitSectors = 7;
  assert.throws(
    () => mainline.validateMainlineFipEvidence(wrongSectors),
    /FIT sector count/,
  );

  const noCompressedKernelSpace = validEvidence();
  delete noCompressedKernelSpace.uboot.kernelCompSize;
  assert.throws(
    () => mainline.validateMainlineFipEvidence(noCompressedKernelSpace),
    /compressed kernel variables/,
  );
});
