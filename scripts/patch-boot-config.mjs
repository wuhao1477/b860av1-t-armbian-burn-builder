#!/usr/bin/env node

import fs from 'node:fs';

import { applyMemoryLimit } from '../src/boot-config.mjs';

const [, , path, value] = process.argv;
if (!path || !value) {
  process.stderr.write('usage: patch-boot-config.mjs config-path memory-limit-mib\n');
  process.exit(2);
}
const memoryLimitMiB = Number(value);
const updated = applyMemoryLimit(fs.readFileSync(path, 'utf8'), memoryLimitMiB);
fs.writeFileSync(path, updated);
