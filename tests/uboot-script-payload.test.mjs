import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../src/uboot-script-payload.mjs', import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadParser() {
  assert.equal(fs.existsSync(moduleUrl), true, 'missing U-Boot script payload parser');
  return import(moduleUrl);
}

function scriptPayload(source, padding = Buffer.alloc(0)) {
  const body = Buffer.from(source);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body, padding]);
}

function legacyScriptImage(payload, { type = 6, compression = 0 } = {}) {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x27051956, 0);
  header.writeUInt32BE(payload.length, 12);
  header[30] = type;
  header[31] = compression;
  return Buffer.concat([header, payload]);
}

test('extracts the script body after the U-Boot multi-image size table', async () => {
  const { extractUbootScriptBody } = await loadParser();
  const source = 'echo "boot armbian"\n'.repeat(20);

  assert.deepEqual(extractUbootScriptBody(scriptPayload(source)), Buffer.from(source));
});

test('rejects every byte after the declared script body', async () => {
  const { extractUbootScriptBody } = await loadParser();
  const source = 'booti\n';

  assert.throws(
    () => extractUbootScriptBody(scriptPayload(source, Buffer.from([0]))),
    /trailing data/,
  );
});

test('validates the legacy script header and dumpimage payload binding', async () => {
  const { validateUbootScriptImage } = await loadParser();
  assert.equal(typeof validateUbootScriptImage, 'function');
  const payload = scriptPayload('booti\n');
  const image = legacyScriptImage(payload);

  assert.doesNotThrow(() => validateUbootScriptImage(image, payload));
  const invalidMagic = Buffer.from(image);
  invalidMagic.writeUInt32BE(0, 0);
  assert.throws(() => validateUbootScriptImage(invalidMagic, payload), /magic/);
  assert.throws(
    () => validateUbootScriptImage(legacyScriptImage(payload, { type: 2 }), payload),
    /image type/,
  );
  assert.throws(
    () => validateUbootScriptImage(legacyScriptImage(payload, { compression: 1 }), payload),
    /compression/,
  );
  assert.throws(
    () => validateUbootScriptImage(Buffer.concat([image, Buffer.from([0])]), payload),
    /data size/,
  );
  assert.throws(
    () => validateUbootScriptImage(image, Buffer.from(payload).fill(0, 8, 9)),
    /dumpimage payload/,
  );
});

test('rejects malformed or truncated U-Boot script payloads', async () => {
  const { extractUbootScriptBody } = await loadParser();

  assert.throws(() => extractUbootScriptBody(Buffer.from('booti\n')), /size table/);

  const missingTerminator = scriptPayload('booti\n');
  missingTerminator.writeUInt32BE(1, 4);
  assert.throws(() => extractUbootScriptBody(missingTerminator), /terminator/);

  const truncated = scriptPayload('booti\n');
  truncated.writeUInt32BE(100, 0);
  assert.throws(() => extractUbootScriptBody(truncated), /declared script length/);
});

test('CLI writes the extracted script body', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uboot-script-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const image = path.join(directory, 's905_autoscript');
  const input = path.join(directory, 'payload');
  const output = path.join(directory, 'nested', 'script.cmd');
  const payload = scriptPayload('run start\n');
  fs.writeFileSync(image, legacyScriptImage(payload));
  fs.writeFileSync(input, payload);

  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(root, 'scripts/extract-uboot-script-payload.mjs'), image, input, output],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'run start\n');
});
