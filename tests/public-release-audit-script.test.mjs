import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('..', import.meta.url));
const audit = join(root, 'scripts/audit-public-releases.sh');

const fakeGh = `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
[[ "\${GH_MODE:-empty}" != fail ]] || exit 1
[[ "$1 $2" == 'release list' ]] || exit 2
`;

const fakeSleep = `#!/usr/bin/env bash
exit 0
`;

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'b860-release-audit-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const gh = join(bin, 'gh');
  const sleep = join(bin, 'sleep');
  await writeFile(gh, fakeGh);
  await writeFile(sleep, fakeSleep);
  await chmod(gh, 0o755);
  await chmod(sleep, 0o755);
  return { bin, directory, log: join(directory, 'gh.log') };
}

function environment(paths, mode) {
  return {
    ...process.env,
    GH_LOG: paths.log,
    GH_MODE: mode,
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repository',
    PATH: `${paths.bin}:${process.env.PATH}`,
  };
}

test('public release audit accepts an empty new repository', async () => {
  const paths = await setup();
  try {
    const { stdout } = await execFile(audit, [], { cwd: root, env: environment(paths, 'empty') });
    assert.match(stdout, /no published Armbian prereleases/);
    assert.match(await readFile(paths.log, 'utf8'), /^release list /);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('public release audit fails closed after GitHub query retries are exhausted', async () => {
  const paths = await setup();
  try {
    await assert.rejects(
      execFile(audit, [], { cwd: root, env: environment(paths, 'fail') }),
      (error) => error.code === 1,
    );
    const calls = (await readFile(paths.log, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 5);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('public release audit downloads metadata only', async () => {
  const source = await readFile(audit, 'utf8');
  assert.match(source, /--pattern resolved-sources\.json --pattern validation-report\.json/);
  assert.doesNotMatch(source, /--pattern [^\n]*\.img\.gz/);
});
