# Source-Only Release Audit Implementation Plan

> **For agentic workers:** Execute this plan inline with fresh verification after each task.

**Goal:** Ensure every public Armbian prerelease is a current source-built, Android-free candidate before weekly detection can proceed.

**Architecture:** A small pure policy module validates one release's manifest, report, tag, and server asset metadata. A shell adapter uses `gh` to enumerate all public Armbian prereleases and downloads only the small provenance JSON files. The weekly detector fails before fingerprint comparison if any public release violates the current schema or source-only policy.

**Tech Stack:** Node.js 22, POSIX Bash, GitHub CLI, GitHub Actions, Node test runner.

## Global Constraints

- Keep the repository source-only; do not add vendor firmware, Android payloads, `.burn.img`, or large binary fixtures.
- Keep the weekly schedule at `23 3 * * 1` and preserve detector-only behavior when the fingerprint is unchanged.
- Require manifest schema 5, validation report schema 8, source-built U-Boot/DTB and QEMU system-smoke evidence, clean Android findings, and an Armbian `.img.gz` for every public prerelease.
- Do not download release image payloads during the audit; use server-side asset metadata and small JSON evidence files.
- Preserve repeated builds of the same upstream version by validating tags rather than requiring unique fingerprints.

---

### Task 1: Pure release-policy validation

**Files:**
- Create: `src/public-release-policy.mjs`
- Create: `tests/public-release-policy.test.mjs`

- [ ] **Step 1: Write failing tests** for acceptance of a current schema-5/8 release and rejection of schema-6/7, draft, non-prerelease, invalid tag, non-Armbian image, missing QEMU evidence, and non-clean Android evidence.
- [ ] **Step 2: Run `node --test tests/public-release-policy.test.mjs` and observe the missing-module failure.**
- [ ] **Step 3: Implement `validatePublicRelease({ manifest, report, release, tag })` by calling existing `validatePublishedState` and `validateReleaseAssets`, then requiring schema 5/8, `hardware-unverified`, a valid `armbian-...-build-N.A` tag, QEMU evidence assets, and exactly one `Armbian_*.img.gz` asset.
- [ ] **Step 4: Run the focused tests and then `pnpm test`.**

### Task 2: GitHub release inventory adapter

**Files:**
- Create: `scripts/audit-public-releases.sh`
- Modify: `tests/workflow-contract.test.mjs`

- [ ] **Step 1: Add a contract assertion that the detector invokes the audit script before comparing fingerprints.**
- [ ] **Step 2: Implement a strict Bash adapter that lists non-draft `armbian-` prereleases, validates tag-safe paths, downloads only `resolved-sources.json` and `validation-report.json`, obtains `gh release view --json tagName,assets,isDraft,isPrerelease`, and invokes the pure policy module. Fail on any command or policy error; allow zero releases for a fresh fork.**
- [ ] **Step 3: Run shell syntax and contract tests.**

### Task 3: Weekly integration and documentation

**Files:**
- Modify: `.github/workflows/weekly-build.yml`
- Modify: `scripts/resolve-sources.mjs`
- Modify: `README.md`
- Modify: `THIRD_PARTY_SOURCES.md`

- [ ] **Step 1: Add the audit script to the resolver recipe fingerprint and run it in the detector before loading the comparison release.**
- [ ] **Step 2: Document that all public prereleases are schema-8 source-built candidates and that factory `burn.img` remains excluded because its required B860 vendor boot chain is not open/reproducible.**
- [ ] **Step 3: Run `pnpm check`, `bash -n scripts/*.sh`, and `git diff --check`.**

### Task 4: Cloud verification and cleanup

**Files:**
- No large local artifacts.

- [ ] **Step 1: Commit with a signed conventional commit, push, and open a PR.**
- [ ] **Step 2: Wait for PR and `main` CI, then remove historical public releases/tags that fail the new policy; retain only source-built schema-8 releases.**
- [ ] **Step 3: Run one `force=false` cloud build, verify build/validation/publish success, then run it again and verify those jobs are skipped.**
- [ ] **Step 4: Audit the final public release inventory and record the exact evidence in the handoff.**
