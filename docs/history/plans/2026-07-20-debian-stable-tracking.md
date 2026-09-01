# Debian Stable Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow Debian's signed current stable release and select the matching latest ophub Armbian image.

**Architecture:** A small parser converts a workflow-verified Debian `InRelease` file into canonical JSON. The existing resolver consumes that contract, derives the board distribution, and selects exact codename-specific ophub assets. Independent validation compares the built root filesystem with the signed manifest before publication.

**Tech Stack:** Node.js 22 ESM, Bash, GitHub Actions, `gpgv`, `debian-archive-keyring`, Node test runner.

## Global Constraints

- Schedule remains `23 3 * * 1` and unchanged fingerprints skip heavy jobs.
- Every remote input is recorded with an exact digest or commit.
- Signature, schema, asset, image identity, or publication failures fail closed.
- Existing manifest schemas 1-2 and validation schemas 1-4 remain readable.
- No `burn.img`, persistent bootloader, Android userspace, or Android boot fallback is added.
- Schema 3 release tags include the complete Debian point version and allow repeated builds.

---

### Task 1: Parse Verified Debian Stable Metadata

**Files:**
- Create: `src/debian-release.mjs`
- Create: `scripts/resolve-debian-stable.mjs`
- Create: `tests/debian-release.test.mjs`

**Interfaces:**
- Produces: `parseDebianInRelease(text, sourceUrl)` and `validateDebianStable(value)`.
- Produces CLI: `node scripts/resolve-debian-stable.mjs <InRelease> <output.json> <source-url>`.

- [ ] **Step 1: Write failing parser and CLI tests**

```javascript
const stable = parseDebianInRelease(validInRelease, sourceUrl);
assert.equal(stable.codename, 'trixie');
assert.equal(stable.majorVersion, '13');
assert.match(stable.digest, /^[0-9a-f]{64}$/);
assert.throws(() => parseDebianInRelease(tamperedHeader, sourceUrl));
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/debian-release.test.mjs`
Expected: FAIL because `src/debian-release.mjs` does not exist.

- [ ] **Step 3: Implement strict parsing and canonical CLI output**

