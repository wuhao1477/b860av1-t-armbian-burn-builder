import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('raw validator proves Debian and Armbian identity', () => {
  const script = read('scripts/validate-raw-image.sh');
  const scanner = read('scripts/scan-mounted-image.mjs');

  assert.match(script, /ID=debian/);
  assert.match(script, /board\.distribution/);
  assert.match(script, /board\.distributionVersion/);
  assert.doesNotMatch(script, /VERSION_CODENAME=trixie/);
  assert.match(script, /--expected-codename/);
  assert.match(script, /--expected-major-version/);
  assert.match(scanner, /VERSION_CODENAME/);
  assert.match(scanner, /VERSION_ID/);
  assert.match(scanner, /expected-codename/);
  assert.match(scanner, /expected-major-version/);
  assert.match(script, /etc\/armbian-release/);
  assert.match(script, /etc\/armbian-image-release/);
  assert.match(script, /armbianIdentity/);
  assert.match(script, /debianIdentity/);
});

test('raw validator inspects initramfs, bootargs, DTB, paths and file magic', () => {
  const script = read('scripts/validate-raw-image.sh');
  const scanner = read('scripts/scan-mounted-image.mjs');
  const bootScriptValidator = read('scripts/validate-boot-script.mjs');
  const payloadParser = read('src/uboot-script-payload.mjs');
  const implementation = `${script}\n${scanner}\n${bootScriptValidator}\n${payloadParser}`;

  assert.match(implementation, /dumpimage/);
  assert.match(implementation, /validateUbootScriptImage/);
  assert.match(implementation, /lsinitramfs/);
  assert.match(implementation, /androidboot/i);
  assert.match(implementation, /dtc\s+-I\s+dtb\s+-O\s+dts/);
  assert.match(implementation, /apex/);
  assert.match(implementation, /dex/);
  assert.match(implementation, /vendor_boot\.img/);
  assert.match(implementation, /ANDROID!/);
  assert.match(implementation, /3aff26ed/i);
  assert.match(implementation, /knownAndroidMarkersAbsent/);
  assert.match(implementation, /initrdKnownAndroidMarkersAbsent/);
  assert.match(implementation, /bootConfigKnownAndroidMarkersAbsent/);
  assert.match(implementation, /dtbKnownAndroidMarkersAbsent/);
  assert.match(implementation, /androidScan/);
  assert.match(implementation, /CONTENT_SCAN/);
  assert.match(script, /stockBootScriptStaticPathValid/);
  assert.match(script, /dumpimage\s+-T\s+script\s+-p\s+0/);
  assert.match(script, /s905_autoscript/);
  assert.match(script, /u-boot\.ext/);
  assert.match(script, /validate-boot-script\.mjs/);
});

test('repository-owned stock boot script excludes Android fallback paths', () => {
  const sourcePath = path.join(root, 'config/s905-autoscript.cmd');
  assert.equal(fs.existsSync(sourcePath), true, 'missing repository-owned s905_autoscript source');

  const source = fs.readFileSync(sourcePath, 'utf8');
  const builder = read('scripts/build-raw-image.sh');
  const validator = read('scripts/validate-raw-image.sh');

  assert.doesNotMatch(source, /android/i);
  assert.match(source, /fatload\s+mmc\s+0[^\n]+u-boot\.ext/);
  assert.match(source, /fatload\s+usb\s+0[^\n]+u-boot\.ext/);
  assert.match(source, /uEnv\.txt/);
  assert.match(source, /booti/);
  assert.match(builder, /config\/s905-autoscript\.cmd/);
  assert.match(builder, /mkimage\s+-C\s+none\s+-A\s+arm\s+-T\s+script/);
  assert.match(builder, /extract-uboot-script-payload\.mjs/);
  assert.match(validator, /cmp --[^\n]+config\/s905-autoscript\.cmd/);
  assert.match(validator, /extract-uboot-script-payload\.mjs/);
  assert.match(validator, /Android fallback found in decoded s905_autoscript/);
});

test('validator emits independently hashed filesystem and boot component evidence', () => {
  const script = read('scripts/validate-raw-image.sh');
  const workflow = read('.github/workflows/weekly-build.yml');

  assert.match(script, /filesystem-manifest\.sha256/);
  assert.match(script, /boot-components\.json/);
  assert.match(script, /filesystemManifestSha256/);
  assert.match(script, /bootComponentsSha256/);
  assert.match(workflow, /filesystem-manifest\.sha256/);
  assert.match(workflow, /boot-components\.json/);
  assert.match(workflow, /u-boot-tools/);
  assert.match(workflow, /initramfs-tools-core/);
});

