import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildManifest, validateManifest } from '../src/upstream.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

test('B860 target uses a pinned source-built repair DTB', () => {
  const board = readJson('config/board.json');

  assert.equal(board.dtb, 'meson-gxl-s905x-p212-b860av11t.dtb');
  assert.equal(board.dtbBuild.repository, 'S-9527/meson-gxl-s905x-p212');
  assert.equal(board.dtbBuild.sourcePath, 'repair/meson-gxl-s905x-p212.dts');
  assert.equal(board.dtbBuild.commit, '624b3e57e27fd39476b3d6528e8a61867559d8c8');
  assert.equal(
    board.dtbBuild.rawSourceUrl,
    'https://raw.githubusercontent.com/S-9527/meson-gxl-s905x-p212/624b3e57e27fd39476b3d6528e8a61867559d8c8/repair/meson-gxl-s905x-p212.dts',
  );
  assert.equal(board.dtbBuild.sourceSha256, 'b52b6c6deea1d6b626d052042708f54eca65c9b7ffda56dfe8ca5fa0907cee7d');
  assert.equal(board.dtbBuild.license, 'MIT');
  assert.equal(board.dtbBuild.output, board.dtb);
  assert.equal(board.dtbBuild.sourceDateEpoch, 0);
  assert.equal(board.dtbBuild.reproducibleFromSource, true);
});

test('DTB helper validates pinned metadata and emits reproducible evidence', () => {
  const script = read('scripts/build-board-dtb.sh');

  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m);
  assert.match(script, /raw\.githubusercontent\.com/);
  assert.match(script, /sourceSha256|source_sha256/);
  assert.match(script, /sha256sum --check --status/);
  assert.match(script, /dtc -I dts -O dtb/);
  assert.match(script, /validate-dtb-compatible\.mjs[^\n]+amlogic,p212/);
  assert.match(script, /rtl8189ftv/);
  assert.match(script, /200000000|bebc200/);
  assert.match(script, /reset-gpios/);
  assert.match(script, /0x4c|4c/);
  assert.match(script, /4000000|67108864/);
  assert.match(script, /source-built-dtb\.json/);
  assert.match(script, /device-tree-source\.dts/);
  assert.match(script, /reproducibleFromSource[^\n]+true/);
});

test('raw builder compiles and injects the repair DTB before upstream rebuild', () => {
  const script = read('scripts/build-raw-image.sh');
  const build = script.indexOf('build-board-dtb.sh');
  const rebuild = script.indexOf('sudo ./rebuild');

  assert.ok(build >= 0, 'repair DTB build step is missing');
  assert.match(script, /source-built-dtb/);
  assert.match(script, /platform_bootfs\/dtb\/amlogic/);
  assert.ok(build < rebuild, 'repair DTB must be present before ophub rebuild');
});

