import fs from 'node:fs';
import path from 'node:path';

const [manifestPath, reportPath, outputPath, releaseTag] = process.argv.slice(2);
if (!manifestPath || !reportPath) {
  console.error('usage: render-release-notes.mjs resolved-sources.json validation-report.json [output.md]');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const ubootBuildPath = path.join(path.dirname(reportPath), report.evidence?.ubootBuild ?? 'uboot-build.json');
const ubootBuild = JSON.parse(fs.readFileSync(ubootBuildPath, 'utf8'));
const dtbEvidence = report.schemaVersion >= 7 ? report.evidence?.sourceBuiltDeviceTree : null;
const dtbBuildPath = dtbEvidence?.build ? path.join(path.dirname(reportPath), dtbEvidence.build) : null;
const dtbBuild = dtbBuildPath && fs.existsSync(dtbBuildPath)
  ? JSON.parse(fs.readFileSync(dtbBuildPath, 'utf8'))
  : null;
const hasSourceBuiltDtbEvidence = report.schemaVersion >= 7 && Boolean(dtbEvidence && dtbBuild);
const qemuEvidence = report.schemaVersion >= 8 ? report.evidence?.qemuSystemSmoke : null;
const hasQemuSystemEvidence = report.schemaVersion >= 8 && qemuEvidence === 'qemu-system-smoke.json'
  && report.evidence?.qemuSystemConsole === 'qemu-system-smoke.log';
const rtl8189fsPath = report.evidence?.rtl8189fsDriver
  ? path.join(path.dirname(reportPath), report.evidence.rtl8189fsDriver)
  : null;
const rtl8189fs = rtl8189fsPath && fs.existsSync(rtl8189fsPath)
  ? JSON.parse(fs.readFileSync(rtl8189fsPath, 'utf8'))
  : null;
const hardwarePath = report.evidence?.hardwareCapabilities
  ? path.join(path.dirname(reportPath), report.evidence.hardwareCapabilities)
  : null;
const hardware = hardwarePath ? JSON.parse(fs.readFileSync(hardwarePath, 'utf8')) : null;
const hardwareNames = ['emmc', 'ethernet', 'hdmi', 'infrared', 'usb', 'wifi'];
if (hardware && (hardware.status !== 'passed'
  || hardwareNames.some((name) => hardware.capabilities?.[name]?.passed !== true))) {
  throw new Error('hardware capability evidence is not fully passed');
}
if (report.status !== 'container-valid / hardware-unverified') {
  throw new Error('validation report has an unexpected release status');
}
const board = manifest.board ?? {};
const sources = manifest.sources ?? {};
const lines = [
  '# B860AV1.1-T Armbian candidate',
  '',
  'Status: `container-valid / hardware-unverified`',
  '',
  'Static container and filesystem validation passed. A real-device serial-console boot test has not passed.',
  ...(hasSourceBuiltDtbEvidence ? [
    'The DTB is a candidate built from public P212 repair source. Its RTL8189FTV, SDIO 200 MHz, reset GPIO, and 64 MiB CMA properties are checked, but its generic P212 model does not establish real-device compatibility.',
  ] : []),
  'No persistent bootloader is embedded in the MBR gap. Legacy `u-boot.sd` and `u-boot.usb` payloads are removed; the FAT partition contains a source-built `u-boot-s905x-s912.bin` and an identical `u-boot.ext`. Booting still requires an existing compatible stock boot chain. This is not an Amlogic USB Burning Tool package.',
  'Both autoscripts are rebuilt from repository-owned text sources. The validator rejects boot_android, storeboot, and start_emmc_autoscript, then checks the u-boot.ext, uEnv.txt, booti, and installer paths.',
  '',
  '## Target',
  '',
  `- Distribution: Debian ${sources.debian?.version ?? board.distributionVersion ?? 'unknown'} (${board.distribution ?? 'unknown'})`,
  `- Board profile: ${board.profile ?? 'b860av1-t'}`,
  `- Armbian version: ${sources.base?.armbianVersion ?? 'unknown'}`,
  `- Release tag: \`${releaseTag ?? 'not recorded'}\``,
  `- Fingerprint: \`${manifest.fingerprint ?? 'not recorded'}\``,
  '',
  '## How to boot this',
  '',
  'Write the `.img.gz` to a microSD card (expand it first, or let a writer that handles gzip do it).',
  'This image carries no bootloader in the MBR gap, so the SoC will not boot it on its own: the stock',
  'eMMC U-Boot has to hand over. The stock environment does that through',
  '',
  '```',
  'update               = run usb_burning; run sdc_burning; if mmcinfo; then run recovery_from_sdcard;fi; ...',
  'recovery_from_sdcard = if fatload mmc 0 ${loadaddr} aml_autoscript; then autoscr ${loadaddr}; fi; ...',
  '```',
  '',
  'so insert the card and hold the reset pin in the AV jack while powering on (the same toothpick',
  'entry used for USB burning). That reaches `update`, which runs the `aml_autoscript` on the card;',
  'it repoints `bootcmd` at `s905_autoscript`, which loads `u-boot.ext` and `booti`s the kernel.',
  '',
  'Note that `aml_autoscript` ends in `saveenv`, so this does write the stock U-Boot environment on',
  'eMMC once. That is the stock upgrade path writing its own environment, not a partition this image',
  'supplies, and it is what makes the handover persist across reboots.',
  '',
  'Once Armbian is running, `armbian-install` writes it to eMMC. That is a far shorter path than an',
  'Amlogic USB Burning Tool package, and it is the one this image is built for.',
  '',
  '## Sources',
  '',
  `- Base: ${sources.base?.name ?? 'unknown'} (${sources.base?.digest ?? 'digest unavailable'})`,
  `- Kernel: ${sources.kernel?.version ?? 'unknown'} (${sources.kernel?.digest ?? 'digest unavailable'})`,
  `- Builder commit: \`${sources.builder?.commit ?? 'unknown'}\``,
  `- Upstream U-Boot source commit: \`${sources.ubootSource?.commit ?? 'unknown'}\``,
  '- Linux firmware: inherited from the verified Armbian base image; no additional firmware bundle repository is cloned.',
  '',
  '## Validation',
  '',
  `- Image SHA-256: \`${report.imageSha256 ?? 'unknown'}\``,
  '- gzip, empty MBR bootstrap, empty persistent-bootloader region, legacy U-Boot exclusion, FAT boot, ext4 rootfs, Debian/Armbian identity, active boot configuration, repository-owned autoscripts without Android/stock fallback, initramfs, DTB, boot-argument, and known-Android-marker checks passed.',
  ...(hasQemuSystemEvidence ? [
    `- QEMU system smoke passed; evidence: \`qemu-system-smoke.json\` and \`qemu-system-smoke.log\` (console SHA-256: \`${report.evidence.qemuSystemConsoleSha256 ?? 'not recorded'}\`).`,
  ] : []),
  ...(rtl8189fs ? [
    `- RTL8189FTV gate passed: module \`${rtl8189fs.modulePath}\`, kernel \`${rtl8189fs.kernelRelease}\`, SDIO alias \`${rtl8189fs.sdioAlias}\`; evidence: \`rtl8189fs-driver.json\`.`,
  ] : []),
  ...(hardware ? [
    `- Static eMMC, Ethernet, HDMI, infrared, USB, and Wi-Fi prerequisites passed for installed kernel \`${hardware.kernel.release}\` and active DTB \`${hardware.deviceTree.path}\`; evidence: \`hardware-capabilities.json\`.`,
  ] : []),
  hasSourceBuiltDtbEvidence
    ? hasQemuSystemEvidence
      ? '- Evidence: `validation-report.json`, `filesystem-manifest.sha256`, `boot-components.json`, `uboot-build.json`, the patched `u-boot-source.tar.gz` archive, `source-built-dtb.json`, `device-tree-source.dts`, `qemu-system-smoke.json`, `qemu-system-smoke.log`, and `THIRD_PARTY_SOURCES.md`.'
      : '- Evidence: `validation-report.json`, `filesystem-manifest.sha256`, `boot-components.json`, `uboot-build.json`, the patched `u-boot-source.tar.gz` archive, `source-built-dtb.json`, `device-tree-source.dts`, and `THIRD_PARTY_SOURCES.md`.'
    : hasQemuSystemEvidence
      ? '- Evidence: `validation-report.json`, `filesystem-manifest.sha256`, `boot-components.json`, `uboot-build.json`, the patched `u-boot-source.tar.gz` archive, `qemu-system-smoke.json`, `qemu-system-smoke.log`, and `THIRD_PARTY_SOURCES.md`.'
      : '- Evidence: `validation-report.json`, `filesystem-manifest.sha256`, `boot-components.json`, `uboot-build.json`, the patched `u-boot-source.tar.gz` archive, and `THIRD_PARTY_SOURCES.md`.',
  `- Source-built U-Boot overload SHA-256: \`${ubootBuild.artifact?.sha256 ?? 'not recorded'}\`; size: \`${ubootBuild.artifact?.size ?? 'not recorded'}\` bytes.`,
  `- Patched U-Boot source tree SHA-256: \`${ubootBuild.sourceArchive?.treeSha256 ?? 'not recorded'}\`.`,
  `- U-Boot recipe: \`${ubootBuild.recipe?.defconfig ?? 'unknown'}\` plus \`${ubootBuild.recipe?.patch ?? 'unknown'}\` from upstream commit \`${ubootBuild.source?.commit ?? 'unknown'}\`.`,
];
if (hasSourceBuiltDtbEvidence) {
  lines.push(`- Source-built repair DTB: \`${dtbBuild.artifact?.name ?? 'not recorded'}\` from \`${dtbBuild.source?.repository ?? 'not recorded'}\` commit \`${dtbBuild.source?.commit ?? 'not recorded'}\`; source SHA-256: \`${dtbBuild.source?.sha256 ?? 'not recorded'}\`.`);
}
const output = `${lines.join('\n')}\n`;
if (outputPath) fs.writeFileSync(outputPath, output);
else process.stdout.write(output);
