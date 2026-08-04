# B860AV1.1-T device evidence

The published image remains a raw `.img.gz` Armbian image. It is not an
Amlogic USB Burning Tool `burn.img`, and the evidence process does not add a
vendor Android boot chain.

The collector is read-only. It checks the running image identity, kernel
release, eMMC, Ethernet, HDMI, infrared, USB, and RTL8189FTV Wi-Fi. It writes
only a sanitized serial log and a JSON report below the output directory. It
does not write to a block device, change boot configuration, or install
packages.

## Collection

Download the five small evidence assets for the exact Release. The image is
not downloaded:

```bash
repo='wuhao1477/b860av1-t-armbian-builder'
tag='armbian-26.08.0-debian-13.6-trixie-k5.10.260-build-37.1'
assets_dir="release-assets/$tag"
mkdir -p "$assets_dir"
gh release download "$tag" --repo "$repo" --dir "$assets_dir" \
  --pattern resolved-sources.json \
  --pattern validation-report.json \
  --pattern filesystem-manifest.sha256 \
  --pattern release-tag.txt \
  --pattern qemu-system-smoke.json
node scripts/generate-release-metadata.mjs \
  --assets "$assets_dir" \
  --output release-metadata.json
```

The generator validates the manifest, report, tag, QEMU kernel evidence, raw
image binding, and the unique image-identity checksum before writing metadata.

Run the collector from a checkout containing this script. The serial capture
must start before reset and continue through the Linux readiness marker:

```bash
sudo scripts/collect-device-evidence.sh \
  --release-metadata release-metadata.json \
  --output /path/device-evidence \
  --serial-log /path/device-serial.log \
  --health-endpoint https://example.invalid/health \
  --hdmi-visible \
  --infrared-key-seen \
  --usb-vendor-id abcd \
  --usb-product-id 1234
```

The collector prints one `B860_DEVICE_READY` challenge line to the serial
console. The renderer normalizes line endings and replaces network and secret
identifiers before writing `device-serial.log`.

## Trust boundary

The resulting report is an operator-supplied attestation for one physical
device and one published Release. It binds the report to the image manifest,
identity file, active boot files, collector commit, and serial challenge, but
it is not remote cryptographic hardware attestation. The static Release report
therefore stays `container-valid / hardware-unverified`; a separately
published evidence asset may add only `operator-attested / one-device`.

## Submission and publication

Place the two generated files at
`evidence/<release-tag>/<evidence-id>/`. A pull request touching that path runs
the read-only `device-evidence-pr.yml` validator. After the pull request is
reviewed, a maintainer revalidates and publishes uniquely named Release assets:

```bash
gh workflow run verify-device.yml \
  -f release_tag='<release-tag>' \
  -f evidence_path='evidence/<release-tag>/<evidence-id>' \
  -f confirmation=verify
```

The manual workflow has separate validation and publication jobs. Validation
has read-only repository permission. Publication runs only after validation,
refuses existing asset names, and never replaces the image or static report.
