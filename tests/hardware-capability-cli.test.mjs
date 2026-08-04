import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HARDWARE_CAPABILITY_RECIPE_PATH,
  validateHardwareCapabilityEvidence,
} from '../src/hardware-capabilities.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const script = path.join(root, 'scripts/validate-hardware-capabilities.mjs');
const recipePath = path.join(root, HARDWARE_CAPABILITY_RECIPE_PATH);
const fixtureDts = path.join(root, 'tests/fixtures/source-built-b860av11t.dts');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function writeJson(pathname, value) {
  fs.writeFileSync(pathname, `${JSON.stringify(value)}\n`);
}

test('hardware capability CLI validates a compiled active DTB and installed kernel config', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-hardware-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rootfs = path.join(directory, 'rootfs');
  const kernelRelease = '5.10.260-ophub';
  const configRelative = `usr/src/linux-headers-${kernelRelease}/include/config/auto.conf`;
  const configPath = path.join(rootfs, configRelative);
  const dtbPath = path.join(directory, 'active.dtb');
  const dtbRelative = 'dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb';
  const outputPath = path.join(directory, 'hardware-capabilities.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const recipeBody = fs.readFileSync(recipePath);
  const recipe = JSON.parse(recipeBody);
  const requiredConfig = Object.assign(
    {},
    ...Object.values(recipe.capabilities).map((capability) => capability.kernelConfig),
  );
  const configBody = `${Object.entries(requiredConfig).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  fs.writeFileSync(configPath, configBody);
  execFileSync('dtc', ['-q', '-I', 'dts', '-O', 'dtb', '-o', dtbPath, fixtureDts]);

  const manifestPath = path.join(directory, 'resolved-sources.json');
  const filesystemManifestPath = path.join(directory, 'filesystem-manifest.sha256');
  const bootComponentsPath = path.join(directory, 'boot-components.json');
  const rtlPath = path.join(directory, 'rtl8189fs-driver.json');
  const configSha256 = sha256(configBody);
  const dtbSha256 = sha256(fs.readFileSync(dtbPath));
  const rtlBody = `${JSON.stringify({ kernelRelease })}\n`;
  const manifest = {
    recipe: { files: { [HARDWARE_CAPABILITY_RECIPE_PATH]: sha256(recipeBody) } },
    sources: { kernel: { version: '5.10.260' } },
  };
  const bootComponents = {
    schemaVersion: 2,
    components: [{ role: 'dtb', path: dtbRelative, size: 1, sha256: dtbSha256 }],
  };
  writeJson(manifestPath, manifest);
  fs.writeFileSync(filesystemManifestPath, `${configSha256}  ./${configRelative}\n`);
  writeJson(bootComponentsPath, bootComponents);
  fs.writeFileSync(rtlPath, rtlBody);

  execFileSync(process.execPath, [
    script,
    '--root', rootfs,
    '--dtb', dtbPath,
    '--dtb-path', dtbRelative,
    '--kernel-release', kernelRelease,
    '--manifest', manifestPath,
    '--filesystem-manifest', filesystemManifestPath,
    '--boot-components', bootComponentsPath,
    '--rtl8189fs', rtlPath,
    '--recipe', recipePath,
    '--output', outputPath,
  ]);

  const evidence = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.kernel.release, kernelRelease);
  assert.deepEqual(Object.values(evidence.capabilities).map((entry) => entry.passed), Array(6).fill(true));
  assert.equal(validateHardwareCapabilityEvidence(evidence, {
    recipe,
    manifest,
    filesystemManifest: fs.readFileSync(filesystemManifestPath, 'utf8'),
    bootComponents,
    rtl8189fsEvidence: JSON.parse(rtlBody),
    rtl8189fsEvidenceSha256: sha256(rtlBody),
  }), evidence);
});
