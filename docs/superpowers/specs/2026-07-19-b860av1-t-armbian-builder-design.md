# B860AV1.1-T Armbian Builder Design

> Historical design. The current implementation follows Debian stable dynamically
> and uses the repository-owned `b860av1-t` profile. See the current README and
> release schemas for the authoritative behavior.

Date: 2026-07-19

## Goal

Create a public, reproducible GitHub Actions project that checks upstream sources once every seven days and builds a Debian Trixie Armbian candidate for the ZTE ZXV10 B860AV1.1-T only when the resolved inputs change.

## Confirmed Constraints

- The repository, source code, build logs, manifests, and releasable artifacts are public.
- Heavy image work runs on GitHub-hosted Ubuntu runners, not on the local Mac or OrbStack.
- The scheduled check uses `23 3 * * 1` and always runs only the lightweight detector first.
- A 42-day heartbeat commit, excluded from the recipe fingerprint, prevents GitHub's 60-day public-repository inactivity rule from disabling the schedule.
- An unchanged upstream fingerprint skips every image build and release job.
- A failed build does not advance release state, so the same fingerprint is retried at the next scheduled check.
- Debian Trixie is the only distribution target.
- The legacy Amlogic kernel line is `5.10.y`; the newest numeric patch release is selected.
- The current board profile is the repository-owned `b860av1-t`, and remains explicitly unverified on B860AV1.1-T hardware.
- No Android `system`, APK, launcher, logo, or recovery payload belongs in a Linux release.
- No vendor BL2, BL30, BL301, DDR, FIP, factory U-Boot, original DTB, or derived image containing those files is published without verified redistribution permission.

## Architecture

The repository has a lightweight control plane and a Linux image build plane.

The control plane is dependency-free Node.js. It reads GitHub release and commit metadata, deterministically selects the latest Trixie base image and latest `5.10.y` kernel, records exact URLs and SHA-256 digests, and hashes the canonical result. It compares that fingerprint with `resolved-sources.json` from the latest successful repository release. A missing release, changed fingerprint, or manual `force=true` starts the build.

The build plane checks out exact resolved ophub commits, verifies the downloaded base image, removes the non-redistributable embedded R3300L bootloader input and legacy platform `u-boot.sd`/`u-boot.usb` payloads, and invokes ophub's `rebuild` for the manifest board profile with the exact resolved kernel. A post-build sanitizer clears the generic MBR bootstrap and the complete pre-partition gap while preserving the disk signature and partition table. The resulting image is passed to a separate validation runner, which checks the compressed image, MBR layout, empty persistent-bootloader region, active boot files, ARM64 kernel, target DTB, Debian identity, package state, essential services, filesystem, checksums, media size, and prohibited Android user-space paths using a fresh trusted checkout. Only that validated artifact can reach the prerelease. The release is a hardware candidate until serial-console evidence passes the documented boot test.

## Burn Image Boundary

`Amlogic_USB_Burning_Tool` needs board-specific DDR/USB U-Boot and persistent bootloader items in addition to Linux. Mainline U-Boot v2026.07 still lacks a complete GXL USB factory-burn path, while GXL TF-A still requires BL30/BL301 SCP firmware. The public sources found for those binaries do not provide a reliable redistribution grant.

The public repository therefore does not contain a compatibility assembler and does not generate `burn.img` or Android boot-v0 containers. Its raw image deliberately omits persistent MBR bootloader data and legacy platform U-Boot payloads, while retaining only the FAT overload needed by an existing compatible stock boot chain. A direct USB Burning Tool image remains out of scope until a complete redistributable open GXL factory-burn boot chain exists.

## Data Flow

1. The weekly detector queries upstream metadata and writes canonical `resolved-sources.json`.
2. The detector downloads the previous successful manifest, when one exists, and compares fingerprints.
3. When unchanged, the workflow ends after the detector job.
4. When changed, the build job downloads and verifies the generic Armbian input, then rebuilds the selected board image in GitHub Actions and uploads only an unvalidated candidate artifact.
5. A separate validation job downloads that candidate, verifies the manifest fingerprint, runs the trusted static checks, and produces `validation-report.json`, `SHA256SUMS`, and a release note fragment.
6. A prerelease is created only from the validated artifact and all provenance files. Its tag contains the Armbian version, Debian codename, kernel version, workflow run number, and run attempt so one upstream version may be built repeatedly without overwriting history. That release manifest becomes the comparison state for the next run.

## Failure Handling

- GitHub API errors, ambiguous asset selection, missing digests, digest mismatches, and malformed prior manifests fail before the image build.
- The detector never treats an API failure as "no change".
- Static validation failure blocks publication.
- A failed build leaves the previous release untouched and is retried automatically.
- Workflow permissions are minimal: read contents by default, with `contents: write` only on publication and the infrequent schedule-heartbeat job.
- Concurrency prevents two scheduled builds from publishing the same fingerprint.

## Testing

- Unit tests use recorded synthetic API fixtures for release ordering, semantic kernel ordering, asset ambiguity, digest normalization, and canonical fingerprint stability.
- Workflow contract tests parse the YAML as text and assert the seven-day cron, build condition, permissions, timeout, and absence of unpinned mutable build inputs.
- The cloud build performs gzip, MBR, empty bootloader-region, partition, filesystem, Debian identity, QEMU user-space and system-boot smoke tests, service, package-state, kernel, active boot configuration, DTB, prohibited-path, checksum, media-size, and provenance checks.
- Only a real device test with full serial output can promote a candidate from `container-valid` to `hardware-validated`.

## Release Status

The initial public status is `container-valid / hardware-unverified`. The README and every release must use this wording until the hardware gate is passed.