Validate `Origin: Debian`, `Suite: stable`, numeric `Version`, lowercase
codename, valid date, HTTPS source URL, and SHA-256 of the exact signed text.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/debian-release.test.mjs`
Expected: all parser and CLI tests pass.

- [ ] **Step 5: Commit**

`git commit -S -m 'feat(resolver): 解析 Debian stable 元数据'`

### Task 2: Resolve Matching Armbian Inputs And Manifest Schema 3

**Files:**
- Modify: `config/sources.json`
- Modify: `config/board.json`
- Modify: `scripts/resolve-sources.mjs`
- Modify: `src/upstream.mjs`
- Modify: `tests/upstream.test.mjs`
- Modify: `tests/fixtures/valid-resolved-sources.json`

**Interfaces:**
- Consumes: canonical Debian stable JSON from Task 1.
- Produces: manifest schema 3 with `sources.debian` and derived board distribution.

- [ ] **Step 1: Add failing schema and future-codename resolver tests**

```javascript
assert.equal(result.manifest.board.distribution, 'forky');
assert.equal(result.manifest.board.distributionVersion, '14');
assert.match(result.manifest.sources.base.name, /_forky_arm64_/);
assert.deepEqual(result.manifest.sources.debian, stableFixture);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/upstream.test.mjs`
Expected: FAIL because the resolver still hard-codes Trixie patterns.

- [ ] **Step 3: Implement schema 3 and exact codename patterns**

Add `--debian-stable`, validate the normalized contract, escape the codename
before constructing regular expressions, derive board distribution fields, and
require schema 3 manifests to bind Debian source metadata.

- [ ] **Step 4: Verify GREEN and migration compatibility**

Run: `node --test tests/upstream.test.mjs`
Expected: future-codename and schema 1-2 compatibility tests pass.

- [ ] **Step 5: Commit**

`git commit -S -m 'feat(resolver): 跟踪 Debian stable 版本'`

### Task 3: Validate Manifest-Selected Debian Identity

**Files:**
- Modify: `scripts/validate-raw-image.sh`
- Modify: `scripts/scan-mounted-image.mjs`
- Modify: `src/change-detection.mjs`
- Modify: `src/release.mjs`
- Modify: `tests/validation-hardening.test.mjs`
- Modify: `tests/change-detection.test.mjs`
- Modify: `tests/release-gate.test.mjs`
- Modify: `tests/candidate-artifacts.test.mjs`

**Interfaces:**
- Consumes: manifest board distribution and major version.
- Produces: validation report schema 5 with `debianStableRelease: true`.
- Produces: schema 3 release tags containing the full Debian stable version.

- [ ] **Step 1: Add failing validator and release-gate tests**

```javascript
assert.match(validator, /board\.distribution/);
assert.match(validator, /board\.distributionVersion/);
assert.doesNotMatch(validator, /VERSION_CODENAME=trixie/);
assert.throws(() => validatePublishedState(manifest, mismatchedReport));
assert.match(releaseTagForManifest(manifest, 18, 1), /debian-13\.6-trixie/);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/validation-hardening.test.mjs tests/change-detection.test.mjs tests/release-gate.test.mjs tests/candidate-artifacts.test.mjs`
Expected: FAIL on the current hard-coded Trixie checks.

- [ ] **Step 3: Implement dynamic identity checks and schema 5**

Pass expected codename and major version into the mounted-image scanner, check
both `/etc/os-release` fields, emit `debianStableRelease`, and preserve schema
1-4 validation compatibility. Use `sources.debian.version` in schema 3 release
tags while retaining legacy tag generation for schema 1-2 manifests.

- [ ] **Step 4: Verify GREEN**

Run the same targeted command. Expected: all targeted tests pass.

- [ ] **Step 5: Commit**

`git commit -S -m 'feat(validator): 校验动态 Debian stable'`

### Task 4: Verify Debian Signatures Before Detection

**Files:**
- Modify: `.github/workflows/weekly-build.yml`
- Modify: `src/debian-release.mjs`
- Modify: `scripts/render-release-notes.mjs`
- Modify: `tests/workflow-contract.test.mjs`
- Modify: `tests/debian-release.test.mjs`
- Modify: `scripts/resolve-sources.mjs`
- Modify: `README.md`

**Interfaces:**
- Produces: verified `debian-stable.json` before source resolution.
- Preserves: detector output names and downstream artifact contracts.

- [ ] **Step 1: Add failing workflow contract tests**

```javascript
assert.match(detect, /debian-archive-keyring/);
assert.match(detect, /gpgv[^\n]+--status-fd/);
assert.match(detect, /requireGpgvValidSignature/);
assert.match(detect, /resolve-debian-stable\.mjs/);
assert.match(detect, /resolve-sources\.mjs[^\n]+--debian-stable/);
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/workflow-contract.test.mjs`
Expected: FAIL because the detector does not verify Debian metadata.

- [ ] **Step 3: Implement workflow ordering and documentation**

Install signed Ubuntu packages, download the fixed official HTTPS `InRelease`
with five bounded retries, and capture `gpgv --status-fd` output. Require at
least one trusted 40-hex signing and primary fingerprint before normalizing the
same file and invoking the source resolver; tolerate unknown parallel
signatures but never trust them. Require `Label: Debian`, `arm64`, and `main` in
the signed metadata, include the normalizer in the recipe fingerprint, render
the full Debian point version in release notes/title, and document fail-closed
automatic stable migration.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/workflow-contract.test.mjs && GOTOOLCHAIN=local /opt/homebrew/bin/go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -color=false`
Expected: workflow tests and actionlint pass.

- [ ] **Step 5: Commit**

`git commit -S -m 'feat(workflow): 验证 Debian stable 签名'`

### Task 5: Full Verification And Cloud Acceptance

**Files:**
- Verify only.

- [ ] **Step 1: Run local gates**

Run: `pnpm check`, fixed-version actionlint, and `git diff --check`.
Expected: all tests, shell syntax, workflow lint, and diff checks pass.

- [ ] **Step 2: Review and publish through PR**

Push `codex/track-debian-stable`, open a PR, wait for CI, and merge only after
the changed files and checks are clean.

- [ ] **Step 3: Run full cloud build**

Dispatch `force=false`. Expected: Detect, Build, Independent Validate, and
Publish succeed with a schema 3 manifest and schema 5 report.

- [ ] **Step 4: Verify the published prerelease**

Confirm the tag contains Armbian version, Debian major/codename, kernel, and
build identity; all eight assets are uploaded and digests match the report.

- [ ] **Step 5: Verify no-change behavior**

Dispatch `force=false` again. Expected: Detect succeeds and Build, Validate,
Publish, and Keepalive are skipped with an identical fingerprint.
