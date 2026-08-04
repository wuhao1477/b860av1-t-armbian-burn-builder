#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateCompatibles(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    throw new Error('DTB compatible input is invalid');
  }
  const compatibles = value.trim().split(/\s+/).filter(Boolean);
  if (!compatibles.includes(expected)) throw new Error(`DTB is missing compatible ${expected}`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateCompatibles(fs.readFileSync(0, 'utf8'), process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
