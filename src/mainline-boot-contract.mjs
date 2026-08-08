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

function requireBootPath(value, label) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9._+/-]+$/u.test(value)
      || value.split('/').includes('..')) {
    fail(`${label} path is invalid`);
  }
  return value;
}

export function createExtlinuxConfig(memoryLimitMiB, rootUuid, dtbPath) {
  if (!Number.isInteger(memoryLimitMiB) || memoryLimitMiB < 256 || memoryLimitMiB > 4096) {
    fail('memory limit must be an integer from 256 to 4096 MiB');
  }
  const uuid = normalizeUuid(rootUuid);
  const dtb = requireBootPath(dtbPath, 'device tree');
  return [
    'TIMEOUT 30',
    'DEFAULT armbian',
    '',
    'LABEL armbian',
    '  LINUX /Image.gz',
    '  INITRD /initrd.img',
    `  FDT ${dtb}`,
    `  APPEND root=UUID=${uuid} rw rootwait rootfstype=ext4 mem=${memoryLimitMiB}M console=ttyAML0,115200n8 console=tty0 no_console_suspend consoleblank=0 fsck.fix=yes fsck.repair=yes net.ifnames=0 init=/sbin/init`,
    '',
  ].join('\n');
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
      || !uboot.version.startsWith('U-Boot 2026.01')
      || !uboot.version.includes('r3300-l')) {
    fail('mainline U-Boot version is invalid');
  }
  if (uboot.defaultBootCommand !== 'run distro_bootcmd') {
    fail('mainline U-Boot default boot command must use distro_bootcmd');
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
      || value.strategy !== 'vendor-fip-mainline-bl33-extlinux') {
    fail('FIP evidence identity is invalid');
  }
  requirePositiveInteger(value.fip?.size, 'FIP');
  requireSha256(value.fip?.sha256, 'FIP');
  validateVendorComponents(value.fip?.components);
  validateUboot(value.uboot);
  return value;
}
