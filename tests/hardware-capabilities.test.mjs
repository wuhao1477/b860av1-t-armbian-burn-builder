import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  HARDWARE_CAPABILITY_RECIPE_PATH,
  evaluateHardwareCapabilities,
  parseKernelConfig,
  requiresHardwareCapabilityValidation,
  validateHardwareCapabilityEvidence,
  validateHardwareCapabilityRecipe,
} from '../src/hardware-capabilities.mjs';
import { validatePublishedState } from '../src/change-detection.mjs';
import { buildManifest } from '../src/upstream.mjs';

const recipeUrl = new URL('../config/hardware-capabilities.json', import.meta.url);
const recipe = JSON.parse(fs.readFileSync(recipeUrl, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function markedManifest() {
  const base = JSON.parse(fs.readFileSync(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'));
  const board = JSON.parse(fs.readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'));
  return buildManifest({
    ...base,
    schemaVersion: 5,
    board: { ...base.board, ...board, distribution: 'trixie', distributionVersion: '13' },
    recipe: {
      ...base.recipe,
      files: { ...base.recipe.files, [HARDWARE_CAPABILITY_RECIPE_PATH]: 'a'.repeat(64) },
    },
  });
}

function markedReport(manifest) {
  const checks = {
    gzip: true, partitionTable: true, fatBoot: true, ext4Rootfs: true,
    debianStableRelease: true, debianIdentity: true, armbianIdentity: true,
    bootFiles: true, memoryLimitApplied: true, stockBootScriptStaticPathValid: true,
    primaryBootScriptAndroidFallbackAbsent: true, installerBootScriptAndroidFallbackAbsent: true,
    kernelArchitecture: true, dtbCompatible: true, rootfsLabel: true, userspaceSmoke: true,
    packageState: true, sshUnit: true, imageFits8GB: true, mbrBootstrapEmpty: true,
    mbrReservedBytesEmpty: true, partitionStartMatchesManifest: true,
    persistentBootloaderAbsent: true, bootloaderPayloadsExcluded: true,
    legacyUbootPayloadsAbsent: true, knownAndroidMarkersAbsent: true,
    initrdKnownAndroidMarkersAbsent: true, bootConfigKnownAndroidMarkersAbsent: true,
    dtbKnownAndroidMarkersAbsent: true, filesystemManifestCreated: true,
    bootComponentsRecorded: true, ubootOverloadProvenance: true,
    sourceBuiltUbootOverload: true, sourceBuiltDeviceTree: true,
    qemuSystemBootSmoke: true,
  };
  return {
    schemaVersion: 8,
    status: 'container-valid / hardware-unverified',
    image: 'out/Armbian_candidate.img.gz',
    imageSha256: 'b'.repeat(64),
    rawSha256: 'c'.repeat(64),
    manifestFingerprint: manifest.fingerprint,
    evidence: {
      filesystemManifest: 'filesystem-manifest.sha256', filesystemManifestSha256: 'd'.repeat(64),
      bootComponents: 'boot-components.json', bootComponentsSha256: 'e'.repeat(64),
      ubootBuild: 'uboot-build.json', ubootBuildSha256: 'f'.repeat(64),
      ubootSourceArchive: 'u-boot-source.tar.gz', ubootSourceArchiveSha256: '1'.repeat(64),
      thirdPartySources: 'THIRD_PARTY_SOURCES.md', thirdPartySourcesSha256: '2'.repeat(64),
      sourceBuiltDeviceTree: {
        build: 'source-built-dtb.json', buildSha256: '3'.repeat(64),
        source: 'device-tree-source.dts', sourceSha256: manifest.board.dtbBuild.sourceSha256,
      },
      qemuSystemSmoke: 'qemu-system-smoke.json', qemuSystemSmokeSha256: '4'.repeat(64),
      qemuSystemConsole: 'qemu-system-smoke.log', qemuSystemConsoleSha256: '5'.repeat(64),
      hardwareCapabilities: 'hardware-capabilities.json', hardwareCapabilitiesSha256: '6'.repeat(64),
    },
    checks,
    androidScan: { schemaVersion: 1, findings: { rootfs: [], boot: [], initrd: [], bootConfig: [], dtb: [] } },
  };
}

function observedValue(check) {
  if (check.type === 'present') return true;
  if (check.type === 'string-list') return ['vendor,other', check.expected];
  if (check.type === 'hex-cell') {
    const cells = Array.from({ length: check.index + 1 }, () => '0');
    cells[check.index] = check.expected;
    return cells;
  }
  return check.expected;
}

function kernelConfigSource(valueOverride = {}) {
  const required = Object.assign({}, ...Object.values(recipe.capabilities).map((entry) => entry.kernelConfig));
  return Object.entries({ ...required, ...valueOverride })
    .map(([name, value]) => `${name}=${value}`)
    .join('\n') + '\n';
}

function evaluatedCapabilities() {
  return evaluateHardwareCapabilities(recipe, kernelConfigSource(), observedValue);
}

function evidenceFixture() {
  const kernelRelease = '5.10.260-ophub';
  const configPath = `usr/src/linux-headers-${kernelRelease}/include/config/auto.conf`;
  const configSha256 = 'a'.repeat(64);
  const dtbPath = 'dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb';
  const dtbSha256 = 'b'.repeat(64);
  const rtlBody = `${JSON.stringify({ kernelRelease })}\n`;
  const rtlSha256 = sha256(rtlBody);
  const recipeSha256 = sha256(fs.readFileSync(recipeUrl));
  return {
    value: {
      schemaVersion: 1,
      status: 'passed',
      recipe: { path: HARDWARE_CAPABILITY_RECIPE_PATH, sha256: recipeSha256 },
      kernel: {
        release: kernelRelease,
        config: { path: configPath, sha256: configSha256 },
      },
      deviceTree: { path: dtbPath, sha256: dtbSha256 },
      wifiDriver: { path: 'rtl8189fs-driver.json', sha256: rtlSha256 },
      capabilities: evaluatedCapabilities(),
    },
    context: {
      recipe,
      manifest: {
        recipe: { files: { [HARDWARE_CAPABILITY_RECIPE_PATH]: recipeSha256 } },
        sources: { kernel: { version: '5.10.260' } },
      },
      filesystemManifest: `${configSha256}  ./${configPath}\n`,
      bootComponents: {
        schemaVersion: 2,
        components: [{ role: 'dtb', path: dtbPath, size: 1, sha256: dtbSha256 }],
      },
      rtl8189fsEvidence: JSON.parse(rtlBody),
      rtl8189fsEvidenceSha256: rtlSha256,
    },
  };
}

test('hardware recipe names all six target capabilities and required kernel symbols', () => {
  assert.equal(validateHardwareCapabilityRecipe(recipe), recipe);
  assert.deepEqual(Object.keys(recipe.capabilities).sort(), [
    'emmc', 'ethernet', 'hdmi', 'infrared', 'usb', 'wifi',
  ]);
  assert.deepEqual(
    Object.assign({}, ...Object.values(recipe.capabilities).map((entry) => entry.kernelConfig)),
    {
      CONFIG_DRM_DW_HDMI: 'y',
      CONFIG_DRM_MESON: 'y',
      CONFIG_DRM_MESON_DW_HDMI: 'y',
      CONFIG_DWMAC_MESON: 'y',
      CONFIG_IR_MESON: 'm',
      CONFIG_MESON_GXL_PHY: 'y',
      CONFIG_MMC_MESON_GX: 'y',
      CONFIG_PHY_MESON_GXL_USB2: 'y',
      CONFIG_STMMAC_ETH: 'y',
    },
  );
});

test('kernel config parser keeps built-in and module values', () => {
  const parsed = parseKernelConfig('CONFIG_ALPHA=y\nCONFIG_BETA=m\n# CONFIG_GAMMA is not set\n');
  assert.equal(parsed.get('CONFIG_ALPHA'), 'y');
  assert.equal(parsed.get('CONFIG_BETA'), 'm');
  assert.equal(parsed.get('CONFIG_GAMMA'), 'n');
});

test('capability evaluator accepts every required kernel and active DTB value', () => {
  const result = evaluatedCapabilities();
  assert.deepEqual(Object.fromEntries(Object.entries(result).map(([name, value]) => [name, value.passed])), {
    emmc: true,
    ethernet: true,
    hdmi: true,
    infrared: true,
    usb: true,
    wifi: true,
  });
});

test('capability evaluator rejects a missing installed-kernel symbol', () => {
  assert.throws(
    () => evaluateHardwareCapabilities(recipe, kernelConfigSource({ CONFIG_MMC_MESON_GX: 'n' }), observedValue),
    /CONFIG_MMC_MESON_GX.*expected y.*got n/i,
  );
});

test('capability evaluator rejects a disabled active eMMC node', () => {
  assert.throws(
    () => evaluateHardwareCapabilities(recipe, kernelConfigSource(), (check) => (
      check.node.endsWith('/mmc@74000') && check.property === 'status'
        ? 'disabled'
        : observedValue(check)
    )),
    /emmc.*status.*expected okay.*got disabled/i,
  );
});

test('hardware evidence binds recipe, kernel config, DTB, and RTL driver digests', () => {
  const fixture = evidenceFixture();
  assert.equal(validateHardwareCapabilityEvidence(fixture.value, fixture.context), fixture.value);

  const badFilesystem = structuredClone(fixture.context);
  badFilesystem.filesystemManifest = `${'0'.repeat(64)}  ./${fixture.value.kernel.config.path}\n`;
  assert.throws(
    () => validateHardwareCapabilityEvidence(fixture.value, badFilesystem),
    /kernel config.*filesystem manifest/i,
  );

  const badComponents = structuredClone(fixture.context);
  badComponents.bootComponents.components[0].sha256 = '0'.repeat(64);
  assert.throws(
    () => validateHardwareCapabilityEvidence(fixture.value, badComponents),
    /device tree.*boot components/i,
  );
});

test('recipe marker enables the gate without invalidating historical schema 8 manifests', () => {
  assert.equal(requiresHardwareCapabilityValidation(evidenceFixture().context.manifest), true);
  assert.equal(requiresHardwareCapabilityValidation({ recipe: { files: {} } }), false);
});

test('marked schema 5 manifests require the hardware capability report check and digest', () => {
  const manifest = markedManifest();
  const report = markedReport(manifest);
  delete report.checks.hardwareCapabilities;
  assert.throws(() => validatePublishedState(manifest, report), /hardwareCapabilities/i);
  report.checks.hardwareCapabilities = true;
  assert.equal(validatePublishedState(manifest, report), manifest);
});
