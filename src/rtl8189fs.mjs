export const EXPECTED_RTL8189FS_MODULE_PATH =
  'kernel/drivers/net/wireless/realtek/rtl8189fs/8189fs.ko';
export const EXPECTED_RTL8189FS_ALIAS = 'sdio:c*v024CdF179*';

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`RTL8189FS ${label} is missing`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`RTL8189FS ${label} SHA-256 is invalid`);
  }
  return value.toLowerCase();
}

export function validateRtl8189fsMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('RTL8189FS metadata is invalid');
  }
  const kernelRelease = requireText(input.kernelRelease, 'kernel release');
  requireSha256(input.moduleSha256, 'module');
  requireSha256(input.modulesAliasSha256, 'modules.alias');
  requireSha256(input.modulesDepSha256, 'modules.dep');
  if (input.modulePath !== EXPECTED_RTL8189FS_MODULE_PATH) {
    throw new Error('RTL8189FS module path is invalid');
  }
  const fileType = requireText(input.moduleFileType, 'file type');
  if (!/ELF 64-bit LSB relocatable, ARM aarch64/i.test(fileType)) {
    throw new Error('RTL8189FS module is not an ARM64 ELF object');
  }
  if (input.moduleName !== '8189fs') {
    throw new Error('RTL8189FS module name is invalid');
  }
  const vermagic = requireText(input.vermagic, 'vermagic');
  if (!vermagic.startsWith(`${kernelRelease} `) || !/\baarch64\b/.test(vermagic)) {
    throw new Error('RTL8189FS vermagic does not match the active kernel');
  }
  if (!Array.isArray(input.aliases) || !input.aliases.includes(EXPECTED_RTL8189FS_ALIAS)) {
    throw new Error('RTL8189FS B860 SDIO alias is missing');
  }
  const expectedAliasLine = `alias ${EXPECTED_RTL8189FS_ALIAS} 8189fs`;
  if (typeof input.aliasDatabase !== 'string'
    || !input.aliasDatabase.split(/\r?\n/).includes(expectedAliasLine)) {
    throw new Error('RTL8189FS autoload alias is missing');
  }
  const dependencyLine = requireText(input.dependencies, 'dependencies')
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${EXPECTED_RTL8189FS_MODULE_PATH}:`));
  const dependencyTokens = dependencyLine?.slice(dependencyLine.indexOf(':') + 1)
    .trim().split(/\s+/).filter(Boolean) ?? [];
  if (!dependencyLine || !dependencyTokens.includes('kernel/net/wireless/cfg80211.ko')
    || !dependencyTokens.includes('kernel/net/rfkill/rfkill.ko')) {
    throw new Error('RTL8189FS dependencies are incomplete');
  }
  return true;
}
