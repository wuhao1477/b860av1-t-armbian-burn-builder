# B860AV1.1-T Hardware Capability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject a B860AV1.1-T candidate unless its installed kernel configuration and active DTB satisfy the board's static hardware prerequisites.

**Architecture:** A fingerprinted JSON recipe declares the required kernel symbols and DTB checks. A focused evaluator produces one evidence document, while the existing candidate and Release validators bind that document to the rootfs manifest, active boot components, RTL8189FS evidence, and validation report.

**Tech Stack:** Node.js 22 ESM, Linux `fdtget`, Bash, Node test runner, GitHub Actions.

## Global Constraints

- Keep validation report schema 8 and preserve historical schema 8 Release auditability.
- Require the gate only when `recipe.files` contains `config/hardware-capabilities.json`.
- Keep status `container-valid / hardware-unverified` until real-device evidence exists.
- Do not add Android partitions, vendor boot blobs, or an Amlogic USB Burning Tool package.
- Run the image build and integration validation only in GitHub Actions.

---

### Task 1: Recipe and evaluator

**Files:**
- Create: `config/hardware-capabilities.json`
- Create: `src/hardware-capabilities.mjs`
- Create: `tests/hardware-capabilities.test.mjs`

**Interfaces:**
- Produces: `requiresHardwareCapabilityValidation(manifest) -> boolean`
- Produces: `parseKernelConfig(source) -> Map<string, string>`
- Produces: `evaluateHardwareCapabilities(recipe, kernelConfig, readDtb) -> object`
- Produces: `validateHardwareCapabilityEvidence(value, context) -> object`

- [ ] Write tests for the six capability requirements, missing symbols, wrong DTB values, and digest bindings.
- [ ] Run `pnpm test -- tests/hardware-capabilities.test.mjs` and confirm failure because the module is missing.
- [ ] Add the strict recipe and minimal evaluator needed by the tests.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Trusted image evidence generation

**Files:**
- Create: `scripts/validate-hardware-capabilities.mjs`
- Modify: `scripts/validate-raw-image.sh`
- Modify: `tests/validation-hardening.test.mjs`
- Modify: `tests/integration-contract.test.mjs`

**Interfaces:**
- Consumes: mounted rootfs, active DTB, kernel release, recipe, manifest,
  `filesystem-manifest.sha256`, `boot-components.json`, and
  `rtl8189fs-driver.json`.
- Produces: `hardware-capabilities.json` with schema version 1 and status
  `passed`.

- [ ] Add contract tests requiring the CLI call, generated evidence, report digest, and successful check.
- [ ] Run the focused contract tests and confirm the new assertions fail.
- [ ] Implement the `fdtget` adapter and invoke it after filesystem and boot-component evidence exists.
- [ ] Bind the new evidence digest into `validation-report.json`.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Candidate and Release enforcement

**Files:**
- Modify: `src/change-detection.mjs`
- Modify: `scripts/validate-candidate-artifacts.mjs`
- Modify: `tests/change-detection.test.mjs`
- Modify: `tests/candidate-artifacts.test.mjs`
- Modify: `tests/public-release-policy.test.mjs`

**Interfaces:**
- Consumes: `hardware-capabilities.json` and its report digest.
- Produces: historical compatibility for manifests without the recipe marker;
  mandatory evidence and cross-file validation for marked manifests.

- [ ] Add failing tests for a missing artifact, tampered config binding,
  tampered DTB binding, false capability, and old schema 8 compatibility.
- [ ] Run the focused tests and confirm each new rejection is absent.
- [ ] Add conditional report, candidate, and Release asset validation.
- [ ] Re-run the focused tests and confirm all new cases pass.

### Task 4: Fingerprint, workflow, and documentation

**Files:**
- Modify: `scripts/resolve-sources.mjs`
- Modify: `.github/workflows/weekly-build.yml`
- Modify: `scripts/render-release-notes.mjs`
- Modify: `README.md`
- Modify: `tests/workflow-contract.test.mjs`
- Modify: `tests/public-release-policy.test.mjs`

**Interfaces:**
- Produces: a changed build fingerprint and a public
  `hardware-capabilities.json` Release asset.

- [ ] Add failing contract tests for recipe fingerprinting, candidate upload,
  Release upload, and release-note disclosure.
- [ ] Add all new recipe files to `recipeFiles` and all evidence paths to the
  validate and publish jobs.
- [ ] Render a concise static-capability result while retaining the
  hardware-unverified warning.
- [ ] Re-run the focused tests and confirm they pass.

### Task 5: Verification and publication

**Files:**
- Verify: all changed files

- [ ] Run `pnpm check` and confirm zero failures.
- [ ] Run `git diff --check` and inspect `git diff --stat`.
- [ ] Commit with GPG signing using
  `feat(validation): 增加板级硬件能力门禁`.
- [ ] Push `codex/hardware-capability-gate` and create a draft PR to `main`.
- [ ] Wait for PR CI, inspect failures if any, and merge only after all checks pass.
- [ ] Force one weekly build to exercise the Linux image validator and inspect
  the new Release evidence.
- [ ] Run the weekly workflow once without force and confirm build, validate,
  and publish remain skipped when the fingerprint is unchanged.
