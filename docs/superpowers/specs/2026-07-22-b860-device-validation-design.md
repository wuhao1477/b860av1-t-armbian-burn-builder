# B860AV1.1-T Real-Device Validation Design

## Goal

Add a separately reviewed real-device evidence path for the public raw Armbian
image produced for `ZXV10 B860AV1.1-T`. The path must show that one physical
device booted one identified Release and that the eMMC, Ethernet, HDMI,
infrared, USB, and RTL8189FTV Wi-Fi paths were exercised.

This is evidence for this board and this build, not a claim that every
B860AV1.1-T hardware batch is compatible. The immutable image report retains
the status `container-valid / hardware-unverified`; a separately published
device-evidence asset adds the narrower status `operator-attested / one-device`
for that exact build. The project continues to publish raw Armbian images only;
this design does not create an Amlogic USB Burning Tool `burn.img` or add
Android boot files.

## Trust Boundary

The collector runs on a device controlled by the operator, so its output is
an operator-supplied attestation rather than cryptographic remote attestation.
The validator can prove that the JSON is well formed, bound to a published
Release, internally consistent, and accompanied by a serial log with the
required boot facts. It cannot prove that a person did not alter the device,
log, or JSON before submitting the PR. The Release notes must describe this
limitation explicitly.

Static image validation and real-device validation are independent gates:

1. Build and candidate validation continue to produce a raw image and a
   schema 8 report with status `container-valid / hardware-unverified`.
2. A device operator submits evidence for a specific existing prerelease.
3. PR CI validates the evidence without changing any Release.
4. A maintainer manually runs `verify-device.yml`, which downloads and
   validates the same Release again.
5. Only after the second validation succeeds does the workflow upload
   hardware evidence assets to that prerelease. A failure never edits or
   deletes a Release asset.

## Release Identity

The build job adds a repository-owned identity file to the root filesystem at
`/usr/lib/b860av1-t/image-identity.json` before the image is compressed. It
contains no secret and has this schema:

```json
{
  "schemaVersion": 1,
  "boardProfile": "b860av1-t",
  "manifestFingerprint": "<64 lowercase hex>",
  "kernelVersion": "<manifest sources.kernel.version>",
  "kernelRelease": "<installed uname -r>",
  "identityPath": "/usr/lib/b860av1-t/image-identity.json"
}
```

The compressed image digest is deliberately not embedded: embedding it would
change the image and make the digest self-referential. The operator supplies
the Release tag, image name, compressed image SHA-256, and raw-image SHA-256;
the validator obtains the authoritative values from the Release's existing
`SHA256SUMS`, `resolved-sources.json`, and `validation-report.json` assets.

The identity file is included in `filesystem-manifest.sha256`, so a device
report can also bind its recorded identity-file digest to the published image
without hashing a modified post-boot disk.

The current `build-35.1` Release predates this identity file and cannot be
retrofitted. Adding the file changes the repository recipe fingerprint, so the
next successful weekly build becomes the first eligible Release for this
evidence workflow.

## Evidence Artifacts

Evidence is stored in the repository under
`evidence/<release-tag>/<evidence-id>/`:

- `device-validation.json` is the structured report.
- `device-serial.log` is the complete serial capture from power-on through the
  Linux login prompt or shell marker, with sensitive values redacted.

`evidence-id` is exactly 16 lowercase hexadecimal characters. The JSON schema
version is 1 and requires:

