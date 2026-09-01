# Release Metadata Generator Design

## Goal

Generate the `release-metadata.json` consumed by `scripts/collect-device-evidence.sh` from small, published Release evidence assets. The operator must not manually transcribe hashes or download the large `.img.gz` asset.

## Inputs

The CLI accepts a directory containing exactly the required named inputs:

- `resolved-sources.json`
- `validation-report.json`
- `filesystem-manifest.sha256`
- `release-tag.txt`
- `qemu-system-smoke.json`

The directory may contain other downloaded Release assets. The generator reads only the five files above.

## Validation

The core module validates the manifest and report with the repository's existing published-state validator. It then requires a B860 profile, current image-identity validation, a B860 Armbian image name, and a release tag derived from the manifest plus the build numbers embedded in the tag.

The SHA-256 of `filesystem-manifest.sha256` and `qemu-system-smoke.json` must match the digests recorded in `validation-report.json`. The QEMU evidence must be passed, bound to the same manifest fingerprint and raw image digest, and report a kernel release prefixed by the manifest kernel version.

The filesystem manifest must contain exactly one checksum entry for `./usr/lib/b860av1-t/image-identity.json`. Missing, duplicated, malformed, or mismatched entries are rejected.

## Output

The output is deterministic, pretty-printed JSON with the nine fields already required by the collector:

- `repository`
- `tag`
- `image`
- `imageSha256`
- `rawSha256`
- `manifestFingerprint`
- `kernelVersion`
- `kernelRelease`
- `identitySha256`

The CLI writes the file named by `--output`. Errors go to stderr and produce a non-zero exit status.

## Repository Integration

The implementation is split into `src/release-metadata.mjs` for validation and derivation and `scripts/generate-release-metadata.mjs` for filesystem and CLI handling. Both files are added to the build recipe fingerprint. `docs/device-validation.md` documents downloading only the five small assets and running the generator before evidence collection.

## Testing

Unit tests cover successful derivation and rejection of a mismatched tag, local asset digest, QEMU binding, and missing or duplicate identity entries. A CLI test verifies deterministic file output. The full repository test and shell syntax suite remains the final gate.
