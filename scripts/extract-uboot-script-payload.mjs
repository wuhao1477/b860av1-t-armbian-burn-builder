#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractUbootScriptBody,
  validateUbootScriptImage,
} from '../src/uboot-script-payload.mjs';

function usage() {
  console.error('usage: extract-uboot-script-payload.mjs legacy-image dumpimage-payload output');
  process.exit(2);
}

const [imagePath, payloadPath, output] = process.argv.slice(2);
const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  if (!imagePath || !payloadPath || !output) usage();
  const image = fs.readFileSync(imagePath);
  const payload = fs.readFileSync(payloadPath);
  validateUbootScriptImage(image, payload);
  const body = extractUbootScriptBody(payload);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, body);
}
