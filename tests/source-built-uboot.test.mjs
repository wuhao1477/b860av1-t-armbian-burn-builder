import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

test('B860 target uses the public P212 source-built overload path', () => {
  const board = readJson('config/board.json');

  assert.equal(board.profile, 'b860av1-t');
  assert.equal(board.dtb, 'meson-gxl-s905x-p212-b860av11t.dtb');
  assert.equal(board.ubootOverload, 'u-boot-s905x-s912.bin');
  assert.equal(board.ubootOverloadBuild.reproducibleFromSource, true);
  assert.equal(board.ubootOverloadBuild.defconfig, 'libretech-cc_defconfig');
  assert.equal(board.ubootOverloadBuild.patch, 'patches/u-boot/u-boot-s905x-s912.patch');
  assert.match(board.ubootOverloadBuild.patchSha256, /^[0-9a-f]{64}$/);
  assert.equal(board.ubootOverloadBuild.sourceDateEpoch, 0);
  assert.equal(board.ubootOverloadSha256, undefined);
  assert.equal(board.ubootOverloadSize, undefined);
});

test('source resolver fingerprints the exact public U-Boot source recipe', () => {
  const sources = readJson('config/sources.json');
  const resolver = read('scripts/resolve-sources.mjs');
  const validator = read('src/upstream.mjs');

  assert.equal(sources.schemaVersion, 5);
  assert.equal(sources.ubootSource.repository, 'u-boot/u-boot');
  assert.equal(sources.ubootSource.ref, 'v2020.07');
  assert.match(resolver, /resolveCommit\(sourceConfig\.ubootSource\)/);
  assert.match(resolver, /ubootSource/);
  assert.match(resolver, /patches\/u-boot\/u-boot-s905x-s912\.patch/);
  assert.match(validator, /manifest\.sources\.ubootSource/);
  assert.match(validator, /reproducibleFromSource[^\n]+true/);
});

test('U-Boot builder compiles a fixed commit and emits provenance evidence', () => {
  const script = read('scripts/build-uboot-overload.sh');

  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m);
  assert.match(script, /git clone/);
  assert.match(script, /checkout --detach/);
  assert.match(script, /patch_sha256/);
  assert.match(script, /sha256sum --check/);
  assert.match(script, /git -C [^\n]+ apply/);
  assert.match(script, /CROSS_COMPILE/);
  assert.match(script, /SOURCE_DATE_EPOCH/);
  assert.match(script, /libretech-cc_defconfig|defconfig/);
  assert.match(script, /build_output/);
  assert.match(script, /uboot-build\.json/);
  assert.match(script, /u-boot-source\.tar\.gz/);
  assert.match(script, /sourceTreeSha256|source_tree_sha256/);
  assert.match(script, /tar[^\n]+--sort=name/);
  assert.match(script, /gzip[^\n]+--no-name/);
  assert.doesNotMatch(script, /u-boot-r3300l/);
});

test('raw builder injects only the source-built overload', () => {
  const script = read('scripts/build-raw-image.sh');

  assert.match(script, /build-uboot-overload\.sh/);
  assert.match(script, /source_built_overload/);
  assert.match(script, /cp[^\n]+source_built_overload[^\n]+overload_dir/);
  assert.doesNotMatch(script, /ubootOverloadSha256/);
  assert.doesNotMatch(script, /ubootOverloadSize/);
});

test('raw builder installs source-built u-boot.ext before upstream rebuild', () => {
  const script = read('scripts/build-raw-image.sh');
  const install = script.indexOf(
    'install -m 0644 -- "$source_built_overload" "$platform_bootfs/u-boot.ext"',
  );
  const rebuild = script.indexOf('sudo ./rebuild');

  assert.ok(install >= 0, 'source-built u-boot.ext injection is missing');
  assert.ok(install < rebuild, 'u-boot.ext must be present before ophub rebuild copies bootfs');
});

test('current build does not clone ophub binary bundle repositories', () => {
  const sources = readJson('config/sources.json');
  const resolver = read('scripts/resolve-sources.mjs');
  const rawBuilder = read('scripts/build-raw-image.sh');

  assert.equal(sources.uboot, undefined);
  assert.equal(sources.firmware, undefined);
  assert.doesNotMatch(resolver, /resolveCommit\(sourceConfig\.(?:uboot|firmware)\)/);
  assert.doesNotMatch(rawBuilder, /uboot_checkout|firmware_checkout/);
  assert.doesNotMatch(rawBuilder, /ophub\/(?:u-boot|firmware)/);
  assert.match(rawBuilder, /disable-binary-dependency-downloads\.mjs/);
  const disabler = read('scripts/disable-binary-dependency-downloads.mjs');
  assert.match(disabler, /download_depends\(\)/);
  assert.match(disabler, /git_pull_dir/);
  assert.match(disabler, /binary dependency downloads are disabled/);
});

test('repository builds both autoscripts without Android or stock fallback', () => {
  const aml = read('config/aml-autoscript.cmd');
  const rawBuilder = read('scripts/build-raw-image.sh');

  assert.match(aml, /s905_autoscript/);
  assert.match(aml, /saveenv/);
  assert.doesNotMatch(aml, /android|storeboot/i);
  assert.match(rawBuilder, /aml-autoscript\.cmd/);
  assert.match(rawBuilder, /platform_bootfs\/aml_autoscript/);
});

test('builder installs a repository-owned B860 board profile', () => {
  const entry = read('config/b860av1-t-model.conf');
  const rawBuilder = read('scripts/build-raw-image.sh');
  const installer = read('scripts/install-board-profile.mjs');

  assert.match(entry, /ZXV10-B860AV1\.1-T/);
  assert.match(entry, /:s905l:/);
  assert.match(entry, /:meson-gxl-s905x-p212-b860av11t\.dtb:/);
  assert.match(entry, /:u-boot-s905x-s912\.bin:/);
  assert.match(entry, /:1\+8G/);
  assert.match(entry, /:b860av1-t:(?:yes|no)$/m);
  assert.match(rawBuilder, /install-board-profile\.mjs/);
  assert.match(installer, /model_database\.conf/);
  assert.match(installer, /duplicate board profile/);
});

test('trusted validation independently rebuilds and publishes U-Boot evidence', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const validateStart = workflow.indexOf('\n  validate:');
  const publishStart = workflow.indexOf('\n  publish:');
  const validate = workflow.slice(validateStart, publishStart);

  assert.match(validate, /build-uboot-overload\.sh/);
  assert.match(validate, /uboot-build\.json/);
  assert.match(validate, /validate-raw-image\.sh[^\n]+uboot-build\.json/);
  assert.match(workflow, /out\/uboot-build\.json/);
  assert.match(workflow, /out\/u-boot-source\.tar\.gz/);
  assert.match(workflow, /'uboot-build\.json'/);
  assert.match(workflow, /'u-boot-source\.tar\.gz'/);
});

test('pull request CI compiles the public U-Boot payload twice byte-for-byte', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /source-built-uboot:/);
  assert.match(workflow, /gcc-aarch64-linux-gnu/);
  assert.match(workflow, /build-uboot-overload\.sh[^\n]+uboot-first/);
  assert.match(workflow, /build-uboot-overload\.sh[^\n]+uboot-second/);
  assert.match(workflow, /cmp[^\n]+u-boot-s905x-s912\.bin/);
  assert.match(workflow, /cmp[^\n]+uboot-build\.json/);
  assert.match(workflow, /cmp[^\n]+u-boot-source\.tar\.gz/);
});
