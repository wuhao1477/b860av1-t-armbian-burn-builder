#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalStringify } from '../src/canonical-json.mjs';
import { parseDebianInRelease } from '../src/debian-release.mjs';

export function main(argv = process.argv.slice(2)) {
  const [inputPath, outputPath, sourceUrl] = argv;
  if (!inputPath || !outputPath || !sourceUrl || argv.length !== 3) {
    throw new Error('usage: resolve-debian-stable.mjs <InRelease> <output.json> <source-url>');
  }
  const stable = parseDebianInRelease(readFileSync(resolve(inputPath)), sourceUrl);
  writeFileSync(resolve(outputPath), `${canonicalStringify(stable)}\n`, 'utf8');
  return stable;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
