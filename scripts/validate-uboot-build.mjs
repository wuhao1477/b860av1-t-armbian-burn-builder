#!/usr/bin/env node

import fs from 'node:fs';

import { validateUbootBuild } from '../src/uboot-build.mjs';
import { validateManifest } from '../src/upstream.mjs';

const [manifestPath, summaryPath] = process.argv.slice(2);
if (!manifestPath || !summaryPath) {
  process.stderr.write('usage: validate-uboot-build.mjs resolved-sources.json uboot-build.json\n');
  process.exit(2);
}

try {
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const summary = validateUbootBuild(JSON.parse(fs.readFileSync(summaryPath, 'utf8')), manifest);
  process.stdout.write(`${summary.artifact.name}\n${summary.artifact.sha256}\n${summary.artifact.size}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
