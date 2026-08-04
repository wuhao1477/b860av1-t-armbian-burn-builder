#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sourceTreeFingerprint } from '../src/source-tree.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('usage: hash-source-tree.mjs source-directory\n');
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${sourceTreeFingerprint(root)}\n`);
    } catch (error) {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    }
  }
}
