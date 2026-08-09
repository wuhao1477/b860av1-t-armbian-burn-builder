const MIB = 1024 * 1024;
const SECTOR_BYTES = 512;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export const MAINLINE_BOOT_LAYOUT = Object.freeze({
  bootBytes: 32 * MIB,
  bootSectors: (32 * MIB) / SECTOR_BYTES,
  bootStartLba: (1104 * MIB) / SECTOR_BYTES,
  rootStartMiB: 2176,
});

export const BURN_PARTITION_ARGUMENT = 'blkdevparts=mmcblk2:4M@0(bootloader),64M@36M(reserved),768M@108M(cache),8M@884M(env),4M@900M(conf),32M@912M(logo),32M@952M(recovery),8M@992M(rsv),8M@1008M(tee),32M@1024M(crypt),32M@1064M(misc),32M@1104M(boot),1024M@1144M(system),-@2176M(data)';

const FIT_SOURCE = `/dts-v1/;

/ {
	description = "ZXV10 B860AV1.1-T Armbian";
	#address-cells = <1>;

	images {
		kernel {
			description = "Armbian ARM64 kernel";
			data = /incbin/("Image.gz");
			type = "kernel";
			arch = "arm64";
			os = "linux";
			compression = "gzip";
			load = <0x01080000>;
			entry = <0x01080000>;
			hash-1 { algo = "sha256"; };
		};

		ramdisk {
			description = "Armbian initramfs";
			data = /incbin/("initrd.img");
			type = "ramdisk";
			arch = "arm64";
			os = "linux";
			compression = "none";
			hash-1 { algo = "sha256"; };
		};

		fdt {
			description = "B860AV1.1-T device tree";
			data = /incbin/("linux.dtb");
			type = "flat_dt";
			arch = "arm64";
			compression = "none";
			hash-1 { algo = "sha256"; };
		};
	};

	configurations {
		default = "conf-1";
		conf-1 {
			description = "Armbian on ZXV10 B860AV1.1-T";
			kernel = "kernel";
			ramdisk = "ramdisk";
			fdt = "fdt";
		};
	};
};
`;

export const STOCK_FIP_COMPONENTS = Object.freeze({
  bl2: '0ed67a2ee15629eb4af16b41d2908816d3a4fe7ca591bcec7756fb56afc26417',
  bl30: '99208e665e255330e682db4df321982fa0bf29324f42047f10c1d689ae0e8b07',
  bl301: 'ad24ba46950216b32aa4f3edcf7be51707a732474752aaade1bc9aadc7249fd5',
  bl31: '2f4947e9f92aa9aabdd452f2514f268ee657fed610629cd2457a329be571101a',
  bl33: '3e983db37d4505626f92550d8b5b9da629f4251c9b003359b28034814ea342d5',
});

function fail(message) {
  throw new Error(message);
}

function normalizeUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('root filesystem UUID is invalid');
  return value.toLowerCase();
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} SHA-256 is invalid`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} size is invalid`);
  return value;
}

function requireSectorAlignedBytes(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value % SECTOR_BYTES !== 0) {
    fail(`${label} must be a positive sector-aligned size`);
  }
  if (value > MAINLINE_BOOT_LAYOUT.bootBytes) fail(`${label} exceeds the boot partition`);
  return value;
}

function hex32(value) {
  return `0x${value.toString(16).padStart(8, '0')}`;
}

export function createFitSource() {
  return FIT_SOURCE;
}

export function createMainlineBootCommand(rootUuid, fitBytes) {
  const uuid = normalizeUuid(rootUuid);
  const bytes = requireSectorAlignedBytes(fitBytes, 'FIT payload');
  const sectors = bytes / SECTOR_BYTES;
  return [
    `setenv bootargs ${BURN_PARTITION_ARGUMENT} root=UUID=${uuid} rw rootwait rootfstype=ext4 mem=1024M console=ttyAML0,115200n8 console=tty0 no_console_suspend consoleblank=0 fsck.fix=yes fsck.repair=yes net.ifnames=0 init=/sbin/init`,
    'if mmc dev 1',
    `then if mmc read 0x08000000 ${hex32(MAINLINE_BOOT_LAYOUT.bootStartLba)} ${hex32(sectors)}`,
    'then bootm 0x08000000',
    'fi',
    'fi',
    'reset',
  ].join('; ');
}

