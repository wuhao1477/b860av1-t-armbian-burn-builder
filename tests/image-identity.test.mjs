import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  IMAGE_IDENTITY_PATH,
  buildImageIdentity,
  requiresImageIdentity,
  validateImageIdentity,
} from '../src/image-identity.mjs';

const execFileAsync = promisify(execFile);
const writer = path.resolve('scripts/write-image-identity.mjs');

function validIdentity(overrides = {}) {
  return buildImageIdentity({
    manifestFingerprint: 'a'.repeat(64),
    boardProfile: 'b860av1-t',
    kernelVersion: '5.10.260',
    kernelRelease: '5.10.260-ophub',
    ...overrides,
  });
}

function manifest(identity) {
  return {
    schemaVersion: 5,
    fingerprint: identity.manifestFingerprint,
    board: { profile: identity.boardProfile },
    sources: { kernel: { version: identity.kernelVersion } },
  };
}

test('builds and validates the immutable B860 image identity', () => {
  const identity = validIdentity();

  assert.deepEqual(Object.keys(identity).sort(), [
    'boardProfile',
    'identityPath',
    'kernelRelease',
    'kernelVersion',
    'manifestFingerprint',
    'schemaVersion',
  ]);
  assert.equal(identity.identityPath, `/${IMAGE_IDENTITY_PATH}`);
  assert.equal(validateImageIdentity(identity, identity), identity);
});

test('rejects an identity bound to another manifest or kernel', () => {
  const identity = validIdentity();

  assert.throws(
    () => validateImageIdentity(identity, { ...identity, manifestFingerprint: 'b'.repeat(64) }),
    /manifest fingerprint/i,
  );
  assert.throws(
    () => validateImageIdentity(identity, { ...identity, kernelRelease: '5.10.259-ophub' }),
    /kernel release/i,
  );
});

test('rejects unsafe paths, extra fields, and non-B860 profiles', () => {
  const identity = validIdentity();

  assert.throws(
    () => validateImageIdentity({ ...identity, identityPath: '/tmp/identity.json' }, identity),
    /identity path/i,
  );
  assert.throws(
    () => validateImageIdentity({ ...identity, unexpected: true }, identity),
    /unexpected keys/i,
  );
  assert.throws(
    () => buildImageIdentity({ ...identity, boardProfile: 'other-board' }),
    /board profile/i,
  );
});

test('requires the identity recipe marker without invalidating old manifests', () => {
  assert.equal(requiresImageIdentity({ recipe: { files: { [
    'scripts/write-image-identity.mjs'
  ]: 'a'.repeat(64) } } }), true);
  assert.equal(requiresImageIdentity({ recipe: { files: {} } }), false);
});

test('writer creates only the fixed identity path with canonical JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'b860-image-identity-'));
  try {
    const identity = validIdentity();
    const manifestPath = path.join(directory, 'resolved-sources.json');
    const root = path.join(directory, 'root');
    await writeFile(manifestPath, `${JSON.stringify(manifest(identity))}\n`);
    await fs.promises.mkdir(root, { recursive: true });

    await execFileAsync(process.execPath, [writer, root, manifestPath, identity.kernelRelease]);

    const target = path.join(root, IMAGE_IDENTITY_PATH);
    const body = await readFile(target, 'utf8');
    assert.deepEqual(JSON.parse(body), identity);
    assert.equal(body.endsWith('\n'), true);
    assert.equal((await stat(target)).mode & 0o777, 0o644);
    assert.equal(
      createHash('sha256').update(body).digest('hex').length,
      64,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
