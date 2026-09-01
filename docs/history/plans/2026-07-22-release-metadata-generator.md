# Release Metadata Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested CLI that derives collector-ready Release metadata from small published evidence assets without downloading the image.

**Architecture:** A pure source module validates and derives the metadata object from parsed evidence. A thin CLI reads the five named files, calls the module, and writes deterministic JSON. Existing manifest, validation-report, and release-tag validators remain the authoritative shared contracts.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, pnpm, GitHub Release evidence files.

## Global Constraints

- Do not download or inspect the large `.img.gz` image.
- Reject every missing, duplicate, malformed, or mismatched identity binding.
- Require the current validated B860 profile and image-identity check.
- Add production source and CLI files to the recipe fingerprint.
- Keep output compatible with `scripts/collect-device-evidence.sh`.

---

### Task 1: Define metadata derivation behavior

**Files:**
- Create: `tests/release-metadata.test.mjs`
- Create: `src/release-metadata.mjs`

**Interfaces:**
- Consumes: parsed manifest, report, QEMU evidence, release-tag text, filesystem-manifest text, and raw file bytes for digest validation.
- Produces: `buildReleaseMetadata(input) -> object`.

- [ ] **Step 1: Write the failing success-path test.** Construct a schema-5 B860 manifest, schema-8 validation report, bound QEMU evidence, and a unique image-identity manifest line. Assert all nine output fields.

- [ ] **Step 2: Run the focused test and confirm RED.**

Run: `pnpm exec node --test tests/release-metadata.test.mjs`

Expected: FAIL because `src/release-metadata.mjs` does not exist.

- [ ] **Step 3: Implement minimal validation and derivation.** Reuse `validatePublishedState` and `validateReleaseTag`; hash the two local evidence files; parse exactly one identity line; validate the QEMU manifest, raw image, and kernel bindings.

- [ ] **Step 4: Run the focused test and confirm GREEN.**

Run: `pnpm exec node --test tests/release-metadata.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add rejection tests one at a time.** Cover a wrong release tag, wrong filesystem-manifest digest, wrong QEMU raw hash, missing identity entry, and duplicate identity entry. Run each new test before its minimal implementation and confirm it fails for the intended reason.

- [ ] **Step 6: Run the focused test file.**

Run: `pnpm exec node --test tests/release-metadata.test.mjs`

Expected: all metadata derivation tests pass.

### Task 2: Add the generator CLI

**Files:**
- Create: `scripts/generate-release-metadata.mjs`
- Modify: `tests/release-metadata.test.mjs`

**Interfaces:**
- Consumes: `--assets <directory> --output <file>`.
- Produces: a newline-terminated, pretty-printed `release-metadata.json`.

- [ ] **Step 1: Write a failing CLI test.** Create the five input files in a temporary directory, invoke the script, and compare the parsed output with the unit-level result.

- [ ] **Step 2: Run the CLI test and confirm RED.**

Run: `pnpm exec node --test tests/release-metadata.test.mjs`

Expected: FAIL because the CLI script does not exist.

- [ ] **Step 3: Implement the CLI.** Parse only the two required options, read the named assets, call `buildReleaseMetadata`, create the output parent directory, and write deterministic JSON.

- [ ] **Step 4: Run the focused tests and confirm GREEN.**

Run: `pnpm exec node --test tests/release-metadata.test.mjs`

Expected: all tests pass.

### Task 3: Bind the generator to build inputs and document usage

**Files:**
- Modify: `scripts/resolve-sources.mjs`
- Modify: `docs/device-validation.md`
- Modify: `tests/integration-contract.test.mjs`

**Interfaces:**
- Recipe consumes exact SHA-256 values for `src/release-metadata.mjs` and `scripts/generate-release-metadata.mjs`.
- Operator workflow produces `release-metadata.json` before invoking the existing collector.

- [ ] **Step 1: Write a failing integration assertion.** Require both new files in the resolver recipe list.

- [ ] **Step 2: Run the integration test and confirm RED.**

Run: `pnpm exec node --test tests/integration-contract.test.mjs`

Expected: FAIL because the recipe list does not include the generator files.

- [ ] **Step 3: Add both files to `recipeFiles`.** Keep the list sorted within its existing source and script groups.

- [ ] **Step 4: Replace manual metadata transcription in the device guide.** Document `gh release download` for the five small assets and the generator command.

- [ ] **Step 5: Run focused verification.**

Run: `pnpm exec node --test tests/release-metadata.test.mjs tests/integration-contract.test.mjs`

Expected: all focused tests pass.

### Task 4: Verify and publish the branch

**Files:**
- Verify all changed files.

**Interfaces:**
- Produces: a pushed feature branch and pull request against `main`.

- [ ] **Step 1: Run the complete local gate.**

Run: `pnpm check`

Expected: all Node tests pass and all shell scripts parse successfully.

- [ ] **Step 2: Inspect repository state.**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intended files changed.

- [ ] **Step 3: Commit with the repository convention.**

Run: `git add docs scripts src tests && git commit -S -m "feat(validation): 生成实机验证发布元数据"`

Expected: signed commit succeeds.

- [ ] **Step 4: Push and create a pull request.**

Run: `git push -u origin codex/release-metadata-generator` followed by `gh pr create`.

Expected: branch and pull request are visible in the public repository.
