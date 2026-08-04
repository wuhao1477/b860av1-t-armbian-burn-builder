# B860AV1.1-T Real-Device Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only real-device evidence path that binds a ZXV10 B860AV1.1-T boot and six hardware checks to one published raw Armbian Release without changing the existing static Release report.

**Architecture:** The image build writes a repository-owned identity file containing the manifest fingerprint and installed kernel identity. A shell collector gathers sanitized device observations and emits a schema-1 JSON plus serial log. A Node validator compares those files with downloaded Release evidence and produces a publication artifact. PR CI validates read-only; a separate manual workflow revalidates and uploads uniquely named evidence assets only after all checks pass.

**Tech Stack:** Node.js 22 ESM, Bash, Node test runner, GitHub Actions, `gh`, standard Linux sysfs/proc utilities. No new runtime package dependencies.

## Global Constraints

- Keep the original image report status `container-valid / hardware-unverified` and schema 8 unchanged.
- Add only the separate per-build/per-device result `operator-attested / one-device`.
- Do not create `burn.img`, Android partitions, vendor boot blobs, or persistent bootloader data.
- Run image construction and Linux filesystem checks only in GitHub Actions.
- Collect no MAC address, IP address, SSID, EDID bytes, eMMC CID, USB serial, UUID, password, token, or environment dump.
- Every shell command must fail closed; device collection must not write to a block device or alter boot configuration.
- Keep the weekly schedule at `23 3 * * 1`; unchanged fingerprints must skip build, validation, and publication.
- Preserve validation compatibility for existing manifests and Releases that lack the new recipe markers.
- Use ASCII in scripts and JSON; documentation may remain UTF-8.
- Use Node test runner and `pnpm check`; Python is not part of this implementation.

---

## File Map

### Identity files

- Create `src/image-identity.mjs`: schema, path, digest, and manifest/kernel field validation.
- Create `scripts/write-image-identity.mjs`: safe CLI that writes the identity file into a mounted root filesystem.
- Create `tests/image-identity.test.mjs`: unit and path-traversal tests.
- Modify `scripts/build-raw-image.sh`: mount the rebuilt root partition, write the identity before final sanitization/compression, unmount cleanly.
- Modify `scripts/validate-raw-image.sh`: validate the identity from the mounted root and add a conditional `imageIdentity` check.
- Modify `src/change-detection.mjs`, `src/public-release-policy.mjs`, and related fixtures/tests for conditional enforcement.

### Evidence model and collector

- Create `src/device-evidence.mjs`: canonical schema, redaction, serial parser, safe paths, and capability result checks.
- Create `scripts/collect-device-evidence.sh`: read-only Linux probe and challenge-line writer.
- Create `scripts/render-device-evidence.mjs`: deterministic JSON writer used by the shell collector.
- Create `tests/device-evidence.test.mjs`: model, redaction, serial, and tamper tests.
- Create `tests/device-evidence-collector.test.mjs`: synthetic `/proc`, `/sys`, and command fixtures proving no writes.

### Release validator and workflows

- Create `scripts/validate-device-evidence.mjs`: compare evidence with local Release assets and the recorded collector Git blob.
- Create `scripts/render-device-validation-summary.mjs`: create the Markdown publication artifact.
- Create `tests/validate-device-evidence.test.mjs`: Release binding and failure-policy tests.
- Modify `src/change-detection.mjs` and `scripts/audit-public-releases.sh`: allow optional uniquely named evidence assets without making them part of the static Release requirement.
- Create `.github/workflows/device-evidence-pr.yml`: read-only PR validation.
- Create `.github/workflows/verify-device.yml`: manual read-only validation job plus dependent write-only publication job.
- Modify `tests/workflow-contract.test.mjs`: workflow trigger, permission, ordering, and no-mutation assertions.

### Fingerprint and documentation

- Modify `scripts/resolve-sources.mjs`: include all identity/evidence source files and workflow files in `recipe.files`.
- Modify `README.md`: explain identity, evidence submission, trust boundary, and that raw images remain non-`burn.img`.
- Create `evidence/.gitkeep` and `docs/device-validation.md`: contributor-facing evidence layout and commands.
- Modify `tests/integration-contract.test.mjs`, `tests/repository-policy.test.mjs`, and `tests/public-release-policy.test.mjs` for the new recipe marker.

---

### Task 1: Add the immutable image identity

