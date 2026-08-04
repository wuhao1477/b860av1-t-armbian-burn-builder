import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalStringify } from '../src/canonical-json.mjs';
import * as resolver from '../scripts/resolve-sources.mjs';
import { main as resolveSources } from '../scripts/resolve-sources.mjs';
import {
  buildManifest,
  selectLatestAsset,
  selectLatestRelease,
  selectLatestReleaseAsset,
  validateManifest,
} from '../src/upstream.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;

test('resolver retries a transient GitHub API response', async () => {
  assert.equal(typeof resolver.fetchJson, 'function');
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(503, { 'retry-after': '0' });
      response.end('temporarily unavailable');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await resolver.fetchJson(`http://127.0.0.1:${server.address().port}/retry`);
    assert.deepEqual(result, { ok: true });
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('upstream selects the newest matching published release', () => {
  const releases = [
    {
      tag_name: 'Armbian_trixie_arm64_server_2026.05',
      published_at: '2026-05-01T00:00:00Z',
    },
    {
      tag_name: 'Armbian_bookworm_arm64_server_2026.07',
      published_at: '2026-07-01T00:00:00Z',
    },
    {
      tag_name: 'Armbian_trixie_arm64_server_2026.06',
      published_at: '2026-06-01T00:00:00Z',
    },
  ];

  const selected = selectLatestRelease(
    releases,
    /^Armbian_trixie_arm64_server_/,
  );

  assert.equal(selected.tag_name, 'Armbian_trixie_arm64_server_2026.06');
});

test('upstream selects the highest matching base asset across releases', () => {
  const releases = [
    {
      tag_name: 'Armbian_trixie_arm64_server_2026.07',
      published_at: '2026-07-01T00:00:00Z',
      assets: [asset('Armbian_26.07.0-trunk_trixie_arm64_6.12.1.img.gz', 'a')],
    },
    {
      tag_name: 'Armbian_trixie_arm64_server_2026.06',
      published_at: '2026-06-01T00:00:00Z',
      assets: [asset('Armbian_26.08.0-trunk_trixie_arm64_6.12.2.img.gz', 'b')],
    },
  ];

  const selected = selectLatestReleaseAsset(
    releases,
    /^Armbian_trixie_arm64_server_/,
    /^Armbian_\d+\.\d+\.\d+-trunk_trixie_arm64_\d+\.\d+\.\d+\.img\.gz$/,
    (name) => name.match(/^Armbian_(\d+\.\d+\.\d+)-trunk_trixie_arm64_(\d+\.\d+\.\d+)\.img\.gz$/)
      .slice(1).flatMap((part) => part.split('.').map(Number)),
  );

  assert.equal(selected.release.tag_name, 'Armbian_trixie_arm64_server_2026.06');
  assert.equal(selected.asset.name, 'Armbian_26.08.0-trunk_trixie_arm64_6.12.2.img.gz');
});

test('upstream selects the highest numeric 5.10 kernel patch', () => {
  const assets = [
    asset('5.10.99.tar.gz', 'a'),
    asset('5.10.260.tar.gz', 'b'),
    asset('5.10.101.tar.gz', 'c'),
    asset('deb-5.10.999.tar.gz', 'd'),
  ];

  const selected = selectLatestAsset(
    assets,
    /^5\.10\.\d+\.tar\.gz$/,
    (name) => name.match(/^5\.10\.(\d+)\.tar\.gz$/)?.[1],
  );

  assert.deepEqual(selected, {
    name: '5.10.260.tar.gz',
    url: 'https://example.test/5.10.260.tar.gz',
    digest: 'b'.repeat(64),
    size: 1024,
  });
});

test('upstream rejects duplicate assets at the selected version', () => {
  const assets = [
    asset('kernel-5.10.260-a.tar.gz', 'a'),
    asset('kernel-5.10.260-b.tar.gz', 'b'),
  ];

  assert.throws(
    () => selectLatestAsset(
      assets,
      /^kernel-5\.10\.260-.*\.tar\.gz$/,
      () => '5.10.260',
    ),
    /multiple assets/i,
  );
});

test('upstream normalizes the sha256 digest prefix', () => {
  const [selected] = [selectLatestAsset(
    [asset('base-rootfs.tar.gz', 'a', 'SHA256:')],
    /^base-rootfs\.tar\.gz$/,
  )];

  assert.equal(selected.digest, 'a'.repeat(64));
});

test('fingerprint is stable across object key insertion order', () => {
  const first = buildManifest({
    target: { distribution: 'trixie', board: 's905lb-r3300l' },
    sources: {
      kernel: { version: '5.10.260', digest: 'b'.repeat(64) },
      base: { digest: 'a'.repeat(64), name: 'base-rootfs.tar.gz' },
      builder: { commit: 'c'.repeat(40) },
    },
  });
  const second = buildManifest({
    sources: {
      builder: { commit: 'c'.repeat(40) },
      base: { name: 'base-rootfs.tar.gz', digest: 'a'.repeat(64) },
      kernel: { digest: 'b'.repeat(64), version: '5.10.260' },
    },
    target: { board: 's905lb-r3300l', distribution: 'trixie' },
  });

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.fingerprint, second.fingerprint);
  const { fingerprint, ...payload } = first;
  assert.equal(
    fingerprint,
    createHash('sha256').update(canonicalStringify(payload)).digest('hex'),
  );
  assert.equal(canonicalStringify(first), canonicalStringify(second));
});

test('resolved-source fixture has the current schema and canonical fingerprint', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'));
  const { fingerprint, ...payload } = fixture;

  assert.equal(fixture.board.profile, 'b860av1-t');
  assert.equal(buildManifest(payload).fingerprint, fingerprint);
  assert.equal(validateManifest(fixture), fixture);

  const tampered = structuredClone(fixture);
  tampered.sources.kernel.version = '5.10.999';
  assert.throws(() => validateManifest(tampered), /fingerprint/i);
});

