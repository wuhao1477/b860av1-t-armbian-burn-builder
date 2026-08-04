import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { inspectTrackedFiles } from '../src/repository-policy.mjs';

test('repository contains source, documentation, and pinned board inputs only', () => {
  assert.deepEqual(inspectTrackedFiles(new URL('..', import.meta.url)), []);
});

test('evidence directory contains no generated report in the source branch', () => {
  const root = new URL('../evidence/', import.meta.url);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.gitkeep']);
});