**Files:**
- Create: `src/image-identity.mjs`
- Create: `scripts/write-image-identity.mjs`
- Create: `tests/image-identity.test.mjs`
- Modify: `scripts/build-raw-image.sh`
- Modify: `scripts/validate-raw-image.sh`
- Modify: `src/change-detection.mjs`
- Modify: `tests/integration-contract.test.mjs`

**Interfaces:**
- `buildImageIdentity({ manifestFingerprint, boardProfile, kernelVersion, kernelRelease }) -> object`
- `validateImageIdentity(value, expected) -> object`
- CLI example: `node scripts/write-image-identity.mjs /mnt/b860-root resolved-sources.json 5.10.260-ophub`
- `IMAGE_IDENTITY_PATH = 'usr/lib/b860av1-t/image-identity.json'`
- `requiresImageIdentity(manifest) -> boolean`, true when `recipe.files` contains `scripts/write-image-identity.mjs`.

- [ ] **Step 1: Write failing unit tests.** Add tests that require this exact identity and reject a wrong fingerprint, unsafe path, missing kernel release, extra top-level keys, and a non-`b860av1-t` profile:

```js
test('builds and validates the image identity contract', () => {
  const identity = buildImageIdentity({
    manifestFingerprint: 'a'.repeat(64),
    boardProfile: 'b860av1-t',
    kernelVersion: '5.10.260',
    kernelRelease: '5.10.260-ophub',
  });
  assert.equal(identity.identityPath, '/usr/lib/b860av1-t/image-identity.json');
  assert.equal(validateImageIdentity(identity, identity), identity);
});

test('rejects an identity bound to another manifest', () => {
  const identity = validIdentity();
  assert.throws(
    () => validateImageIdentity(identity, { ...identity, manifestFingerprint: 'b'.repeat(64) }),
    /manifest fingerprint/i,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm failure.**

Run: `pnpm test -- tests/image-identity.test.mjs`

Expected: FAIL because `src/image-identity.mjs` does not yet export the functions.

- [ ] **Step 3: Implement the strict module and writer.** Keep the module below 50 lines per exported function and reject all paths except the constant identity path. The writer must create only the target directory and file, use mode `0644`, and write canonical JSON with a trailing LF:

```js
export const IMAGE_IDENTITY_PATH = 'usr/lib/b860av1-t/image-identity.json';

export function buildImageIdentity(input) {
  const value = { schemaVersion: 1, ...input, identityPath: `/${IMAGE_IDENTITY_PATH}` };
  return validateImageIdentity(value, value);
}
```

The Bash build flow must mount the root partition read-write only after the rebuilt image exists, locate exactly one `/usr/src/linux-headers-${kernelVersion}-*/include/config/auto.conf`, derive its directory name as `kernelRelease`, invoke the writer, unmount, run `e2fsck -fy`, and only then run `sanitize-raw-image.mjs`. A trap must unmount the root on every error.

- [ ] **Step 4: Add the conditional static gate.** Add `requiresImageIdentity` and require `checks.imageIdentity === true` only for manifests carrying the writer recipe marker. The raw validator must read and validate the file and ensure its digest appears exactly once in `filesystem-manifest.sha256`. Historical schema-8 manifests without the marker remain valid.

- [ ] **Step 5: Run focused tests and shell syntax.**

Run: `pnpm test -- tests/image-identity.test.mjs tests/integration-contract.test.mjs && bash -n scripts/build-raw-image.sh scripts/validate-raw-image.sh`

Expected: all focused tests pass and `bash -n` exits 0.

- [ ] **Step 6: Commit.**

```bash
git add src/image-identity.mjs scripts/write-image-identity.mjs tests/image-identity.test.mjs scripts/build-raw-image.sh scripts/validate-raw-image.sh src/change-detection.mjs tests/integration-contract.test.mjs
git commit -S -m 'feat(validation): 写入镜像身份文件'
```

---

### Task 2: Implement the evidence model and redaction

**Files:**
- Create: `src/device-evidence.mjs`
- Create: `tests/device-evidence.test.mjs`

**Interfaces:**
- `DEVICE_EVIDENCE_SCHEMA = 1`
- `CAPABILITIES = ['emmc', 'ethernet', 'hdmi', 'infrared', 'usb', 'wifi']`
- `redactSensitiveText(source) -> string`
- `parseSerialLog(source, { evidenceId, manifestFingerprint, kernelRelease }) -> { normalized, markers, warnings }`
- `validateDeviceEvidence(value, context) -> value`
- `safeEvidenceRelativePath(value) -> boolean`

- [ ] **Step 1: Write failing tests for valid data and every redaction class.** Use explicit assertions for IPv4, IPv6, MAC, SSID, UUID, eMMC CID, USB serial, `TOKEN=`, control characters, 2 MiB limit, CRLF normalization, exactly one challenge line, and post-handoff Android marker rejection:

```js
test('redacts identifiers before publication', () => {
  const source = 'ip=192.0.2.10 mac=02:00:00:00:00:01 ssid=Home TOKEN=secret';
  const redacted = redactSensitiveText(source);
  assert.doesNotMatch(redacted, /192\.0\.2\.10|02:00:00|Home|secret/);
  assert.match(redacted, /\[REDACTED\]/);
});

