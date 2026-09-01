# B860AV1.1-T Armbian Builder Implementation Plan

> Historical plan. The current implementation follows Debian stable dynamically,
> uses the repository-owned `b860av1-t` profile, and is defined by the current
> README, schema 4 manifest, and schema 6 validation report.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a public GitHub Actions pipeline that resolves the newest Debian Trixie Armbian inputs once per week, skips unchanged builds, and publishes a provenance-rich B860AV1.1-T candidate image.

**Architecture:** Dependency-free Node.js modules perform deterministic source selection, canonical fingerprinting, and prior-release comparison. GitHub Actions performs the heavyweight Linux build with exact resolved ophub inputs, validates the resulting raw image, and publishes only container-valid artifacts. No Android boot container or proprietary compatibility assembler is included.

**Tech Stack:** Node.js 22 built-in `node:test`, Bash, GitHub Actions, `gh`/GitHub REST API, ophub/amlogic-s9xxx-armbian.

## Global Constraints

- Schedule: `23 3 * * 1`.
- Distribution: Debian Trixie arm64 server.
- Kernel selection: newest numeric `5.10.y` asset from `ophub/kernel` `kernel_stable`.
- Board profile: repository-owned `b860av1-t`, explicitly hardware-unverified for B860AV1.1-T.
- No public vendor bootloader or derived proprietary `burn.img`.
- Build job condition: `needs.detect.outputs.changed == 'true'` or manual `force == 'true'`.
- No local image build is required or expected.

---

### Task 1: Repository contract and deterministic source resolver

**Files:**
- Create: `package.json`
- Create: `config/board.json`
- Create: `config/sources.json`
- Create: `src/canonical-json.mjs`
- Create: `src/upstream.mjs`
- Create: `src/change-detection.mjs`
- Create: `tests/upstream.test.mjs`
- Create: `tests/change-detection.test.mjs`
- Create: `scripts/resolve-sources.mjs`
- Test: `tests/upstream.test.mjs`, `tests/change-detection.test.mjs`

**Interfaces:**
- `selectLatestRelease(releases, pattern)` returns one release object or throws on none.
- `selectLatestAsset(assets, pattern, versionExtractor)` returns one `{name,url,digest,size}` or throws on zero/multiple candidates.
- `buildManifest(input)` returns a schema-versioned manifest with `fingerprint` excluded from its canonical source payload.
- `compareFingerprints(current, previous, force)` returns `{changed, reason}`.
- `node scripts/resolve-sources.mjs --output path` writes canonical JSON and GitHub output keys.

- [x] **Step 1: Write failing fixtures and tests** for release ordering, highest kernel patch selection, duplicate asset rejection, digest prefix normalization, canonical fingerprint stability, missing previous release, unchanged fingerprint, and `force=true`.
- [x] **Step 2: Run the focused tests** with `pnpm test -- --test-name-pattern='upstream|fingerprint|change'`; confirm failures are caused by missing modules.
- [x] **Step 3: Implement the pure modules and CLI** with no network calls in the pure functions. The CLI must use `GITHUB_API_URL` (default `https://api.github.com`), `GITHUB_TOKEN` when present, and fail closed on malformed API JSON.
- [x] **Step 4: Run focused tests again** and require all tests to pass.
- [x] **Step 5: Run the resolver against live GitHub metadata** and inspect that the selected base asset, kernel asset, exact builder commit, and SHA-256 digests are present.

### Task 2: Raw image build and static validator

**Files:**
- Create: `scripts/build-raw-image.sh`
- Create: `scripts/validate-raw-image.sh`
- Create: `scripts/render-release-notes.mjs`
- Create: `tests/workflow-contract.test.mjs`
- Create: `tests/fixtures/valid-resolved-sources.json`

**Interfaces:**
- `scripts/build-raw-image.sh manifest.json output-dir` downloads and verifies the selected base, checks out the exact ophub SHA, invokes `sudo ./rebuild -b b860av1-t -k <resolved> -a false -t ext4`, and writes one `.img.gz`.
- `scripts/validate-raw-image.sh image.img.gz report.json resolved-sources.json` exits nonzero unless gzip, MBR, empty bootloader-region, partition, filesystem, Debian identity, active boot files, and checksum checks pass.
- `render-release-notes.mjs` consumes the manifest and validation report and emits a concise Markdown release body with `container-valid / hardware-unverified` status.

- [x] **Step 1: Add validator contract tests** asserting the exact required boot files, Debian Trixie identity, prohibited Android paths, schedule-independent metadata, and workflow permissions/conditions.
- [x] **Step 2: Run the contract tests** and confirm they fail before workflow files exist.
- [x] **Step 3: Implement the shell scripts** with `set -Eeuo pipefail`, explicit SHA-256 checks, cleanup traps, no unquoted user-controlled paths, and no publication side effects.
- [x] **Step 4: Run shell syntax checks and Node tests** (`bash -n`, `pnpm test`) and retain the failure output if a Linux-only command is unavailable on macOS.

### Task 3: Weekly conditional Actions and versioned releases

**Files:**
- Create: `.github/workflows/weekly-build.yml`

**Interfaces:**
- Release tags use `armbian-<version>-debian-trixie-k<kernel>-build-<run>.<attempt>` and never overwrite a different build of the same upstream version.

- [x] **Step 1: Add `weekly-build.yml`** with the Monday cron, manual `force` input, detector-only fast path, concurrency group, pinned official Actions, minimal permissions, artifact handoff, conditional build, validation, and prerelease publication.
- [x] **Step 2: Add versioned tag generation** from the resolved Armbian version, Debian codename, kernel version, run number, and run attempt.
- [x] **Step 3: Run YAML contract tests and `actionlint` when available.**

### Task 4: Documentation, licenses, and local verification

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `SECURITY.md`
- Create: `.gitignore`
- Create: `CODE_OF_CONDUCT.md`
- Create: `CONTRIBUTING.md`

- [x] **Step 1: Document** the one-command manual dispatch, weekly behavior, release status, raw-image usage, exact limitation of USB Burning Tool, and required serial evidence for promotion.
- [x] **Step 2: Add licenses and security policy** without embedding vendor binaries or local paths.
- [x] **Step 3: Run the complete local verification**: `pnpm install --frozen-lockfile`, `pnpm test`, `bash -n scripts/*.sh`, `git diff --check`, and a repository scan for prohibited firmware names and absolute local paths.
- [ ] **Step 4: Commit the implementation** with signed commits and inspect `git status --short` and the complete diff before publishing.

### Task 5: Publish and cloud verification

**Files:**
- Modify: repository remote and GitHub Actions state only

- [ ] **Step 1: Create** the public repository `wuhao1477/b860av1-t-armbian-builder` with the prepared local checkout.
- [ ] **Step 2: Push** the signed commits and verify the default branch, workflow visibility, and Actions permissions through `gh`.
- [ ] **Step 3: Trigger** one manual `force=true` run; do not run a second build if the detector reports unchanged.
- [ ] **Step 4: Monitor** the detector and build jobs with `gh run watch`/`gh run view`, download reports, and compare the published manifest fingerprint with the detector output.
- [ ] **Step 5: Report** the repository URL, workflow URL, run URL, artifact status, and the exact hardware-validation boundary without claiming unverified bootability.
