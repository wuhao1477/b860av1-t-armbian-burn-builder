import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('raw builder normalizes GitHub slugs and pins ophub dependency directories', () => {
  const script = read('scripts/build-raw-image.sh');

  assert.match(script, /https:\/\/github\.com\/[^\n]+\.git/);
  assert.match(script, /armbian-files\/common-files\/usr\/lib\/firmware/);
  assert.match(script, /compile-kernel\/tools\/script\/ubuntu2404-build-armbian-depends/);
  assert.match(script, /pushd\s+[^\n]*builder_dir/);
  assert.match(script, /board_profile/);
  assert.match(script, /source_built_overload/);
  assert.match(script, /rm -rf -- "\$bootloader_dir"/);
  assert.match(script, /platform_bootfs/);
  assert.match(script, /u-boot\.sd u-boot\.usb/);
  assert.match(script, /allowed_overload/);
  assert.match(script, /memoryLimitMiB/);
  assert.match(script, /patch-boot-config\.mjs/);
  assert.match(script, /write-build-input-heads\.mjs/);
  assert.match(script, /tree_digest/);
  assert.match(script, /locked U-Boot tree changed during rebuild/);
  assert.match(script, /\.\/rebuild\s+-b\s+"\$board_profile"/);
  assert.doesNotMatch(script, /bash\s+-c/);
});

test('raw builder consumes ophub compressed output and writes portable checksums', () => {
  const script = read('scripts/build-raw-image.sh');
  const resolver = read('scripts/resolve-sources.mjs');

  assert.match(script, /find\s+"\$image_dir"[^\n]+-name\s+'\*\.img\.gz'/);
  assert.doesNotMatch(script, /built_images[^\n]*-name\s+'\*\.img'/);
  assert.match(script, /sanitize-raw-image\.mjs/);
  assert.match(script, /gzip[^\n]+--no-name/);
  assert.match(script, /cd\s+"\$output_dir"[\s\S]*sha256sum\s+--\s+"\$image_name"/);
  assert.match(resolver, /scripts\/sanitize-raw-image\.mjs/);
  assert.match(resolver, /scripts\/validate-candidate-artifacts\.mjs/);
});