test('requires one live collector challenge and rejects Android execution', () => {
  const line = 'B860_DEVICE_READY abcdef0123456789 ' + 'a'.repeat(64) + ' 5.10.260-ophub';
  assert.equal(parseSerialLog(`Linux version 5.10.260-ophub\r\n${line}\r\n`, {
    evidenceId: 'abcdef0123456789', manifestFingerprint: 'a'.repeat(64),
    kernelRelease: '5.10.260-ophub',
  }).markers.challenge, line);
  assert.throws(() => parseSerialLog(`${line}\nLinux kernel handoff\nboot_android\n`, {
    evidenceId: 'abcdef0123456789', manifestFingerprint: 'a'.repeat(64),
    kernelRelease: '5.10.260-ophub',
  }), /Android|stock fallback/i);
});
```

- [ ] **Step 2: Run the tests and confirm failure.**

Run: `pnpm test -- tests/device-evidence.test.mjs`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement canonical validation.** Require the schema, status, 16-hex evidence ID, UTC timestamp, board profile, release fields, identity fields, collector fields, serial fields, boot component list, and all six `passed: true` results. Reject unknown top-level fields and unsafe paths. Normalize serial input to LF, cap it at 2 MiB, and perform redaction before hashing.

- [ ] **Step 4: Implement the serial parser.** Recognize the exact challenge format:

```text
B860_DEVICE_READY 0123456789abcdef 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 5.10.260-ophub
```

Require one challenge, one Linux kernel-release line, and one post-boot readiness marker. Treat vendor text before the first Linux kernel line as `preHandoffVendorText`; reject `boot_android`, `storeboot`, and `start_emmc_autoscript` only after handoff. Reject all other Android init/filesystem execution markers after handoff.

- [ ] **Step 5: Run the focused tests and commit.**

Run: `pnpm test -- tests/device-evidence.test.mjs`

Expected: PASS.

```bash
git add src/device-evidence.mjs tests/device-evidence.test.mjs
git commit -S -m 'feat(validation): 增加实机证据数据模型'
```

---

### Task 3: Build the read-only device collector

**Files:**
- Create: `scripts/collect-device-evidence.sh`
- Create: `scripts/render-device-evidence.mjs`
- Create: `tests/device-evidence-collector.test.mjs`
- Create: `docs/device-validation.md`

**Interfaces:**
- CLI example: `sudo scripts/collect-device-evidence.sh --release-metadata /tmp/b860-release-metadata.json --output /tmp/b860-device-evidence --serial-log /tmp/uart.log`
- Release metadata input: `/tmp/b860-release-metadata.json` contains the exact tag, image name, compressed/raw digests, manifest fingerprint, kernel version, and kernel release copied from the published Release assets; the device needs neither GitHub credentials nor network access.
- Fixture override example: `B860_DEVICE_FIXTURE_ROOT=/tmp/b860-fixture` is accepted only by tests; production refuses fixture mode unless `--non-interactive` is also set.
- Output: `/tmp/b860-device-evidence/device-validation.json` and `/tmp/b860-device-evidence/device-serial.log`.

- [ ] **Step 1: Write synthetic fixture tests before the script.** The test creates temporary proc/sys trees and fake `findmnt`, `ip`, `iw`, `udevadm`, `blockdev`, `sha256sum`, and `dd` commands. It asserts the collector returns 0 only when all six checks and the supplied manual observations pass, and records no command containing `of=/dev/` or any block-device write flag.

- [ ] **Step 2: Run the collector test and confirm failure.**

Run: `pnpm test -- tests/device-evidence-collector.test.mjs`

Expected: FAIL because the collector script does not exist.

- [ ] **Step 3: Implement strict argument handling and common probes.** Use `set -Eeuo pipefail`, a temporary directory with a cleanup trap, a fixed allow-list of commands, `mktemp`, and `umask 077`. Validate tag, output path, release fingerprint, image digests, and kernel release before probing. Generate the random evidence ID with `od -An -N8 -tx1 /dev/urandom`, normalize it to 16 hex characters, and print the challenge once to `/dev/console`.

- [ ] **Step 4: Implement the six read-only probes.**

  - eMMC: inspect `/sys/block/mmcblk*`, `findmnt -no SOURCE /`, `blockdev --getsize64`, and `dd if=/dev/mmcblk0 of=/tmp/b860-emmc-read iflag=direct,count=8`; never use a device as output.
  - Ethernet: inspect `/sys/class/net/*/carrier` and `operstate`; use `ip route` and a bounded `curl --connect-timeout 5 --max-time 10` to a caller-supplied HTTPS health endpoint; discard addresses.
  - HDMI: inspect `/sys/class/drm/*/status`, hash EDID through `sha256sum` without storing bytes, and require an explicit `--hdmi-visible` observation.
  - Infrared: inspect `/sys/class/rc` and `/sys/class/input`; use `ir-keytable -t` or a bounded input read, retaining only a key-code integer; require `--infrared-key-seen` in non-interactive mode.
  - USB: inspect `/sys/bus/usb/devices`, wait for a hotplug count change, and retain only vendor/product IDs; storage gets a read-only descriptor/sector probe.
  - Wi-Fi: inspect the `8189fs` module and `iw dev`, perform a bounded connectivity check, and discard SSID, MAC, and address fields.

- [ ] **Step 5: Render canonical JSON and sanitize the serial log.** Pass only scalar observations to `render-device-evidence.mjs`; the renderer calls `validateDeviceEvidence` and writes stable key ordering with a final LF. The shell script applies `redactSensitiveText` to the serial capture before writing it and stores its SHA-256 in the JSON.

- [ ] **Step 6: Run tests and commit.**

Run: `pnpm test -- tests/device-evidence.test.mjs tests/device-evidence-collector.test.mjs && bash -n scripts/collect-device-evidence.sh`

Expected: PASS, with no write-operation assertion failures.

```bash
git add scripts/collect-device-evidence.sh scripts/render-device-evidence.mjs tests/device-evidence-collector.test.mjs docs/device-validation.md
git commit -S -m 'feat(validation): 增加只读实机采集器'
```

---

### Task 4: Bind evidence to a published Release

**Files:**
- Create: `scripts/validate-device-evidence.mjs`
- Create: `scripts/render-device-validation-summary.mjs`
- Create: `tests/validate-device-evidence.test.mjs`
- Modify: `src/change-detection.mjs`
- Modify: `src/public-release-policy.mjs`
- Modify: `scripts/audit-public-releases.sh`

**Interfaces:**
- CLI example: `node scripts/validate-device-evidence.mjs evidence/armbian-26.08.0-debian-13.6-trixie-k5.10.260-build-35.1/0123456789abcdef /tmp/b860-release-assets "$PWD" /tmp/device-validation-summary.json`
- `validateDeviceEvidenceAgainstRelease(evidence, releaseAssets, repoRoot) -> { evidence, manifest, report, release, summary }`
- `renderDeviceValidationSummary(result, outputPath) -> void`

- [ ] **Step 1: Write failing tests for the success path and tampering.** Build a temporary local Release fixture from existing `tests/fixtures/valid-resolved-sources.json` and schema-8 evidence. Add tests for wrong tag, wrong image digest, changed manifest, missing identity digest line, wrong boot component, changed serial hash, missing challenge, non-ancestor collector commit, duplicate evidence pair, and any failed capability. The success test must return `operator-attested / one-device` without changing `validation-report.json`.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run: `pnpm test -- tests/validate-device-evidence.test.mjs`

Expected: FAIL because the CLI/module is missing.

- [ ] **Step 3: Implement Release asset loading and binding.** Read exactly `resolved-sources.json`, `validation-report.json`, `boot-components.json`, `filesystem-manifest.sha256`, `SHA256SUMS`, and `device-validation.json`/`device-serial.log`. Call existing `validatePublicRelease`/`validatePublishedState` first. Compare the evidence tag, image, compressed/raw digests, and manifest fingerprint to authoritative Release values. Do not download the multi-gigabyte image during evidence validation.

- [ ] **Step 4: Implement identity and boot-component checks.** Require the identity path and digest to occur exactly once in the filesystem manifest. Compare identity fields to the manifest and report kernel release. Require every submitted boot component to be a unique safe path and matching SHA-256 in the published `boot-components.json`; label them as installed/selected files, not proof of bootloader provenance.

- [ ] **Step 5: Implement collector Git blob verification.** Require `collector.commit` to be a 40-hex object present in the full checkout, verify it is an ancestor of `HEAD`, read the recorded path with `git show "$collector_commit:$collector_path"`, and compare its SHA-256 to `collector.scriptSha256`. This avoids accepting a script changed after evidence collection.

- [ ] **Step 6: Implement serial and capability checks, then render summary.** Recompute the redacted log digest, call `parseSerialLog`, compare the challenge to the JSON, require all six capability results and their required non-sensitive observations, and write a deterministic Markdown summary containing the tag, image digest, fingerprint, kernel release, evidence ID, UTC timestamp, and trust limitation.

- [ ] **Step 7: Run focused tests and commit.**

Run: `pnpm test -- tests/validate-device-evidence.test.mjs`

Expected: PASS.

```bash
git add scripts/validate-device-evidence.mjs scripts/render-device-validation-summary.mjs tests/validate-device-evidence.test.mjs src/change-detection.mjs src/public-release-policy.mjs
git commit -S -m 'feat(validation): 绑定实机证据到发布版本'
```

---

### Task 5: Add PR and manual publication workflows

**Files:**
- Create: `.github/workflows/device-evidence-pr.yml`
- Create: `.github/workflows/verify-device.yml`
- Modify: `tests/workflow-contract.test.mjs`
- Modify: `README.md`

**Interfaces:**
- PR workflow trigger: `pull_request` only when `evidence/**` changes; validator code changes remain covered by normal CI, so a code-only PR cannot fail for a missing evidence directory.
- Manual workflow inputs: `release_tag`, `evidence_path`, `confirmation`; the confirmation must equal `verify`.
- Publication asset names use the validated ID, for example `device-validation-0123456789abcdef.json`, `device-serial-0123456789abcdef.log`, and `device-validation-0123456789abcdef.md`.
- Optional Release asset names match only `device-validation-[0-9a-f]{16}.json`, `device-serial-[0-9a-f]{16}.log`, or `device-validation-[0-9a-f]{16}.md`; static Release validation never requires them.

- [ ] **Step 1: Write failing workflow contract tests.** Require checkout with `fetch-depth: 0`, Node 22, read-only PR permissions, `device-evidence-pr.yml` limited to `evidence/**`, manual-only `verify-device.yml`, Release download before validation, no image download, a separate write job dependent on validation, unique asset names, and no `--clobber`/delete operation.

- [ ] **Step 2: Run the contract tests and confirm failure.**

Run: `pnpm test -- tests/workflow-contract.test.mjs`

Expected: FAIL because the new workflows are absent.

- [ ] **Step 3: Implement PR validation.** Download Release metadata/assets with `gh release download --pattern` into `$RUNNER_TEMP`, run `node scripts/validate-device-evidence.mjs`, upload only a short JSON summary as a workflow artifact, and never request write permission.

- [ ] **Step 4: Implement the manual two-job workflow.** The `validate` job uses `contents: read`, checks the explicit confirmation, downloads exact Release assets, runs the validator, and uploads the three candidate evidence files plus a digest manifest as a short-lived artifact. The dependent `publish` job uses `contents: write`, verifies the artifact digest, checks the target asset names are absent through `gh release view`, and calls `gh release upload "$release_tag" ...` exactly once. It must not edit the existing report, image, tag, or Release status.

- [ ] **Step 5: Run workflow contracts and commit.**

Run: `pnpm test -- tests/workflow-contract.test.mjs`

Expected: PASS.

```bash
git add .github/workflows/device-evidence-pr.yml .github/workflows/verify-device.yml tests/workflow-contract.test.mjs README.md
git commit -S -m 'feat(validation): 增加实机证据发布流程'
```

---

### Task 6: Fingerprint, documentation, and complete validation

**Files:**
- Modify: `scripts/resolve-sources.mjs`
- Modify: `README.md`
- Create: `evidence/.gitkeep`
- Modify: `docs/device-validation.md`
- Modify: `tests/repository-policy.test.mjs`
- Modify: `tests/public-release-policy.test.mjs`
- Modify: `tests/integration-contract.test.mjs`

**Interfaces:**
- The resolver must hash `src/image-identity.mjs`, `scripts/write-image-identity.mjs`, `src/device-evidence.mjs`, `scripts/collect-device-evidence.sh`, `scripts/render-device-evidence.mjs`, `scripts/validate-device-evidence.mjs`, `scripts/render-device-validation-summary.mjs`, both workflows, and both new test-facing configuration/doc files where repository policy requires them.
- New manifests carry the identity writer marker and therefore require `imageIdentity` in the raw validation report.

- [ ] **Step 1: Add failing fingerprint and documentation assertions.** Assert every new source/workflow path appears in resolver `recipeFiles`, `evidence/` is allowed by repository policy, README states the non-`burn.img` boundary and manual verification command, and historical fixtures without the marker remain accepted.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run: `pnpm test -- tests/repository-policy.test.mjs tests/public-release-policy.test.mjs tests/integration-contract.test.mjs`

Expected: FAIL for missing recipe paths and documentation/workflow contracts.

- [ ] **Step 3: Update resolver and documentation.** Keep path ordering deterministic. State that the next fingerprint-changing build is the first evidence-eligible Release, that original status remains immutable, and that early vendor bootloader text is outside the pure Armbian image.

- [ ] **Step 4: Update optional Release asset policy.** Permit only the three 16-hex evidence asset patterns in `src/change-detection.mjs`; retain rejection of every other unexpected asset. Ensure `scripts/audit-public-releases.sh` downloads and validates the mandatory static assets without requiring optional evidence assets.

- [ ] **Step 5: Run the complete local gate.**

Run: `pnpm check && git diff --check`

Expected: all Node tests and Bash syntax checks pass, with no whitespace errors.

- [ ] **Step 6: Inspect the diff and commit.**

```bash
git status --short
git diff --stat HEAD~5..HEAD
git add scripts/resolve-sources.mjs README.md evidence/.gitkeep docs/device-validation.md tests/repository-policy.test.mjs tests/public-release-policy.test.mjs tests/integration-contract.test.mjs
git commit -S -m 'docs(validation): 记录实机证据使用方式'
```

---

### Task 7: Cloud integration and publication checks

**Files:**
- Verify all changed files and GitHub Actions state.

- [ ] **Step 1: Run the full local gate on the final branch.**

Run: `pnpm check && git diff --check && git status --short --branch`

Expected: zero test failures, zero shell syntax failures, and only intended commits.

- [ ] **Step 2: Push the signed branch and open a PR.**

```bash
git push --set-upstream origin codex/device-validation-evidence
gh pr create --base main --head codex/device-validation-evidence --title 'feat(validation): 增加 B860 实机证据流程' --body-file docs/device-validation.md
```

Expected: a PR with read-only PR evidence checks and the existing CI checks.

- [ ] **Step 3: Wait for and inspect every PR check.**

Run: `PR_NUMBER=$(gh pr list --head codex/device-validation-evidence --state open --json number --jq '.[0].number'); gh pr checks --watch "$PR_NUMBER"`

Expected: all checks pass; any failure is fixed on the branch before merge.

- [ ] **Step 4: Merge only after checks pass and inspect `main`.**

Run: `PR_NUMBER=$(gh pr list --head codex/device-validation-evidence --state open --json number --jq '.[0].number'); gh pr merge "$PR_NUMBER" --squash --delete-branch`

Expected: the merge commit is on `main`, and the repository remains public with no generated binary committed.

- [ ] **Step 5: Force one weekly workflow run.**

Run: `gh workflow run weekly-build.yml --field force=true`

Expected: detect, build, validate, and publish all succeed; the new Release tag exposes the Armbian version, full Debian version/codename, kernel version, run, and attempt; Release assets include the identity-aware schema-8 report.

- [ ] **Step 6: Run the unchanged-fingerprint regression.**

Run: `gh workflow run weekly-build.yml --field force=false`

Expected: detect succeeds, and build, validate, and publish are skipped.

- [ ] **Step 7: Verify failure isolation.**

Run the PR fixture tests and inspect the manual workflow source for the absence of any Release mutation before the final upload. Do not mark hardware verified: no physical-device evidence exists in this workspace.

---

## Plan Self-Review

- Identity, evidence, redaction, Release binding, workflow permissions, failure policy, fingerprinting, documentation, and cloud verification each have an explicit task.
- Historical schema-8 compatibility is covered by conditional recipe markers in Tasks 1, 4, and 6.
- The collector's `B860_DEVICE_READY` challenge is defined identically in Tasks 2 and 3.
- The workflow uses two jobs because GitHub Actions permissions cannot be escalated safely within a single job step.
- No task claims real hardware success; Task 7 explicitly leaves the goal active until a physical device supplies evidence.
