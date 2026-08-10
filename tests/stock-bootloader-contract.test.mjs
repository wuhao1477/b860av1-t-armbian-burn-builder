import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const CLI = fileURLToPath(new URL('scripts/burn-image.mjs', ROOT));
const INPUT = fileURLToPath(new URL('board-inputs/bootloader.PARTITION', ROOT));
const CONFIG = fileURLToPath(new URL('config/burn-inputs.json', ROOT));
const STOCK_SHA256 = '50b0fb65121e6a7e174f11f556e03d80532feccac747b4f4a646af5bde7f8ba8';

function inspect(input) {
  return spawnSync(process.execPath, [CLI, 'check-stock-bootloader', input, CONFIG], {
    encoding: 'utf8',
  });
}

test('accepts the byte-exact B860AV1.1-T stock bootloader', () => {
  const result = inspect(INPUT);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    source: 'stock-vendor-bl33',
    sha256: STOCK_SHA256,
    size: 786432,
  });
});

test('rejects a modified stock bootloader', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-stock-bl33-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modifiedPath = path.join(directory, 'bootloader.PARTITION');
  const modified = fs.readFileSync(INPUT);
  modified[modified.length - 1] ^= 0xff;
  fs.writeFileSync(modifiedPath, modified);

  const result = inspect(modifiedPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stock bootloader sha256 mismatch/i);
});
