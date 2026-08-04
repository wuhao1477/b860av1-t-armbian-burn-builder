import assert from 'node:assert/strict';
import test from 'node:test';

import { installBoardProfile } from '../scripts/install-board-profile.mjs';

const header = '# model database\n135:Q96-mini:s905lb:meson-gxl-s905x-p212.dtb:u-boot-s905x-s912.bin:NA:NA:1G/8G:stable/all:amlogic:meson-gxl:uEnv.txt:upstream:s905lb-q96-mini:no\n';
const entry = '900:ZXV10-B860AV1.1-T:s905l:meson-gxl-s905x-p212.dtb:u-boot-s905x-s912.bin:NA:NA:1+8G,100Mb-Nic:stable/all:amlogic:meson-gxl:uEnv.txt:wuhao1477:b860av1-t:no';

test('board profile installer appends the exact B860 entry once', () => {
  const result = installBoardProfile(header, entry);

  assert.equal(result, `${header}${entry}\n`);
  assert.throws(() => installBoardProfile(result, entry), /duplicate board profile/i);
});

test('board profile installer rejects unsafe or malformed entries', () => {
  assert.throws(() => installBoardProfile(header, entry.replace(':b860av1-t:', ':../bad:')), /invalid board profile/i);
  assert.throws(() => installBoardProfile(header, `${entry}:extra`), /15 columns/i);
});
