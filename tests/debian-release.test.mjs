import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { canonicalStringify } from '../src/canonical-json.mjs';
import {
  parseDebianInRelease,
  requireGpgvValidSignature,
  validateDebianStable,
} from '../src/debian-release.mjs';

const execFile = promisify(execFileCallback);
const sourceUrl = 'https://deb.debian.org/debian/dists/stable/InRelease';
const validInRelease = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

Origin: Debian
Label: Debian
Suite: stable
Version: 13.0
Codename: trixie
Date: Sat, 09 Aug 2025 12:00:00 UTC
Architectures: all amd64 arm64
Components: main contrib non-free non-free-firmware
Description: Debian 13.0 Released 09 August 2025
-----BEGIN PGP SIGNATURE-----

placeholder-signature
-----END PGP SIGNATURE-----
`;

test('parses the signed Debian stable headers into normalized metadata', () => {
  const stable = parseDebianInRelease(validInRelease, sourceUrl);

  assert.deepEqual(stable, {
    codename: 'trixie',
    date: '2025-08-09T12:00:00.000Z',
    digest: createHash('sha256').update(validInRelease).digest('hex'),
    majorVersion: '13',
    sourceUrl,
    suite: 'stable',
    version: '13.0',
  });
});

test('rejects altered or malformed Debian release headers', () => {
  assert.throws(
    () => parseDebianInRelease(validInRelease.replace('Origin: Debian', 'Origin: Ubuntu'), sourceUrl),
    /origin/i,
  );
  assert.throws(
    () => parseDebianInRelease(validInRelease.replace('Codename: trixie', 'Codename: Trixie'), sourceUrl),
    /codename/i,
  );
  assert.throws(
    () => parseDebianInRelease(validInRelease.replace('Date: Sat, 09 Aug 2025 12:00:00 UTC', 'Date: invalid'), sourceUrl),
    /date/i,
  );
  assert.throws(
    () => parseDebianInRelease(validInRelease.replace('Label: Debian', 'Label: Debian Ports'), sourceUrl),
    /label/i,
  );
  assert.throws(
    () => parseDebianInRelease(validInRelease.replace('all amd64 arm64', 'all amd64'), sourceUrl),
    /arm64/i,
  );
  assert.throws(
    () => parseDebianInRelease(validInRelease.replace('main contrib', 'contrib'), sourceUrl),
    /main/i,
  );
});

test('requires an HTTPS source URL and validates only normalized stable records', () => {
  const stable = parseDebianInRelease(validInRelease, sourceUrl);

  assert.equal(validateDebianStable(stable), stable);
  assert.throws(() => parseDebianInRelease(validInRelease, 'http://deb.debian.org/stable/InRelease'), /https/i);
  assert.throws(
    () => parseDebianInRelease(validInRelease, 'https://mirror.example/debian/dists/stable/InRelease'),
    /official/i,
  );
  assert.throws(
    () => validateDebianStable({ ...stable, digest: 'A'.repeat(64) }),
    /digest/i,
  );
  assert.throws(
    () => validateDebianStable({ ...stable, codename: 'trixie!', }),
    /codename/i,
  );
});

test('accepts a trusted full-fingerprint VALIDSIG alongside an unknown parallel signature', () => {
  const signingFingerprint = '0123456789ABCDEF0123456789ABCDEF01234567';
  const primaryFingerprint = '89ABCDEF0123456789ABCDEF0123456789ABCDEF';
  const status = [
    '[GNUPG:] ERRSIG DEADBEEFDEADBEEF 1 10 01 1784500000 9 -',
    '[GNUPG:] NO_PUBKEY DEADBEEFDEADBEEF',
    `[GNUPG:] VALIDSIG ${signingFingerprint} 2026-07-20 1784500000 0 4 0 1 10 01 ${primaryFingerprint}`,
  ].join('\n');

  assert.deepEqual(requireGpgvValidSignature(status), [{
    primaryFingerprint,
    signingFingerprint,
  }]);
});

test('rejects gpgv status without a trusted full-fingerprint VALIDSIG', () => {
  assert.throws(
    () => requireGpgvValidSignature('[GNUPG:] NO_PUBKEY DEADBEEFDEADBEEF'),
    /valid signature/i,
  );
  assert.throws(
    () => requireGpgvValidSignature('[GNUPG:] VALIDSIG DEADBEEF 2026-07-20 1784500000 0 4 0 1 10 01 CAFEBABE'),
    /valid signature/i,
  );
});

test('CLI writes canonical Debian stable JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b860-debian-release-'));
  const inputPath = join(directory, 'InRelease');
  const outputPath = join(directory, 'debian-stable.json');
  await writeFile(inputPath, validInRelease);

  try {
    await execFile(process.execPath, [
      'scripts/resolve-debian-stable.mjs',
      inputPath,
      outputPath,
      sourceUrl,
    ], { cwd: new URL('..', import.meta.url) });

    const output = await readFile(outputPath, 'utf8');
    assert.equal(output, `${canonicalStringify(parseDebianInRelease(validInRelease, sourceUrl))}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
