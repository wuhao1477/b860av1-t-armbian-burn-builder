# Third-party source availability

This document accompanies every schema 8 release. The project repository is
source-only and does not contain vendor DDR, BL2, BL30/BL301, factory U-Boot,
Android system, recovery, APK, or Amlogic USB Burning Tool payloads.

## Exact release inputs

`resolved-sources.json` records the exact Armbian base asset URL, size and
SHA-256, kernel package URL, size and SHA-256, builder commit, upstream U-Boot
commit, Debian signed-release digest, board configuration, and every build
recipe file digest. `build-input-heads.json` repeats the build-time source
heads. These files are release assets and are validated before publication.

## U-Boot

The FAT overload is compiled from the U-Boot commit and patch named in
`resolved-sources.json`. Every release includes `u-boot-source.tar.gz`, the
complete patched source tree used by the independent validation build, plus
`uboot-build.json` with the archive, source-tree, configuration, and output
digests. U-Boot remains under GPL-2.0-or-later.

## Repair device tree

The B860AV1.1-T repair DTB is compiled from the MIT-licensed
`S-9527/meson-gxl-s905x-p212` source path recorded in `resolved-sources.json`.
The raw source URL, exact commit, SHA-256, `dtc` recipe, source copy and build
summary are published as `device-tree-source.dts` and `source-built-dtb.json`.

## Armbian and image builder

The base image and rebuild logic come from
<https://github.com/ophub/amlogic-s9xxx-armbian>, licensed by that project
under GPL-2.0. The exact builder commit is in `resolved-sources.json`. The base
image asset is also identified by an immutable SHA-256 digest.

## Linux kernel

The selected binary kernel package comes from
<https://github.com/ophub/kernel>, whose GPL-2.0 source documentation identifies
<https://github.com/unifreq/linux-5.10.y> and
<https://github.com/ophub/linux-5.10.y> as the 5.10 source trees and publishes
the build configuration under `kernel-config/release/stable/config-5.10`.
The exact package version and digest are in `resolved-sources.json`.

For the B860 candidate, independent validation requires the packaged ARM64
`8189fs.ko` to match the selected kernel vermagic and to expose SDIO ID
`024c:F179` through both module metadata and `modules.alias`. The resulting
metadata is published as `rtl8189fs-driver.json`. This proves packaging and
autoload metadata, not a successful connection on real hardware.

The upstream kernel release currently does not publish an immutable mapping
from each binary asset to a source commit and complete build environment. This
project therefore does not claim bit-for-bit kernel reproducibility. That
limitation is explicit instead of being replaced by an unverified provenance
claim.

## Public release policy

The weekly detector audits every non-draft `armbian-*` Release before it
compares fingerprints. Public releases must be prereleases using manifest schema 5 and
validation-report schema 8, carry source-built U-Boot and DTB evidence, pass the
QEMU system smoke test with its JSON and console log, carry the RTL8189FS
driver evidence when the build recipe requires it, have empty Android findings,
and contain exactly one B860 Armbian `.img.gz`. A
historical release with a prebuilt vendor overload or an Android fallback is a
detector failure and must not remain public. Schema 7 releases from the
pre-QEMU transition are also retired before the first schema 8 build.

## Debian packages and firmware

Debian package sources are available from Debian source archives and
<https://snapshot.debian.org/> using the package versions recorded inside the
validated root filesystem. Linux firmware is inherited from the verified
Armbian base image; this project does not clone or add the `ophub/firmware`
binary bundle. Individual firmware and package license terms continue to
apply and are not replaced by this repository's MIT license.
