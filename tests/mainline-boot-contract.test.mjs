import assert from 'node:assert/strict';
import test from 'node:test';

import * as mainline from '../src/mainline-boot-contract.mjs';

const ROOT_UUID = '50031852-ee90-4285-ada7-ab9dc14670c9';
const DTB_PATH = '/dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb';

function component(name, size, sha256 = mainline.STOCK_FIP_COMPONENTS[name]) {
  return { size, sha256 };
}

function validEvidence() {
  return {
    schemaVersion: 1,
    status: 'format-valid / hardware-unverified',
    strategy: 'vendor-fip-mainline-bl33-extlinux',
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
      version: 'U-Boot 2026.01 r3300-l',
      defaultBootCommand: 'run distro_bootcmd',
      bootTargets: ['usb0', 'mmc0', 'mmc1', 'pxe', 'dhcp'],
      kernelCompAddress: '0x0d080000',
      kernelCompSize: '0x02000000',
      rawSha256: 'c'.repeat(64),
    },
  };
}

test('extlinux configuration boots compressed Armbian from the MBR FAT partition', () => {
  assert.equal(typeof mainline.createExtlinuxConfig, 'function');
  const config = mainline.createExtlinuxConfig(1024, ROOT_UUID, DTB_PATH);

  assert.match(config, /^DEFAULT armbian$/m);
  assert.match(config, /^\s*LINUX \/Image\.gz$/m);
  assert.match(config, /^\s*INITRD \/initrd\.img$/m);
  assert.match(config, /^\s*FDT \/dtb\/amlogic\/meson-gxl-s905x-p212-b860av11t\.dtb$/m);
  assert.match(config, new RegExp(`root=UUID=${ROOT_UUID}`));
  assert.match(config, /mem=1024M/);
  assert.doesNotMatch(config, /storeboot|imgread|ANDROID!|blkdevparts/);
});

test('mainline FIP evidence preserves vendor stages and uses distro boot on eMMC', () => {
  const evidence = mainline.validateMainlineFipEvidence(validEvidence());

  assert.equal(evidence.strategy, 'vendor-fip-mainline-bl33-extlinux');
  assert.equal(evidence.fip.components.bl2.sha256, mainline.STOCK_FIP_COMPONENTS.bl2);
  assert.equal(evidence.uboot.defaultBootCommand, 'run distro_bootcmd');
  assert.equal(evidence.uboot.bootTargets.includes('mmc1'), true);
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

test('mainline FIP evidence rejects Android boot commands and missing eMMC scan', () => {
  const android = validEvidence();
  android.uboot.defaultBootCommand = 'run storeboot';
  assert.throws(
    () => mainline.validateMainlineFipEvidence(android),
    /default boot command/,
  );

  const noEmmc = validEvidence();
  noEmmc.uboot.bootTargets = ['usb0', 'mmc0', 'pxe', 'dhcp'];
  assert.throws(
    () => mainline.validateMainlineFipEvidence(noEmmc),
    /mmc1/,
  );

  const noCompressedKernelSpace = validEvidence();
  delete noCompressedKernelSpace.uboot.kernelCompSize;
  assert.throws(
    () => mainline.validateMainlineFipEvidence(noCompressedKernelSpace),
    /compressed kernel variables/,
  );
});
