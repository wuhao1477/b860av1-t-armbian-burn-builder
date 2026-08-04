#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function requireText(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('boot script is empty');
  if (/android/i.test(value)) throw new Error('Android fallback found in decoded s905_autoscript');
}

export function validateS905Autoscript(source) {
  requireText(source);
  const required = [
    /fatload\s+mmc\s+0\s+\S+\s+u-boot\.ext/,
    /fatload\s+usb\s+0\s+\S+\s+u-boot\.ext/,
    /\bgo\s+(?:0x)?[0-9a-f]+\b/i,
    /uEnv\.txt/,
    /booti\s+/,
  ];
  if (required.some((pattern) => !pattern.test(source))) {
    throw new Error('decoded s905_autoscript is missing an Armbian boot path');
  }
  return true;
}

export function validateAmlAutoscript(source) {
  requireText(source);
  if (/\b(?:storeboot|start_emmc_autoscript)\b/.test(source)) {
    throw new Error('decoded aml_autoscript contains a non-Armbian fallback');
  }
  if (!/fatload\s+mmc\s+0\s+\S+\s+s905_autoscript/.test(source)
    || !/autoscr\s+/.test(source)
    || !/setenv\s+bootcmd\s+['"]run\s+start_autoscript['"]/.test(source)) {
    throw new Error('decoded aml_autoscript is missing the pure Armbian s905 chain');
  }
  return true;
}

export function validateBootScript(kind, source) {
  if (kind === 's905') return validateS905Autoscript(source);
  if (kind === 'aml') return validateAmlAutoscript(source);
  throw new Error(`unknown boot script kind: ${kind}`);
}

function main(argv) {
  const [kind, file] = argv;
  if (!kind || !file) throw new Error('usage: validate-boot-script.mjs <s905|aml> <decoded-script>');
  validateBootScript(kind, readFileSync(resolve(file), 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
