import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('..', import.meta.url));
const verifier = join(root, 'scripts/verify-debian-stable.sh');
const inRelease = `-----BEGIN PGP SIGNED MESSAGE-----
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
const gpgvStatus = [
  '[GNUPG:] ERRSIG DEADBEEFDEADBEEF 1 10 01 1784500000 9 -',
  '[GNUPG:] NO_PUBKEY DEADBEEFDEADBEEF',
  '[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-07-20 1784500000 0 4 0 1 10 01 89ABCDEF0123456789ABCDEF0123456789ABCDEF',
].join('\n');

const fakeCurl = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'CALL\\n' >> "$CURL_LOG"
printf '%s\\n' "$@" >> "$CURL_LOG"
output=''
while (($#)); do
  if [[ "$1" == '--output' ]]; then output=$2; shift 2; else shift; fi
done
[[ -n "$output" ]]
cp "$FIXTURE_PATH" "$output"
`;

const fakeGpgv = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'CALL\\n' >> "$GPGV_LOG"
printf '%s\\n' "$@" >> "$GPGV_LOG"
status_fd=''
input=''
for arg in "$@"; do
  [[ "$arg" == --status-fd=* ]] && status_fd=\${arg#--status-fd=}
  input=$arg
done
[[ "$status_fd" == 3 && -s "$input" ]]
if [[ "\${GPGV_STATUS_DESTINATION:-fd3}" == stdout ]]; then
  cat "$STATUS_PATH"
else
  cat "$STATUS_PATH" >&3
fi
exit 2
`;

const fakeNode = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'CALL\\n' >> "$NODE_LOG"
printf '%s\\n' "$@" >> "$NODE_LOG"
exec "$REAL_NODE" "$@"
`;

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function setupFixtures(directory) {
  const paths = Object.fromEntries([
    'bin', 'curlLog', 'decoy', 'fixture', 'gpgvLog', 'nodeLog', 'output', 'status', 'work',
  ].map((name) => [name, join(directory, name)]));
  await mkdir(paths.bin);
  await mkdir(paths.work);
  await writeFile(paths.fixture, inRelease);
  await writeFile(paths.decoy, inRelease.replace('Version: 13.0', 'Version: 99.0'));
  await writeFile(paths.status, `${gpgvStatus}\n`);
  await writeExecutable(join(paths.bin, 'curl'), fakeCurl);
  await writeExecutable(join(paths.bin, 'gpgv'), fakeGpgv);
  await writeExecutable(join(paths.bin, 'node'), fakeNode);
  return paths;
}

function argumentCalls(text) {
  return text.split('CALL\n').slice(1).map((call) => call.trimEnd().split('\n'));
}

function fixtureEnvironment(paths, overrides = {}) {
  return {
    ...process.env,
    PATH: `${paths.bin}:${process.env.PATH}`,
    CURL_LOG: paths.curlLog,
    FIXTURE_PATH: paths.fixture,
    GPGV_LOG: paths.gpgvLog,
    NODE_LOG: paths.nodeLog,
    REAL_NODE: process.execPath,
    STATUS_PATH: paths.status,
    ...overrides,
  };
}

test('offline detect verifier passes one downloaded file through curl, gpgv fd 3, and normalizer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b860-debian-detect-'));
  const paths = await setupFixtures(directory);

  try {
    await execFile(verifier, [paths.output, paths.work], {
      cwd: root,
      env: fixtureEnvironment(paths),
    });
    const normalized = JSON.parse(await readFile(paths.output, 'utf8'));
    const curlCalls = argumentCalls(await readFile(paths.curlLog, 'utf8'));
    const gpgvCalls = argumentCalls(await readFile(paths.gpgvLog, 'utf8'));
    const nodeCalls = argumentCalls(await readFile(paths.nodeLog, 'utf8'));
    const downloaded = join(paths.work, 'debian-stable.InRelease');
    const signatureGate = nodeCalls.find((call) => call.includes('--input-type=module'));
    const normalizer = nodeCalls.find((call) => call[0]?.endsWith('scripts/resolve-debian-stable.mjs'));

    assert.equal(curlCalls[0][curlCalls[0].indexOf('--output') + 1], downloaded);
    assert.equal(gpgvCalls[0].at(-1), downloaded);
    assert.ok(gpgvCalls[0].includes('--status-fd=3'));
    assert.equal(
      gpgvCalls[0][gpgvCalls[0].indexOf('--keyring') + 1],
      '/usr/share/keyrings/debian-archive-keyring.gpg',
    );
    assert.equal(signatureGate?.[2], join(paths.work, 'gpgv-status'));
    assert.deepEqual(normalizer?.slice(1), [
      downloaded, paths.output, 'https://deb.debian.org/debian/dists/stable/InRelease',
    ]);
    assert.equal(normalized.version, '13.0');
    assert.equal(normalized.digest, createHash('sha256').update(inRelease).digest('hex'));
    assert.notEqual(normalized.digest, createHash('sha256').update(await readFile(paths.decoy)).digest('hex'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('offline detect verifier rejects a valid signature delivered outside status fd 3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b860-debian-fd-'));
  const paths = await setupFixtures(directory);
  try {
    await assert.rejects(
      execFile(verifier, [paths.output, paths.work], {
        cwd: root,
        env: fixtureEnvironment(paths, { GPGV_STATUS_DESTINATION: 'stdout' }),
      }),
      (error) => {
        assert.match(error.stderr, /no trusted valid signature/i);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