test('manifest validator accepts schema 1 through 3 during release migration', async () => {
  const current = JSON.parse(await readFile(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'));
  const schema3 = structuredClone(current);
  schema3.schemaVersion = 3;
  delete schema3.sources.ubootSource;
  delete schema3.board.ubootOverloadBuild;
  Object.assign(schema3.board, {
    mainlineBootloader: 'r3300l-u-boot.bin.sd.bin',
    ubootOverload: 'u-boot-r3300l.bin',
    ubootOverloadSha256: 'a'.repeat(64),
    ubootOverloadSize: 633376,
    ubootOverloadProvenance: {
      originRepository: '7Ji/u-boot',
      originRelease: 'v2023.01-r3300l',
      originAsset: 'u-boot-r3300l.bin',
      originUploader: '7Ji',
      originUrl: 'https://example.invalid/u-boot-r3300l.bin',
      sourceCommit: 'b'.repeat(40),
      ophubGitBlob: 'c'.repeat(40),
      unpublishedDirtyDelta: true,
      reproducibleFromSource: false,
    },
  });
  schema3.sources.uboot = {
    repository: 'ophub/u-boot',
    ref: 'main',
    commit: 'd'.repeat(40),
    url: 'https://example.invalid/u-boot/commit',
  };
  schema3.sources.firmware = {
    repository: 'ophub/firmware',
    ref: 'main',
    commit: 'e'.repeat(40),
    url: 'https://example.invalid/firmware/commit',
  };
  delete schema3.fingerprint;
  const signedSchema3 = buildManifest(schema3);
  assert.equal(validateManifest(signedSchema3), signedSchema3);

  const schema2 = structuredClone(signedSchema3);
  schema2.schemaVersion = 2;
  delete schema2.sources.debian;
  delete schema2.fingerprint;
  const signedSchema2 = buildManifest(schema2);
  assert.equal(validateManifest(signedSchema2), signedSchema2);

  const schema1 = structuredClone(schema2);
  schema1.schemaVersion = 1;
  delete schema1.board.distributionVersion;
  delete schema1.board.ubootOverloadSha256;
  delete schema1.board.ubootOverloadSize;
  delete schema1.board.ubootOverloadProvenance;
  delete schema1.fingerprint;
  const signedSchema1 = buildManifest(schema1);
  assert.equal(validateManifest(signedSchema1), signedSchema1);
});

test('manifest schema 3 binds the derived board distribution to Debian stable', async () => {
  const current = JSON.parse(await readFile(new URL('./fixtures/valid-resolved-sources.json', import.meta.url), 'utf8'));
  const mismatched = structuredClone(current);
  mismatched.board.distribution = 'bookworm';
  delete mismatched.fingerprint;

  assert.throws(
    () => validateManifest(buildManifest(mismatched)),
    /distribution.*Debian stable metadata/i,
  );

  const missing = structuredClone(current);
  delete missing.sources.debian;
  delete missing.fingerprint;
  assert.throws(() => validateManifest(buildManifest(missing)), /Debian stable metadata/i);
});

test('resolver reads releases and release assets from every API page', async () => {
  const stableFixture = {
    codename: 'forky',
    date: '2027-08-15T12:00:00.000Z',
    digest: '9'.repeat(64),
    majorVersion: '14',
    sourceUrl: 'https://deb.debian.org/debian/dists/stable/InRelease',
    suite: 'stable',
    version: '14.0',
  };
  const baseAsset = asset('Armbian_27.09.0-trunk_forky_arm64_6.12.99.img.gz', 'e');
  const olderBaseAsset = asset('Armbian_27.08.0-trunk_forky_arm64_6.18.38.img.gz', 'c');
  const rootfsAsset = asset('Armbian_27.08.0-forky_arm64_6.18.38_rootfs.tar.gz', 'd');
  const kernelAsset = asset('5.10.260.tar.gz', 'f');
  const releasePageOne = Array.from({ length: 100 }, (_, index) => ({
    tag_name: `Armbian_bookworm_arm64_server_${index}`,
    published_at: '2026-07-02T00:00:00Z',
  }));
  const pageOne = Array.from({ length: 100 }, (_, index) => asset(`unrelated-${index}.tar.gz`, 'a'));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let body;
    if (url.pathname === '/repos/ophub/amlogic-s9xxx-armbian/releases') {
      body = url.searchParams.get('page') === '2' ? [{
        tag_name: 'Armbian_forky_arm64_server_2027.07',
        published_at: '2027-07-01T00:00:00Z',
        assets_url: `http://${request.headers.host}/base-assets`,
      }] : releasePageOne;
    } else if (url.pathname === '/base-assets') {
      body = url.searchParams.get('page') === '1' ? pageOne : [rootfsAsset, olderBaseAsset, baseAsset];
    } else if (url.pathname === '/repos/ophub/kernel/releases/tags/kernel_stable') {
      body = {
        tag_name: 'kernel_stable',
        assets_url: `http://${request.headers.host}/kernel-assets`,
      };
    } else if (url.pathname === '/kernel-assets') {
      body = [kernelAsset];
    } else if (url.pathname === '/repos/ophub/amlogic-s9xxx-armbian/commits/main') {
      body = { sha: '1'.repeat(40), html_url: 'https://example.test/commit' };
    } else if (url.pathname === '/repos/u-boot/u-boot/commits/v2020.07') {
      body = { sha: '4'.repeat(40), html_url: 'https://example.test/upstream-u-boot-commit' };
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'b860-resolver-'));
  const output = join(directory, 'resolved.json');
  const debianStable = join(directory, 'debian-stable.json');
  const originalApi = process.env.GITHUB_API_URL;
  const originalOutput = process.env.GITHUB_OUTPUT;
  const originalWrite = process.stdout.write;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.GITHUB_OUTPUT;
  process.stdout.write = () => true;
  try {
    await writeFile(debianStable, JSON.stringify(stableFixture));
    const result = await resolveSources(['--output', output, '--debian-stable', debianStable]);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.manifest.schemaVersion, 5);
    assert.equal(result.manifest.board.distribution, 'forky');
    assert.equal(result.manifest.board.distributionVersion, '14');
    assert.match(result.manifest.sources.base.name, /_forky_arm64_/);
    assert.deepEqual(result.manifest.sources.debian, stableFixture);
    assert.equal(result.manifest.sources.base.name, baseAsset.name);
    assert.equal(result.manifest.sources.base.armbianVersion, '27.09.0');
    assert.equal(result.manifest.sources.kernel.name, kernelAsset.name);
    assert.equal(result.manifest.sources.ubootSource.commit, '4'.repeat(40));
    assert.match(result.manifest.recipe.files['scripts/build-raw-image.sh'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['scripts/resolve-debian-stable.mjs'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['scripts/verify-debian-stable.sh'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['scripts/extract-uboot-script-payload.mjs'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['scripts/build-uboot-overload.sh'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['patches/u-boot/u-boot-s905x-s912.patch'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['src/uboot-build.mjs'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['scripts/validate-raw-image.sh'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['src/uboot-script-payload.mjs'], /^[0-9a-f]{64}$/);
    assert.match(result.manifest.recipe.files['.github/workflows/weekly-build.yml'], /^[0-9a-f]{64}$/);
    assert.equal(written.fingerprint, result.manifest.fingerprint);
  } finally {
    if (originalApi === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = originalApi;
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
    process.stdout.write = originalWrite;
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function asset(name, character, prefix = 'sha256:') {
  return {
    name,
    browser_download_url: `https://example.test/${name}`,
    digest: `${prefix}${character.repeat(64)}`,
    size: 1024,
  };
}
