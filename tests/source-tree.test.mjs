import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sourceTreeFingerprint } from '../src/source-tree.mjs';

test('source tree fingerprint binds paths, modes, links, and file bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'first\n');
  fs.symlinkSync('sub/file.txt', path.join(root, 'link'));

  const first = sourceTreeFingerprint(root);
  fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'second\n');
  const second = sourceTreeFingerprint(root);

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});