test('resolver fingerprints the complete image identity and device evidence recipe', () => {
  const resolver = read('scripts/resolve-sources.mjs');
  for (const file of [
    'src/image-identity.mjs',
    'scripts/write-image-identity.mjs',
    'src/device-evidence.mjs',
    'scripts/collect-device-evidence.sh',
    'scripts/render-device-evidence.mjs',
    'scripts/validate-device-evidence.mjs',
    'scripts/render-device-validation-summary.mjs',
    'src/release-metadata.mjs',
    'scripts/generate-release-metadata.mjs',
    '.github/workflows/device-evidence-pr.yml',
    '.github/workflows/verify-device.yml',
  ]) assert.match(resolver, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('README documents raw-image and operator-attested device validation boundaries', () => {
  const readme = read('README.md');
  assert.match(readme, /\.img\.gz/);
  assert.match(readme, /burn\.img/);
  assert.match(readme, /verify-device\.yml/);
  assert.match(readme, /operator-attested \/ one-device/);
  assert.match(readme, /container-valid \/ hardware-unverified/);
  for (const evidence of [
    'emmc-boot-contract.json', 'mainline-fip-contract.json',
    'rootfs-contract.json', 'burn-report.json',
  ]) assert.match(readme, new RegExp(evidence.replace('.', '\\.')));
});

test('raw builder writes the identity into rootfs before final sanitization', () => {
  const script = read('scripts/build-raw-image.sh');
  const identity = script.indexOf('write-image-identity.mjs');
  const sanitize = script.indexOf('sanitize-raw-image.mjs');

  assert.notEqual(identity, -1, 'raw builder does not write the image identity');
  assert.ok(identity < sanitize, 'image identity must be written before final sanitization');
  assert.match(script, /losetup\s+--find\s+--show\s+--partscan/);
  assert.match(script, /mount[^\n]+root_partition/);
  assert.match(script, /linux-headers-\$\{kernel_version\}-/);
  assert.match(script, /e2fsck\s+-fy/);
});

test('raw validator reads filesystem types correctly and checks target boot assets', () => {
  const script = read('scripts/validate-raw-image.sh');

  assert.match(script, /blkid\s+(?:--match-tag|-s)\s+TYPE\s+(?:--output|-o)\s+value/);
  assert.match(script, /meson-gxl-s905x-p212-b860av11t\.dtb/);
  assert.match(script, /u-boot-s905x-s912\.bin/);
  assert.match(script, /validate-uboot-build\.mjs/);
  assert.match(script, /mount[^\n]+ro,noload[^\n]+root_partition/);
  assert.match(script, /image-identity\.mjs/);
  assert.match(script, /imageIdentity/);
});

test('release notes consume the resolver board schema', () => {
  const script = read('scripts/render-release-notes.mjs');

  assert.match(script, /manifest\.board/);
  assert.match(script, /board\.distribution/);
  assert.match(script, /board\.profile/);
});

test('weekly publication is idempotent for a forced identical fingerprint', () => {
  const workflow = read('.github/workflows/weekly-build.yml');

  assert.match(workflow, /sources\.base\.armbianVersion/);
  assert.match(workflow, /board\.distribution/);
  assert.match(workflow, /sources\.kernel\.version/);
  assert.match(workflow, /GITHUB_RUN_NUMBER/);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /gh release upload[^\n]+--clobber/);
  assert.match(workflow, /gh release edit/);
});

test('validator includes userspace, kernel, DTB, service and media-size checks', () => {
  const script = read('scripts/validate-raw-image.sh');
  const bootScriptValidator = read('scripts/validate-boot-script.mjs');

  assert.match(script, /qemu-aarch64-static/);
  assert.match(script, /proot/);
  assert.match(script, /dpkg-query/);
  assert.match(script, /systemctl\s+--root/);
  assert.match(script, /fdtget/);
  assert.match(script, /file\s+[^\n]*(?:Image|kernel)/);
  assert.match(script, /aarch64\|arm64/i);
  assert.doesNotMatch(script, /ARM\|aarch64\|Linux kernel/);
  assert.match(script, /persistentBootloaderAbsent/);
  assert.match(script, /root_mount\/usr\/lib\/u-boot/);
  assert.match(script, /unexpected U-Boot file/);
  assert.match(script, /prohibited legacy U-Boot payload/);
  assert.match(script, /unexpected boot binary/);
  assert.match(script, /-name '\*\.fip'/);
  assert.match(script, /-iname 'bl2\*'/);
  assert.match(script, /manifestFingerprint/);
  assert.match(script, /legacyUbootPayloadsAbsent/);
  assert.match(script, /sfdisk\s+--json/);
  assert.match(script, /count=440/);
  assert.match(script, /mbrBootstrapEmpty/);
  assert.match(script, /\/usr\/lib\/systemd\/systemd --version/);
  assert.doesNotMatch(script, /'systemd --version/);
  assert.match(script, /first_partition_start/);
  assert.match(script, /sfdisk\s+--dump[\s\S]*label:\s+dos/);
  assert.match(script, /package-state/);
  assert.match(script, /\[\[\s*!\s+-s\s+"\$package_state_output"\s+\]\]/);
  assert.match(script, /for prohibited in system vendor recovery product odm system_ext apex vendor_dlkm odm_dlkm/);
  assert.match(script, /root_mount\/init/);
  assert.match(script, /kernel\[\[:space:\]\].*\/zImage/);
  assert.match(script, /initrd\[\[:space:\]\].*\/uInitrd/);
  assert.match(script, /root=UUID=\$\{root_uuid\}/);
  assert.match(script, /memory_limit_mib/);
  assert.match(script, /mem=\$\{memory_limit_mib\}M/);
  assert.match(script, /s905_autoscript|aml_autoscript/);
  assert.match(script, /dumpimage\s+-T\s+script/);
  assert.match(script, /validate-boot-script\.mjs/);
  assert.match(bootScriptValidator, /booti/);
  assert.match(script, /board-limits\.mjs/);
  assert.match(script, /max_image_bytes/);
  assert.match(script, /#partitions\[@\][^\n]+-eq\s+2/);
  for (const artifact of ['boot.img', 'logo.img', 'recovery.img', 'system.img']) {
    assert.match(script, new RegExp(artifact.replace('.', '\\.')));
  }
});

test('burn builder creates a mainline BL33 raw FIT eMMC package', () => {
  const builder = read('scripts/build-burn-image.sh');
  const validator = read('scripts/validate-burn-image.sh');
  assert.match(builder, /blkid --match-tag UUID --output value \"\$root_part\"/);
  assert.match(validator, /sparse-ext4-uuid/);
  for (const payload of [
    'boot.PARTITION', 'data.PARTITION', 'bootloader.PARTITION', 'meson1.dtb',
  ]) {
    const pattern = new RegExp(payload.replace('.', '\\.'));
    assert.match(builder, pattern);
    assert.match(validator, pattern);
  }
  assert.doesNotMatch(builder, /1\.PARTITION/);
  assert.doesNotMatch(validator, /1\.PARTITION/);
  assert.doesNotMatch(builder, /env\.PARTITION|system\.PARTITION/);
  assert.match(validator, /env\.PARTITION|system\.PARTITION/);
  assert.doesNotMatch(validator, /check-stock-boot|replace-linux-target-dtb/);
  assert.match(builder, /mkimage/);
  assert.match(builder, /boot-components\.json/);
  assert.match(builder, /fit-source/);
  assert.match(builder, /build-mainline-uboot\.sh/);
  assert.doesNotMatch(builder, /dos-mbr/);
  assert.match(builder, /check-emmc-chain/);
  assert.match(validator, /check-emmc-chain/);
  assert.match(builder, /check-burn-partitions/);
  assert.match(validator, /check-burn-partitions/);
  assert.match(builder, /2147483648/);
  assert.match(builder, /board-inputs\/\$name/);
  assert.match(validator, /meson1\.dtb/);
  assert.match(validator, /prohibited Android partition payload/);
  for (const evidence of [
    'emmc-boot-contract.json', 'mainline-fip-contract.json', 'rootfs-contract.json',
  ]) {
    const pattern = new RegExp(evidence.replace('.', '\\.'));
    assert.match(builder, pattern);
    assert.match(validator, pattern);
  }
  assert.match(builder, /check-sparse-capacity/);
  assert.match(builder, /burn-image\.mjs" report/);
  assert.match(validator, /check-sparse-capacity/);
  assert.match(validator, /burn-image\.mjs" check-report/);
  for (const script of [builder, validator]) {
    assert.match(script, /config\/burn-tooling\.json/);
    assert.match(script, /checkout --detach/);
  }
});