```json
{
  "schemaVersion": 1,
  "status": "passed",
  "evidenceId": "<16 lowercase hex>",
  "collectedAt": "<RFC 3339 UTC timestamp>",
  "board": {
    "profile": "b860av1-t",
    "declaredModel": "ZXV10 B860AV1.1-T",
    "observedModel": "<device-tree model>",
    "compatible": ["<observed compatible strings>"]
  },
  "release": {
    "repository": "wuhao1477/b860av1-t-armbian-builder",
    "tag": "<existing armbian-* tag>",
    "image": "<exact .img.gz asset name>",
    "imageSha256": "<64 lowercase hex>",
    "rawSha256": "<64 lowercase hex>",
    "manifestFingerprint": "<64 lowercase hex>"
  },
  "identity": {
    "path": "/usr/lib/b860av1-t/image-identity.json",
    "sha256": "<64 lowercase hex>",
    "manifestFingerprint": "<same fingerprint>",
    "kernelVersion": "<same manifest kernel version>",
    "kernelRelease": "<same release as uname -r>"
  },
  "collector": {
    "repository": "wuhao1477/b860av1-t-armbian-builder",
    "commit": "<40 lowercase hex>",
    "scriptPath": "scripts/collect-device-evidence.sh",
    "scriptSha256": "<64 lowercase hex>"
  },
  "boot": {
    "kernelRelease": "<same release as uname -r>",
    "components": [
      {
        "role": "<kernel, initrd, dtb, or boot-config>",
        "path": "<safe path below /boot>",
        "sha256": "<64 lowercase hex>"
      }
    ]
  },
  "serial": {
    "asset": "device-serial.log",
    "sha256": "<64 lowercase hex>",
    "bootFromPowerOn": true,
    "linuxReady": true,
    "androidMarkersAbsent": true
  },
  "capabilities": {
    "emmc": { "passed": true },
    "ethernet": { "passed": true },
    "hdmi": { "passed": true },
    "infrared": { "passed": true },
    "usb": { "passed": true },
    "wifi": { "passed": true }
  }
}
```

The implementation may add bounded, non-sensitive observations beneath each
capability. It must not add MAC addresses, IP addresses, SSIDs, EDID bytes,
eMMC CIDs, USB serial numbers, filesystem UUIDs, passwords, tokens, or raw
environment variables. The evidence ID is generated from eight random bytes;
no operator identity is collected.

## Device Collector

`scripts/collect-device-evidence.sh` is a root-capable, read-only collector.
It receives the Release metadata values and an output directory, then writes
the JSON and a sanitized command transcript. It never writes to a block
device, changes boot configuration, enables a service, or installs a package.
The script records its own repository commit and SHA-256 and exits non-zero if
any required check is missing. At the end it prints exactly one
`B860_DEVICE_READY <evidence-id> <manifest-fingerprint> <kernel-release>`
challenge line to `/dev/console`; the serial capture must contain that exact
line, binding the log and JSON to the same live collection session.

The checks are:

- **Serial boot:** the separately captured log starts before reset, contains
  the expected kernel release, rootfs/Armbian readiness, and collector
  challenge. After the Linux kernel handoff it contains no Android kernel,
  init, filesystem, or stock fallback execution marker. Text printed earlier
  by the device's pre-existing vendor bootloader is outside the built image and
  is reported separately rather than treated as Armbian image content.
- **eMMC:** an MMC block device is present, the running root source is
  identified, capacity can be read, and a bounded read-only sector check
  succeeds. No write or partition-table mutation is allowed.
- **Ethernet:** a target interface reports carrier/link and a bounded network
  connectivity check succeeds. MAC and address values are omitted.
- **HDMI:** a DRM connector reports `connected`, an EDID hash can be recorded
  without retaining EDID bytes, and the operator confirms that the expected
  Linux display is visible.
- **Infrared:** the Meson IR/input device is present and one operator key
  press is observed through the kernel input interface.
- **USB:** a host controller and PHY are present, and an operator attaches any
  USB peripheral whose hotplug and public descriptor fields are detected. A
  storage peripheral receives a bounded read-only sector check; storage is not
  required and USB serial fields are never retained.
- **Wi-Fi:** the RTL8189FTV interface is present, associates successfully, and
  completes a bounded connectivity check. SSID, MAC, and addresses are not
  retained.

The collector must support an explicit non-interactive mode for repeatable CI
tests, but that mode still requires supplied observations for HDMI, infrared,
and USB; it cannot silently mark those capabilities as passed.

## Redaction and Serial Parsing

