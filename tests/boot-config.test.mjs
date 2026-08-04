import assert from 'node:assert/strict';
import test from 'node:test';

import { applyMemoryLimit } from '../src/boot-config.mjs';

test('boot config applies a single conservative memory limit', () => {
  const input = [
    'LINUX=/zImage',
    'APPEND=root=LABEL=ROOTFS mem=2048M console=ttyAML0',
    'comment mem=4096M',
    '',
  ].join('\n');

  assert.equal(
    applyMemoryLimit(input, 1024),
    [
      'LINUX=/zImage',
      'APPEND=root=LABEL=ROOTFS console=ttyAML0 mem=1024M',
      'comment mem=4096M',
      '',
    ].join('\n'),
  );
});

test('boot config rejects files without a boot argument line', () => {
  assert.throws(() => applyMemoryLimit('LINUX=/zImage\n', 1024), /boot argument/i);
});
