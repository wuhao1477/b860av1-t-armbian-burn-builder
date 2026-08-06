import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BOOT_PARTITION_BYTES,
  FIT_OFFSET_BYTES,
  MBR_OFFSET_BYTES,
  buildBootBundle,
  buildBootScriptSource,
  buildRootMbr,
  inspectBootBundle,
} from '../src/direct-boot-bundle.mjs';

const ROOT_UUID = '50031852-ee90-4285-ada7-ab9dc14670c9';
const MIB = 1024 * 1024;

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-direct-boot-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function legacyScript(source) {
  const body = Buffer.from(source, 'ascii');
  const payload = Buffer.alloc(8 + body.length);
  payload.writeUInt32BE(body.length, 0);
  body.copy(payload, 8);
  const image = Buffer.alloc(64 + payload.length);
  image.writeUInt32BE(0x27051956, 0);
  image.writeUInt32BE(payload.length, 12);
  image[30] = 6;
  image[31] = 0;
  payload.copy(image, 64);
  return image;
}

function fakeFit(bytes = 4096) {
  const image = Buffer.alloc(bytes);
  image.writeUInt32BE(0xd00dfeed, 0);
  image.writeUInt32BE(bytes, 4);
  return image;
}

test('direct boot script contains only the stock-U-Boot Linux handoff', () => {
  const source = buildBootScriptSource({
    rootUuid: ROOT_UUID,
    fitBytes: 0x120000,
  });

  assert.match(source, /store read boot/);
  assert.match(source, /mmc dev 1/);
  assert.match(source, /mmc write/);
  assert.match(source, /bootm 0x08000000/);
  assert.doesNotMatch(source, /imgread|boot_android|run update|fatload/);
  assert.match(source, new RegExp(`root=UUID=${ROOT_UUID}`));
});

test('runtime MBR exposes the Amlogic data partition as an ext4 root partition', () => {
  const image = buildRootMbr(512 * MIB);
  assert.equal(image.length, 512);
  assert.equal(image.readUInt16LE(510), 0xaa55);
  assert.equal(image[450], 0x83);
  assert.equal(image.readUInt32LE(454), 2176 * 2048);
  assert.equal(image.readUInt32LE(458), 1024 * 1024);
});

test('boot bundle keeps script, runtime MBR, and FIT inside stock boot partition', (context) => {
  const directory = fixture(context);
  const script = path.join(directory, 'boot.scr');
  const mbr = path.join(directory, 'root.mbr');
  const fit = path.join(directory, 'boot.itb');
  const bundle = path.join(directory, 'boot.PARTITION');
  fs.writeFileSync(script, legacyScript(buildBootScriptSource({ rootUuid: ROOT_UUID, fitBytes: 0x120000 })));
  fs.writeFileSync(mbr, buildRootMbr(512 * MIB));
  fs.writeFileSync(fit, fakeFit(0x120000));

  buildBootBundle({ scriptPath: script, mbrPath: mbr, fitPath: fit, outputPath: bundle });
  const result = inspectBootBundle(bundle, { rootUuid: ROOT_UUID, rootfsBytes: 512 * MIB });
  assert.equal(result.size <= BOOT_PARTITION_BYTES, true);
  assert.equal(result.mbrOffset, MBR_OFFSET_BYTES);
  assert.equal(result.fitOffset, FIT_OFFSET_BYTES);
  assert.equal(result.fitBytes, 0x120000);
});
