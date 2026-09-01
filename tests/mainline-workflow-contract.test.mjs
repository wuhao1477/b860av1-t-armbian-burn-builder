import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

function read(name) {
  return fs.readFileSync(new URL(name, ROOT), 'utf8');
}

test('mainline boot recipe pins the official Bestv inputs and B860 eMMC limit', () => {
  const recipe = JSON.parse(read('config/mainline-boot.json'));
  const boardPatch = fs.readFileSync(new URL(recipe.uboot.patch.path, ROOT));
  const emmcPatch = fs.readFileSync(new URL(recipe.uboot.emmcPatch.path, ROOT));

  assert.equal(recipe.schemaVersion, 1);
  assert.equal(recipe.uboot.repository, 'https://github.com/u-boot/u-boot.git');
  assert.equal(recipe.uboot.tag, 'v2026.01');
  assert.equal(recipe.uboot.commit, '127a42c7257a6ffbbd1575ed1cbaa8f5408a44b3');
  assert.equal(recipe.uboot.defconfig, 'bestv-r3300-l_defconfig');
  assert.equal(recipe.uboot.patch.armbianBuildCommit, '1fdeb047ef77d00f8ccb30da84fe9fd54664ec54');
  assert.equal(recipe.uboot.patch.sha256, crypto.createHash('sha256').update(boardPatch).digest('hex'));
  assert.equal(recipe.uboot.emmcPatch.sha256, crypto.createHash('sha256').update(emmcPatch).digest('hex'));
  assert.equal(recipe.uboot.emmcPatch.maxFrequency, 50_000_000);
  assert.equal(recipe.gxlimg.commit, '37a3ea072ca81bb3872441a09fe758340fd67dcb');
  assert.equal(recipe.stockFip.sha256, '50b0fb65121e6a7e174f11f556e03d80532feccac747b4f4a646af5bde7f8ba8');
  assert.equal(recipe.stockFip.components.bl2, '0ed67a2ee15629eb4af16b41d2908816d3a4fe7ca591bcec7756fb56afc26417');
  assert.equal(recipe.stockFip.components.bl31, '2f4947e9f92aa9aabdd452f2514f268ee657fed610629cd2457a329be571101a');
  assert.equal(recipe.boot.startMiB, 1104);
  assert.equal(recipe.boot.sizeMiB, 32);
});

test('public burn builder packages mainline BL33, FAT16 extlinux and sparse rootfs', () => {
  const builder = read('scripts/build-burn-image.sh');
  const payloads = read('scripts/build-burn-payloads.sh');
  const ubootBuilder = read('scripts/build-mainline-uboot.sh');

  for (const payload of ['bootloader.PARTITION', 'boot.PARTITION', 'data.PARTITION']) {
    assert.match(builder, new RegExp(payload.replace('.', '\\.')));
  }
  // MBR 嵌进 bootloader 的 sector 0；名为 "1" 的分区不在 meson1.dtb 的表里，
  // 单独写它会让烧录停在 [0x30402004] 初始化分区错误。
  assert.match(builder, /embed-dos-mbr[\s\S]{0,120}bootloader\.PARTITION/);
  assert.doesNotMatch(builder, /"\$package\/1\.PARTITION"/);
  assert.match(builder, /build-burn-payloads\.sh/);
  assert.match(builder, /build-mainline-uboot\.sh/);
  assert.match(builder, /mainline-fip-contract\.json/);
  assert.match(builder, /emmc-boot-contract\.json/);
  assert.doesNotMatch(builder, /env\.PARTITION|system\.PARTITION|armbian\.fit|check-fit/);
  // 载荷构建与 bootloader 无关，已拆成独立脚本供变体 A 和变体 C 共用。
  assert.match(payloads, /boot-components\.json/);
  assert.match(payloads, /mformat/);
  assert.match(payloads, /extlinux\/extlinux\.conf/);
  assert.match(payloads, /blkid --match-tag UUID --output value "\$root_part"/);
  assert.match(payloads, /sparse-ext4-uuid/);
  assert.doesNotMatch(payloads, /bootloader\.PARTITION|embed-dos-mbr|gxlimg/);
  assert.match(ubootBuilder, /value\.uboot\.defconfig/);
  assert.match(ubootBuilder, /gxlimg[^\n]+-t bl3x/);
  assert.match(ubootBuilder, /--bl301/);
  assert.match(ubootBuilder, /CONFIG_ENV_IS_NOWHERE/);
  assert.match(ubootBuilder, /--enable VIDEO/);
  assert.match(ubootBuilder, /--enable VIDEO_MESON/);
  assert.match(ubootBuilder, /--enable VIDEO_DT_SIMPLEFB/);
  assert.match(
    ubootBuilder,
    /for option in CONFIG_VIDEO CONFIG_VIDEO_MESON CONFIG_VIDEO_DT_SIMPLEFB/,
  );
  assert.match(ubootBuilder, /grep -qx "\$option=y"/);
  assert.doesNotMatch(ubootBuilder, /CONFIG_BOOTCOMMAND|--set-str BOOTCOMMAND/);
});

test('independent validation unpacks the three Linux partition payloads', () => {
  const validator = read('scripts/validate-burn-image.sh');

  for (const payload of ['bootloader.PARTITION', 'boot.PARTITION', 'data.PARTITION']) {
    assert.match(validator, new RegExp(payload.replace('.', '\\.')));
  }
  // 1.PARTITION 必须在禁止列表里，且 MBR 从 bootloader 的 sector 0 读。
  assert.match(validator, /for name in 1\.PARTITION env\.PARTITION/);
  assert.match(validator, /check-emmc-chain\s*\\?\s*\n?\s*"\$tmp\/unpack\/bootloader\.PARTITION"/);
  assert.match(validator, /check-emmc-chain/);
  assert.match(validator, /fip-evidence/);
  assert.match(validator, /storeboot/);
  assert.match(validator, /ANDROID!/);
  assert.doesNotMatch(validator, /check-fit|raw FIT/);
});

test('weekly burn workflow publishes the vendor-boot variant, not the falsified ones', () => {
  const workflow = read('.github/workflows/weekly-burn-build.yml');

  assert.match(workflow, /gcc-aarch64-linux-gnu/);
  assert.match(workflow, /libgnutls28-dev/);
  assert.match(workflow, /scripts\/build-burn-payloads\.sh/);
  assert.match(workflow, /scripts\/build-vendor-boot-burn\.sh/);
  assert.match(workflow, /scripts\/validate-vendor-boot-burn\.sh/);
  assert.match(workflow, /vendor-boot-contract\.json/);
  assert.match(workflow, /burn-dtb-contract\.json/);
  // 变体 A/B 实机全黑，绝不能再出现在发布路径里。
  assert.doesNotMatch(
    workflow,
    /build-burn-image\.sh|validate-burn-image\.sh|build-ophub-bl33-burn\.sh|mainline-fip-contract\.json|emmc-boot-contract\.json/,
  );
});
