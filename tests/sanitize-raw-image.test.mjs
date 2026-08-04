import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SECTOR_SIZE = 512;

function writePartition(mbr, index, type, start, sectors) {
  const offset = 446 + (index * 16);
  mbr[offset + 4] = type;
  mbr.writeUInt32LE(start, offset + 8);
  mbr.writeUInt32LE(sectors, offset + 12);
}

function createImage() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-sanitize-'));
  const image = path.join(directory, 'candidate.img');
  const contents = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  const mbr = Buffer.alloc(SECTOR_SIZE, 0);
  mbr.fill(0xa5, 0, 440);
  mbr.writeUInt32LE(0x12345678, 440);
  mbr.writeUInt16LE(0xbeef, 444);
  writePartition(mbr, 0, 0x0c, 2048, 1024);
  writePartition(mbr, 1, 0x83, 3072, 4096);
  mbr[510] = 0x55;
  mbr[511] = 0xaa;
  mbr.copy(contents, 0);
  fs.writeFileSync(image, contents);
  return { directory, image, originalMbr: mbr };
}

test('sanitizer removes bootstrap payloads without changing the partition table', async (t) => {
  const fixture = createImage();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { sanitizeRawImage } = await import('../scripts/sanitize-raw-image.mjs');

  const result = sanitizeRawImage(fixture.image, 1);
  const sanitized = fs.readFileSync(fixture.image);

  assert.deepEqual(result, { firstPartitionStart: 2048, zeroedBytes: 1048506 });
  assert.ok(sanitized.subarray(0, 440).every((byte) => byte === 0));
  assert.deepEqual(sanitized.subarray(440, 444), fixture.originalMbr.subarray(440, 444));
  assert.ok(sanitized.subarray(444, 446).every((byte) => byte === 0));
  assert.deepEqual(sanitized.subarray(446, 512), fixture.originalMbr.subarray(446, 512));
  assert.ok(sanitized.subarray(512, 2048 * SECTOR_SIZE).every((byte) => byte === 0));
  assert.ok(sanitized.subarray(2048 * SECTOR_SIZE, (2048 * SECTOR_SIZE) + 512).every((byte) => byte === 0x5a));
});

test('sanitizer rejects a partition start that differs from the board manifest', async (t) => {
  const fixture = createImage();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const { sanitizeRawImage } = await import('../scripts/sanitize-raw-image.mjs');

  assert.throws(
    () => sanitizeRawImage(fixture.image, 2),
    /first partition starts at sector 2048, expected 4096/,
  );
});