test('validation job regenerates build-input-heads from the trusted manifest', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const validate = workflow.slice(workflow.indexOf('\n  validate:'), workflow.indexOf('\n  publish:'));

  assert.match(validate, /write-build-input-heads\.mjs/);
});

test('independent validation boots the ARM64 kernel and rootfs under QEMU', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const validator = read('scripts/validate-raw-image.sh');
  const smokePath = path.join(root, 'scripts/qemu-system-smoke.sh');

  assert.equal(fs.existsSync(smokePath), true, 'missing QEMU system smoke script');
  const smoke = fs.readFileSync(smokePath, 'utf8');
  assert.match(workflow, /qemu-system-arm/);
  assert.match(workflow, /expect/);
  assert.match(validator, /qemu-system-smoke\.sh/);
  assert.match(validator, /qemuSystemBootSmoke/);
  assert.match(validator, /active_kernel_file/);
  assert.match(validator, /active_initrd_file/);
  assert.match(smoke, /qemu-system-aarch64/);
  assert.match(smoke, /root=UUID=/);
  assert.match(smoke, /etc\/armbian-release/);
  assert.match(smoke, /B860_QEMU_SYSTEM_SMOKE_OK/);
  assert.match(smoke, /uname -r/);
  assert.match(smoke, /B860_QEMU_KERNEL_RELEASE_/);
  assert.match(smoke, /kernelRelease/);
  assert.match(smoke, /snapshot=on/);
});

test('independent validation gates the RTL8189FTV SDIO driver', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const validator = read('scripts/validate-raw-image.sh');
  const resolver = read('scripts/resolve-sources.mjs');
  const reportGate = read('src/change-detection.mjs');
  const notes = read('scripts/render-release-notes.mjs');

  assert.match(workflow, /\bkmod\b/);
  assert.match(workflow, /out\/rtl8189fs-driver\.json/);
  assert.match(validator, /sources\?\.kernel\?\.version/);
  assert.match(validator, /validate-rtl8189fs\.mjs/);
  assert.match(validator, /node - "\$qemu_system_smoke"/);
  assert.match(validator, /validate-rtl8189fs\.mjs" "\$root_mount" "\$kernel_release"/);
  assert.ok(
    validator.indexOf('"$script_dir/qemu-system-smoke.sh"')
      < validator.indexOf('node "$script_dir/validate-rtl8189fs.mjs"'),
  );
  assert.match(validator, /rtl8189fs-driver\.json/);
  assert.match(validator, /rtl8189fsDriver/);
  assert.match(resolver, /scripts\/validate-rtl8189fs\.mjs/);
  assert.match(resolver, /scripts\/qemu-system-smoke\.sh/);
  assert.match(resolver, /src\/rtl8189fs\.mjs/);
  assert.match(reportGate, /rtl8189fsDriver/);
  assert.match(reportGate, /rtl8189fs-driver\.json/);
  assert.match(notes, /RTL8189FTV/);
});

test('independent validation gates installed-kernel and active-DTB hardware capabilities', () => {
  const validator = read('scripts/validate-raw-image.sh');
  const resolver = read('scripts/resolve-sources.mjs');

  assert.match(validator, /validate-hardware-capabilities\.mjs/);
  assert.match(validator, /config\/hardware-capabilities\.json/);
  assert.match(validator, /--filesystem-manifest "\$filesystem_manifest"/);
  assert.match(validator, /--boot-components "\$boot_components"/);
  assert.match(validator, /--rtl8189fs "\$rtl8189fs_evidence"/);
  assert.match(validator, /hardware-capabilities\.json/);
  assert.match(validator, /hardwareCapabilitiesSha256/);
  assert.match(validator, /hardwareCapabilities:\s*true/);
  assert.ok(
    validator.indexOf(') > "$filesystem_manifest"')
      < validator.indexOf('node "$script_dir/validate-hardware-capabilities.mjs"'),
  );
  for (const file of [
    'config/hardware-capabilities.json',
    'scripts/validate-hardware-capabilities.mjs',
    'src/hardware-capabilities.mjs',
  ]) {
    assert.match(resolver, new RegExp(file.replaceAll('.', '\\.').replaceAll('/', '\\/')));
  }
});
