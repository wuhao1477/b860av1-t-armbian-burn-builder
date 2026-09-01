# Debian Stable Tracking Design

Date: 2026-07-20

## Goal

Make the weekly workflow follow Debian's current stable major release and the
matching ophub Armbian server image without weakening the existing build,
validation, or publication gates.

## Decision

The detector will read the fixed Debian official
`https://deb.debian.org/debian/dists/stable/InRelease` URL, verify its OpenPGP
signature with `debian-archive-keyring`, and extract the numeric version and
codename. The signed metadata must identify Debian/stable and list both the
`arm64` architecture and `main` component. The resolver then requires a
published ophub Armbian release and asset for that exact codename and `arm64`
server flavor.

The workflow fails closed when the Debian signature is invalid, metadata is
malformed, the codename is unsafe, or ophub has not published a matching image.
It does not fall back to an older Debian release.

## Components

- `src/debian-release.mjs` parses and validates Debian `InRelease` metadata and
  validates the normalized JSON contract consumed by the resolver.
- `scripts/resolve-debian-stable.mjs` converts an already verified `InRelease`
  file into canonical JSON with the source URL and SHA-256.
- `scripts/resolve-sources.mjs` consumes that JSON, generates codename-specific
  ophub release and asset patterns, and records the Debian source in the build
  manifest.
- The detector installs `gpgv` and `debian-archive-keyring`, downloads the
  configured HTTPS URL with bounded retries, verifies the signature, and only
  then invokes the parser and source resolver.
- The raw-image validator reads the expected Debian codename and major version
  from the signed manifest instead of hard-coding Trixie.

## Manifest And Release Contract

Manifest schema 3 adds `sources.debian` with the signed metadata source URL,
content digest, suite, full version, major version, codename, and release date.
The board's `distribution` and `distributionVersion` are derived from this
record. Older schema 1 and 2 releases remain readable for migration.

Validation report schema 5 replaces the Trixie-specific check with
`debianStableRelease`. For schema 3 manifests, release tags expose the complete
Debian stable point version. Older manifests keep their existing major-version
format:

`armbian-<armbian>-debian-<full-version>-<codename>-k<kernel>-build-<run>.<attempt>`

A Debian point release changes the signed metadata digest and therefore the
fingerprint. This is treated as a real upstream update; repeated builds remain
distinguishable by the workflow run and attempt suffix.

## Error Handling

- Network failures use bounded retries and eventually fail the detector.
- Signature verification requires at least one trusted full-fingerprint
  `VALIDSIG`; unknown parallel signatures do not invalidate a trusted signature.
  A missing trusted signature or schema failure stops before heavy jobs.
- The Ubuntu keyring may lag a new parallel Debian signing key. The detector
  accepts a trusted signature already present in that keyring and otherwise
  fails closed; it never treats an unknown signature as trusted.
- Missing matching ophub assets stop before any heavy build job.
- A root filesystem whose Debian codename or major version differs from the
  signed manifest fails independent validation and cannot be published.
- Existing complete prereleases continue to be the only accepted comparison
  state; drafts and incomplete releases remain excluded.

## Tests

- Unit tests cover valid and malformed `InRelease` data, unsafe codenames, and
  normalized contract validation.
- Resolver integration tests cover a future Debian stable codename and exact
  selection of the matching ophub image.
- Validator contract tests require manifest-driven codename and major checks.
- Workflow tests require OpenPGP verification before source resolution.
- Existing release compatibility, Android exclusion, publication, and
  no-change gating tests continue to pass.

## Out Of Scope

This change does not create an Amlogic USB Burning Tool package and does not
change the `hardware-unverified` status. A B860AV1.1-T-specific DDR/BL30/BL301
boot chain and real-device serial-console evidence are still unavailable.
