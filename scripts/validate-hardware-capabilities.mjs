#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  HARDWARE_CAPABILITY_RECIPE_PATH,
  evaluateHardwareCapabilities,
  validateHardwareCapabilityEvidence,
} from '../src/hardware-capabilities.mjs';

const KERNEL_RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || Object.hasOwn(values, name.slice(2))) {
      throw new Error(`invalid argument: ${name ?? ''}`);
    }
    values[name.slice(2)] = value;
  }
  return values;
}

function requiredPath(values, name) {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing argument: --${name}`);
  return path.resolve(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fdtValue(dtb, check) {
  const formats = { 'hex-cell': 'x', string: 's', 'string-list': 's', u32: 'u' };
  if (check.type === 'present') {
    const properties = execFileSync('fdtget', ['-p', dtb, check.node], { encoding: 'utf8' })
      .trim().split(/\s+/).filter(Boolean);
    return properties.includes(check.property);
  }
  const output = execFileSync(
    'fdtget',
    ['-t', formats[check.type], dtb, check.node, check.property],
    { encoding: 'utf8' },
  ).trim();
  if (check.type === 'u32') {
    const value = Number(output);
    if (!Number.isSafeInteger(value)) throw new Error(`invalid u32 DTB value: ${output}`);
    return value;
  }
  if (check.type === 'string-list' || check.type === 'hex-cell') {
    return output.split(/\s+/).filter(Boolean);
  }
  return output;
}

function configPath(root, kernelRelease) {
  if (!KERNEL_RELEASE.test(kernelRelease)) throw new Error('kernel release is invalid');
  const relative = `usr/src/linux-headers-${kernelRelease}/include/config/auto.conf`;
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('kernel config path escapes rootfs');
  return { absolute, relative };
}

export function createHardwareCapabilityEvidence(values) {
  const root = requiredPath(values, 'root');
  const dtb = requiredPath(values, 'dtb');
  const manifestPath = requiredPath(values, 'manifest');
  const filesystemManifestPath = requiredPath(values, 'filesystem-manifest');
  const bootComponentsPath = requiredPath(values, 'boot-components');
  const rtlPath = requiredPath(values, 'rtl8189fs');
  const recipePath = requiredPath(values, 'recipe');
  const kernelRelease = values['kernel-release'];
  const dtbRelative = values['dtb-path'];
  const config = configPath(root, kernelRelease);
  const recipe = readJson(recipePath);
  const manifest = readJson(manifestPath);
  const bootComponents = readJson(bootComponentsPath);
  const rtl8189fsEvidence = readJson(rtlPath);
  const filesystemManifest = fs.readFileSync(filesystemManifestPath, 'utf8');
  const rtlSha256 = sha256File(rtlPath);
  const evidence = {
    schemaVersion: 1,
    status: 'passed',
    recipe: { path: HARDWARE_CAPABILITY_RECIPE_PATH, sha256: sha256File(recipePath) },
    kernel: {
      release: kernelRelease,
      config: { path: config.relative, sha256: sha256File(config.absolute) },
    },
    deviceTree: { path: dtbRelative, sha256: sha256File(dtb) },
    wifiDriver: { path: 'rtl8189fs-driver.json', sha256: rtlSha256 },
    capabilities: evaluateHardwareCapabilities(
      recipe,
      fs.readFileSync(config.absolute, 'utf8'),
      (check) => fdtValue(dtb, check),
    ),
  };
  validateHardwareCapabilityEvidence(evidence, {
    recipe,
    manifest,
    filesystemManifest,
    bootComponents,
    rtl8189fsEvidence,
    rtl8189fsEvidenceSha256: rtlSha256,
  });
  return evidence;
}

function main(argv) {
  const values = parseArgs(argv);
  const output = requiredPath(values, 'output');
  const evidence = createHardwareCapabilityEvidence(values);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
