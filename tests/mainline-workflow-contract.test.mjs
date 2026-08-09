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
  assert.equal(recipe.boot.format, 'raw-fit');
  assert.equal(recipe.boot.fitLoadAddress, '0x08000000');
});

test('public burn builder packages mainline BL33, raw FIT and sparse rootfs', () => {
  const builder = read('scripts/build-burn-image.sh');
  const ubootBuilder = read('scripts/build-mainline-uboot.sh');

  for (const payload of ['bootloader.PARTITION', 'boot.PARTITION', 'data.PARTITION']) {
    assert.match(builder, new RegExp(payload.replace('.', '\\.')));
  }
  assert.doesNotMatch(builder, /1\.PARTITION/);
  assert.match(builder, /boot-components\.json/);
  assert.match(builder, /mkimage/);
  assert.match(builder, /fit-source/);
  assert.match(builder, /dumpimage/);
  assert.match(builder, /build-mainline-uboot\.sh/);
  assert.match(builder, /mainline-fip-contract\.json/);
  assert.match(builder, /emmc-boot-contract\.json/);
  assert.doesNotMatch(builder, /env\.PARTITION|system\.PARTITION|mformat|extlinux/);
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
  assert.match(ubootBuilder, /--set-str BOOTCOMMAND/);
  assert.match(ubootBuilder, /boot-command/);
});

test('independent validation unpacks the three named Linux partition payloads', () => {
  const validator = read('scripts/validate-burn-image.sh');

  for (const payload of ['bootloader.PARTITION', 'boot.PARTITION', 'data.PARTITION']) {
    assert.match(validator, new RegExp(payload.replace('.', '\\.')));
  }
  assert.doesNotMatch(validator, /1\.PARTITION/);
  assert.match(validator, /check-emmc-chain/);
  assert.match(validator, /dumpimage/);
  assert.match(validator, /fip-evidence/);
  assert.match(validator, /storeboot/);
  assert.match(validator, /ANDROID!/);
  assert.match(validator, /raw FIT/);
});

test('weekly burn workflow builds and publishes raw FIT boot contracts', () => {
  const workflow = read('.github/workflows/weekly-burn-build.yml');

  assert.match(workflow, /gcc-aarch64-linux-gnu/);
  assert.match(workflow, /libgnutls28-dev/);
  assert.match(workflow, /scripts\/build-burn-image\.sh/);
  assert.match(workflow, /scripts\/validate-burn-image\.sh/);
  assert.match(workflow, /mainline-fip-contract\.json/);
  assert.match(workflow, /emmc-boot-contract\.json/);
  assert.match(workflow, /u-boot-tools/);
  assert.doesNotMatch(workflow, /extlinux/);
});