export function inspectMainlineBootCommand(command) {
  if (typeof command !== 'string' || !command.includes(BURN_PARTITION_ARGUMENT)) {
    fail('fixed boot command lacks the B860 partition layout');
  }
  const roots = [...command.matchAll(/(?:^|\s)root=UUID=([0-9a-f-]+)(?=\s|;|$)/giu)];
  if (roots.length !== 1) fail('fixed boot command must contain one root filesystem UUID');
  const read = command.match(/\bmmc read (0x[0-9a-f]+) (0x[0-9a-f]+) (0x[0-9a-f]+)(?=\s|;|$)/iu);
  if (!command.includes('if mmc dev 1') || !read || !command.includes('bootm 0x08000000')) {
    fail('fixed boot command lacks the eMMC FIT boot pipeline');
  }
  const fitLoadAddress = hex32(Number.parseInt(read[1].slice(2), 16));
  const fitStartLba = Number.parseInt(read[2].slice(2), 16);
  const fitSectors = Number.parseInt(read[3].slice(2), 16);
  if (fitLoadAddress !== '0x08000000'
      || fitStartLba !== MAINLINE_BOOT_LAYOUT.bootStartLba
      || !Number.isSafeInteger(fitSectors) || fitSectors <= 0
      || fitSectors > MAINLINE_BOOT_LAYOUT.bootSectors) {
    fail('fixed boot command FIT geometry is invalid');
  }
  if (/distro_bootcmd|storeboot|imgread|ANDROID!|boot_android/iu.test(command)) {
    fail('fixed boot command contains a prohibited fallback');
  }
  return {
    fitLoadAddress,
    fitSectors,
    fitStartLba,
    rootUuid: normalizeUuid(roots[0][1]),
  };
}

function validateVendorComponents(components) {
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    fail('FIP components are invalid');
  }
  for (const name of ['bl2', 'bl30', 'bl301', 'bl31']) {
    requirePositiveInteger(components[name]?.size, `${name} component`);
    const digest = requireSha256(components[name]?.sha256, `${name} component`);
    if (digest !== STOCK_FIP_COMPONENTS[name]) fail(`vendor FIP component differs: ${name}`);
  }
  requirePositiveInteger(components.bl33?.size, 'bl33 component');
  const bl33 = requireSha256(components.bl33?.sha256, 'bl33 component');
  if (bl33 === STOCK_FIP_COMPONENTS.bl33) fail('BL33 still matches the Android vendor stage');
}

function validateUboot(uboot) {
  requireSha256(uboot?.rawSha256, 'raw BL33');
  if (typeof uboot?.version !== 'string'
      || !uboot.version.startsWith('U-Boot 2023.01')
      || !uboot.version.includes('r3300l')) {
    fail('mainline U-Boot version is invalid');
  }
  let boot;
  try {
    boot = inspectMainlineBootCommand(uboot.defaultBootCommand);
  } catch (error) {
    fail(`mainline U-Boot default boot command is invalid: ${error.message}`);
  }
  if (uboot.rootUuid !== boot.rootUuid) fail('mainline U-Boot root UUID differs from bootcmd');
  if (uboot.fitLoadAddress !== boot.fitLoadAddress) {
    fail('mainline U-Boot FIT load address differs from bootcmd');
  }
  if (uboot.fitStartLba !== boot.fitStartLba) {
    fail('mainline U-Boot FIT start LBA differs from bootcmd');
  }
  if (uboot.fitSectors !== boot.fitSectors) {
    fail('mainline U-Boot FIT sector count differs from bootcmd');
  }
  if (!Array.isArray(uboot.bootTargets)
      || uboot.bootTargets.some((target) => typeof target !== 'string' || target.length === 0)
      || !uboot.bootTargets.includes('mmc1')) {
    fail('mainline U-Boot boot targets must include mmc1');
  }
  if (uboot.kernelCompAddress !== '0x0d080000'
      || uboot.kernelCompSize !== '0x02000000') {
    fail('mainline U-Boot compressed kernel variables are invalid');
  }
  const serialized = `${uboot.defaultBootCommand} ${uboot.bootTargets.join(' ')}`;
  if (/storeboot|imgread|ANDROID!|boot_android/iu.test(serialized)) {
    fail('mainline U-Boot evidence contains an Android boot command');
  }
}

export function validateMainlineFipEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('FIP evidence is invalid');
  if (value.schemaVersion !== 1 || value.status !== 'format-valid / hardware-unverified'
      || value.strategy !== 'vendor-fip-mainline-bl33-fit') {
    fail('FIP evidence identity is invalid');
  }
  requirePositiveInteger(value.fip?.size, 'FIP');
  requireSha256(value.fip?.sha256, 'FIP');
  validateVendorComponents(value.fip?.components);
  validateUboot(value.uboot);
  return value;
}
