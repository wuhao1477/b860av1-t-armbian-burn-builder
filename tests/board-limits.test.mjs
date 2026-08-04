import assert from 'node:assert/strict';
import test from 'node:test';

import { imageSizeLimit } from '../src/board-limits.mjs';

test('image size limit uses decimal 8GB capacity with a safety margin', () => {
  assert.equal(imageSizeLimit({
    storageCapacityBytes: 8_000_000_000,
    storageSafetyMarginBytes: 134_217_728,
  }), 7_865_782_272);
});

test('image size limit rejects a capacity larger than the board contract', () => {
  assert.throws(
    () => imageSizeLimit({ storageCapacityBytes: 8_589_934_592, storageSafetyMarginBytes: 0 }),
    /decimal 8GB/i,
  );
});