Redaction occurs before files are written. It replaces IPv4/IPv6 addresses,
MAC addresses, SSIDs, UUIDs, eMMC CID values, USB serial fields, shell tokens,
and values matching common secret-key names with `[REDACTED]`. Output is
limited to 2 MiB per log and uses UTF-8 with normalized LF line endings.

`src/device-evidence.mjs` owns the canonical parser and schema checks. It
accepts CR, LF, or CRLF serial lines, requires exactly one collector challenge,
requires the recorded kernel release, and rejects post-kernel-handoff Android
execution markers including `boot_android`, `storeboot`, and
`start_emmc_autoscript`. Pre-handoff vendor lines are retained in a separately
labelled section so they cannot be confused with content supplied by this
project. The parser also rejects control characters other than tab, LF, and
CR. The validator recomputes the serial-log SHA-256 after redaction.

## PR Validation

`scripts/validate-device-evidence.mjs` accepts an evidence directory and a
local directory containing the downloaded Release assets. It performs these
checks before any publication:

- safe evidence paths and exactly one JSON/log pair;
- schema, lowercase digest, tag, board profile, and repository validation;
- existing non-draft prerelease and exact Release asset metadata;
- manifest fingerprint, Debian/Armbian/kernel identity, image and raw-image
  digests, and `SHA256SUMS` binding;
- identity-file fields and digest against `filesystem-manifest.sha256`;
- active kernel, initrd, DTB, and boot-component digests against
  `boot-components.json` and the release report;
- collector commit/path/digest against the recorded ancestor commit, using the
  exact Git blob rather than the current working-tree copy;
- serial-log parser result and redaction scan;
- all six capability results and their required non-sensitive observations.

The PR workflow runs this validator on Ubuntu with the same Node version and
the existing Release audit helpers. It reports a compact summary in the job
summary and never uploads evidence.

## Manual Publication Workflow

`.github/workflows/verify-device.yml` is `workflow_dispatch` only. Inputs are
the Release tag, evidence path, and an explicit confirmation value. A first
job has `contents: read`, checks out full Git history, downloads the Release
assets, and runs the validator a second time. A dependent publication job has
`contents: write`, downloads only the already validated workflow artifact,
verifies its digest again, checks that none of the target names already exist,
and then uploads these unique assets without replacing existing ones:

- `device-validation-<evidence-id>.json`
- `device-serial-<evidence-id>.log`
- `device-validation-<evidence-id>.md`

The generated Markdown states the exact tag, image digest, manifest
fingerprint, kernel release, evidence ID, test date, and the operator-attested
trust limitation. The workflow does not alter `validation-report.json`, the
image, or the original Release status. Any validation or upload-precondition
failure exits before the upload command and leaves the Release unchanged.

## Testing

Unit tests cover identity parsing, digest and path validation, serial CR/LF
handling, Android-marker rejection, redaction, capability completeness, and
tampered Release bindings. Shell tests run the collector against a synthetic
sysfs/proc fixture and verify that it performs no writes.

Workflow contract tests require the PR trigger, manual-only publication,
read-only collection, download-before-validate ordering, unique asset names,
and the no-mutation-on-failure behavior. `pnpm check` remains the local gate;
the manual workflow is the Linux integration gate for a submitted device.

## Failure Policy

Missing serial evidence, any failed capability, an identity mismatch, a
post-handoff Android execution marker, a redaction failure, an unavailable or
mutated Release, or a digest mismatch is a hard failure. Failed evidence is
not merged as a passing report and does not modify a Release. A complete,
manually published evidence set adds only the separate
`operator-attested / one-device` result; the original static report stays
immutable.

## Out of Scope

- Packaging or flashing `burn.img`.
- Replacing vendor BL2/BL30/BL301, DDR initialization, or eMMC bootloader.
- Automatic claims for other B860AV1.1-T batches.
- Collecting or publishing personal network identifiers or device secrets.
- Treating a self-submitted log as a cryptographic hardware attestation.
