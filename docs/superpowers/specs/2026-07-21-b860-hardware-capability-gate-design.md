# B860AV1.1-T Hardware Capability Gate Design

## Goal

Fail the trusted GitHub Actions validation job unless the built image's active
kernel configuration and active DTB contain the static prerequisites for the
B860AV1.1-T eMMC, Ethernet, HDMI, infrared, USB, and RTL8189FTV paths.

The result remains `container-valid / hardware-unverified`. Static evidence is
not a substitute for a serial-console boot test on the real device.

## Compatibility

Validation report schema 8 remains current. A manifest requires the new gate
only when `recipe.files` contains `config/hardware-capabilities.json`. Existing
schema 8 releases without that recipe marker remain auditable; every manifest
resolved from the new repository revision includes the marker and therefore
must include the new evidence.

## Recipe

`config/hardware-capabilities.json` is a declarative, fingerprinted recipe. It
defines the required kernel symbols and DTB property checks for six named
capabilities. The source resolver hashes the recipe, evaluator, CLI, raw image
validator, candidate validator, release policy, and workflow into the build
manifest, so any validation change produces a new build fingerprint.

The required kernel symbols are:

- eMMC: `CONFIG_MMC_MESON_GX=y`
- Ethernet: `CONFIG_STMMAC_ETH=y`, `CONFIG_DWMAC_MESON=y`, `CONFIG_MESON_GXL_PHY=y`
- HDMI: `CONFIG_DRM_DW_HDMI=y`, `CONFIG_DRM_MESON=y`, `CONFIG_DRM_MESON_DW_HDMI=y`
- Infrared: `CONFIG_IR_MESON=m`
- USB: `CONFIG_PHY_MESON_GXL_USB2=y`
- Wi-Fi: the existing RTL8189FS module gate plus DTB checks

The active DTB must pass these checks:

- eMMC `/soc/apb@d0000000/mmc@74000`: enabled, 8-bit, 200 MHz,
  non-removable, MMC high-speed, DDR 1.8 V, and HS200 1.8 V.
- Ethernet `/soc/ethernet@c9410000`: enabled, RMII, and a PHY handle.
- HDMI `/soc/hdmi-tx@c883a000` and `/hdmi-connector`: enabled, supplied,
  and a type-A HDMI connector.
- Infrared `/soc/bus@c8100000/ir@580`: enabled with pin control.
- USB `/soc/usb@d0078080`: enabled, host mode, and PHY references.
- Wi-Fi `/soc/apb@d0000000/mmc@70000/wifi@1`, its MMC parent, and
  `/sdio-pwrseq`: RTL8189FTV compatible, 200 MHz, reset GPIO cell `0x4c`.

## Evidence Flow

The trusted validation job mounts the root and boot partitions. It derives the
running kernel release from the QEMU system smoke result, then reads
`usr/src/linux-headers-<release>/include/config/auto.conf` from the rootfs. This
generated file represents the configuration used by the installed kernel.

`scripts/validate-hardware-capabilities.mjs` evaluates the kernel configuration
and active DTB using `fdtget`. It writes `hardware-capabilities.json` only after
all checks pass. The evidence records:

- recipe path and SHA-256;
- kernel release, generated configuration path and SHA-256;
- active DTB path and SHA-256;
- the RTL8189FS evidence SHA-256;
- every expected and observed value, grouped by capability.

The generated configuration digest must appear exactly once in
`filesystem-manifest.sha256`. The DTB path and digest must match exactly one
`dtb` entry in `boot-components.json`. The Wi-Fi driver digest and kernel
release must match `rtl8189fs-driver.json`.

## Publication Gate

`validation-report.json` adds the `hardwareCapabilities` evidence name and
digest plus a `hardwareCapabilities: true` check. Candidate validation repeats
all cross-file bindings before publication. The workflow uploads and publishes
`hardware-capabilities.json`, and the server-side Release validator requires
its digest to match the report before the draft is made public.

Any missing symbol, DTB property, evidence file, digest binding, or capability
result exits non-zero. Build and publication therefore stop in the trusted
validation job or draft Release stage.

## Testing

Unit tests cover recipe validation, kernel parsing, all six capability results,
negative kernel and DTB cases, filesystem-manifest binding, boot-component
binding, and historical schema 8 compatibility. Contract tests cover the raw
validator, source fingerprint, workflow artifact lists, Release validation,
and candidate tamper rejection. `pnpm check` remains the local gate; GitHub CI
and a forced weekly workflow run provide the Linux integration gate.
