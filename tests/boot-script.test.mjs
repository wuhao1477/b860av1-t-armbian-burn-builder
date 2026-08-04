import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  validateAmlAutoscript,
  validateS905Autoscript,
} from '../scripts/validate-boot-script.mjs';

const source = fs.readFileSync(new URL('../config/s905-autoscript.cmd', import.meta.url), 'utf8');

test('repository s905 autoscript keeps only Armbian boot paths', () => {
  assert.equal(validateS905Autoscript(source), true);
});

test('s905 autoscript rejects an Android fallback', () => {
  assert.throws(
    () => validateS905Autoscript(`${source}\nfatload mmc 0 \${loadaddr} boot_android\n`),
    /Android fallback/,
  );
});

test('s905 autoscript rejects a missing direct kernel path', () => {
  assert.throws(
    () => validateS905Autoscript(source.replace(/booti/g, 'bootm')),
    /missing an Armbian boot path/,
  );
});

test('s905 autoscript rejects a missing U-Boot overload jump', () => {
  assert.throws(
    () => validateS905Autoscript(source.replace(/go\s+0x1000000/g, 'echo skipped')),
    /missing an Armbian boot path/,
  );
});

test('aml autoscript installs only the Armbian s905 chain', () => {
  const installer = "setenv bootcmd 'run start_autoscript'; if fatload mmc 0 1020000 s905_autoscript; then autoscr 1020000; fi;";
  assert.equal(validateAmlAutoscript(installer), true);
  assert.throws(() => validateAmlAutoscript(`${installer} boot_android`), /Android fallback/);
  assert.throws(
    () => validateAmlAutoscript(`${installer} run storeboot`),
    /non-Armbian fallback/,
  );
});