test('raw validator independently rebuilds and compares the repair DTB', () => {
  const script = read('scripts/validate-raw-image.sh');

  assert.match(script, /build-board-dtb\.sh/);
  assert.match(script, /source-built-dtb/);
  assert.match(script, /cmp --[^\n]+expected[^\n]+dtb/);
  assert.match(script, /sourceBuiltDeviceTree/);
  assert.match(script, /dtb_file="\$boot_mount\/dtb\/amlogic\/\$dtb_name"/);
  assert.doesNotMatch(script, /dtb_file=\$\(find/);
});

test('boot component discovery accepts only the selected DTB at its active path', async () => {
  const { findBootDtb } = await import('../scripts/scan-mounted-image.mjs');
  const boot = path.join(root, 'test-boot');
  const selected = path.join(boot, 'dtb/amlogic/meson-gxl-s905x-p212-b860av11t.dtb');
  const misplaced = path.join(boot, 'backup/meson-gxl-s905x-p212-b860av11t.dtb');

  assert.equal(findBootDtb(boot, [selected], path.basename(selected)), selected);
  assert.throws(() => findBootDtb(boot, [misplaced], path.basename(selected)), /active DTB path/);
  assert.throws(() => findBootDtb(boot, [selected, misplaced], path.basename(selected)), /exactly one target DTB/);
});

test('schema 5 rejects a self-consistent manifest with substituted DTB source metadata', () => {
  const fixture = readJson('tests/fixtures/valid-resolved-sources.json');
  const board = readJson('config/board.json');
  const current = buildManifest({
    ...fixture,
    schemaVersion: 5,
    board: { ...fixture.board, dtb: board.dtb, dtbBuild: board.dtbBuild },
    fingerprint: undefined,
  });
  assert.equal(validateManifest(current), current);

  const substituted = structuredClone(current);
  substituted.board.dtbBuild.repository = 'attacker/meson-gxl-s905x-p212';
  substituted.board.dtbBuild.rawSourceUrl = substituted.board.dtbBuild.rawSourceUrl.replace(
    'S-9527',
    'attacker',
  );
  const resigned = buildManifest(substituted);
  assert.throws(() => validateManifest(resigned), /DTB source metadata does not match the project recipe/);
});

test('manifest and validation gates bind schema 5/7 DTB provenance', () => {
  const manifest = read('src/upstream.mjs');
  const report = read('src/change-detection.mjs');
  const candidate = read('scripts/validate-candidate-artifacts.mjs');
  const workflow = read('.github/workflows/weekly-build.yml');

  assert.match(manifest, /schemaVersion[^\n]+5/);
  assert.match(manifest, /manifest\.board\.dtbBuild/);
  assert.match(report, /schemaVersion[^\n]+7/);
  assert.match(report, /sourceBuiltDeviceTree/);
  assert.match(candidate, /source-built-dtb\.json/);
  assert.match(candidate, /device-tree-source\.dts/);
  assert.match(candidate, /DTB component evidence does not match source build/);
  assert.match(workflow, /out\/source-built-dtb\.json/);
  assert.match(workflow, /out\/device-tree-source\.dts/);
});

test('CI rebuilds the source-built DTB twice and compares every evidence file', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /schemaVersion:\s*5/);
  assert.match(workflow, /build-board-dtb\.sh[^\n]+dtb-first/);
  assert.match(workflow, /build-board-dtb\.sh[^\n]+dtb-second/);
  assert.match(workflow, /cmp[^\n]+meson-gxl-s905x-p212-b860av11t\.dtb/);
  assert.match(workflow, /cmp[^\n]+source-built-dtb\.json/);
  assert.match(workflow, /cmp[^\n]+device-tree-source\.dts/);
});

test('release notes only describe a source-built DTB for schema 7 evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-release-notes-'));
  try {
    const manifest = readJson('tests/fixtures/valid-resolved-sources.json');
    const report = {
      schemaVersion: 6,
      status: 'container-valid / hardware-unverified',
      imageSha256: 'a'.repeat(64),
      evidence: { ubootBuild: 'uboot-build.json' },
    };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
    fs.writeFileSync(path.join(directory, 'uboot-build.json'), '{}');
    const oldNotes = execFileSync(process.execPath, [
      'scripts/render-release-notes.mjs',
      path.join(directory, 'manifest.json'),
      path.join(directory, 'report.json'),
    ], { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(oldNotes, /Source-built repair DTB/);
    assert.doesNotMatch(oldNotes, /public P212 repair source/);
    assert.doesNotMatch(oldNotes, /source-built-dtb\.json/);
    assert.doesNotMatch(oldNotes, /device-tree-source\.dts/);

    report.schemaVersion = 7;
    report.evidence.sourceBuiltDeviceTree = {
      build: 'source-built-dtb.json',
      source: 'device-tree-source.dts',
    };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
    fs.writeFileSync(path.join(directory, 'source-built-dtb.json'), JSON.stringify({
      source: { repository: 'S-9527/meson-gxl-s905x-p212', commit: '6'.repeat(40), sha256: 'b'.repeat(64) },
      artifact: { name: manifest.board.dtb },
    }));
    fs.writeFileSync(path.join(directory, 'device-tree-source.dts'), 'source\n');
    const newNotes = execFileSync(process.execPath, [
      'scripts/render-release-notes.mjs',
      path.join(directory, 'manifest.json'),
      path.join(directory, 'report.json'),
    ], { cwd: root, encoding: 'utf8' });
    assert.match(newNotes, /Source-built repair DTB/);
    assert.match(newNotes, /public P212 repair source/);
    assert.match(newNotes, /source-built-dtb\.json/);
    assert.match(newNotes, /device-tree-source\.dts/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
