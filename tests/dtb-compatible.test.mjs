import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCompatibles } from '../scripts/validate-dtb-compatible.mjs';

test('DTB validator requires the exact P212 compatible entry', () => {
  assert.equal(validateCompatibles('amlogic,p212 amlogic,s905x amlogic,meson-gxl', 'amlogic,p212'), true);
  assert.throws(
    () => validateCompatibles('amlogic,s905x amlogic,meson-gxl', 'amlogic,p212'),
    /compatible/i,
  );
});
