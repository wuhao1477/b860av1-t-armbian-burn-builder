#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expectedBuildInputs } from '../src/build-inputs.mjs';
import { validateManifest } from '../src/upstream.mjs';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) {
  process.stderr.write('usage: write-build-input-heads.mjs resolved-sources.json build-input-heads.json\n');
  process.exit(2);
}

const manifest = validateManifest(JSON.parse(readFileSync(resolve(manifestPath), 'utf8')));
writeFileSync(resolve(outputPath), `${JSON.stringify(expectedBuildInputs(manifest), null, 2)}\n`);
