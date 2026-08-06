import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const IKCONFIG_START = Buffer.from('IKCFG_ST', 'ascii');
const IKCONFIG_END = Buffer.from('IKCFG_ED', 'ascii');
const REQUIRED_CONFIG = [
  'CONFIG_BLK_CMDLINE_PARSER',
  'CONFIG_BLK_DEV_INITRD',
  'CONFIG_CMDLINE_PARTITION',
  'CONFIG_DRM_DW_HDMI',
  'CONFIG_DRM_MESON',
  'CONFIG_DRM_MESON_DW_HDMI',
  'CONFIG_DWMAC_MESON',
  'CONFIG_EXT4_FS',
  'CONFIG_IKCONFIG',
  'CONFIG_MESON_GXL_PHY',
  'CONFIG_MMC_BLOCK',
  'CONFIG_MMC_MESON_GX',
  'CONFIG_PHY_MESON_GXL_USB2',
  'CONFIG_STMMAC_ETH',
];
const DIRECT_ROOT_CONFIG = [
  'CONFIG_DEVTMPFS',
  'CONFIG_DEVTMPFS_MOUNT',
];
const INITRD_CODECS = [
  { name: 'gzip', magic: Buffer.from([0x1f, 0x8b]), config: 'CONFIG_RD_GZIP' },
  { name: 'xz', magic: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), config: 'CONFIG_RD_XZ' },
  { name: 'zstd', magic: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), config: 'CONFIG_RD_ZSTD' },
  { name: 'bzip2', magic: Buffer.from('BZh', 'ascii'), config: 'CONFIG_RD_BZIP2' },
  { name: 'lz4', magic: Buffer.from([0x02, 0x21, 0x4c, 0x18]), config: 'CONFIG_RD_LZ4' },
  { name: 'lzo', magic: Buffer.from([0x89, 0x4c, 0x5a, 0x4f, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]), config: 'CONFIG_RD_LZO' },
];

function fail(message) {
  throw new Error(message);
}

function startsWith(buffer, magic) {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

export function parseKernelConfig(contents) {
  const values = new Map();
  for (const line of contents.toString('utf8').split(/\r?\n/u)) {
    const match = line.match(/^(CONFIG_[A-Z0-9_]+)=(.+)$/u);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

export function extractKernelConfig(kernel) {
  const start = kernel.indexOf(IKCONFIG_START);
  const end = kernel.indexOf(IKCONFIG_END, start + IKCONFIG_START.length);
  if (start < 0 || end < 0) fail('stock boot kernel has no extractable IKCONFIG');
  const compressed = kernel.subarray(start + IKCONFIG_START.length, end);
  try {
    return gunzipSync(compressed);
  } catch {
    return fail('stock boot kernel IKCONFIG gzip stream is invalid');
  }
}

export function inspectInitrdCodec(initrd) {
  if (initrd.length === 0) return { name: 'none', config: null };
  const codec = INITRD_CODECS.find(({ magic }) => startsWith(initrd, magic));
  if (codec) return codec;
  if (['070701', '070702', '070707'].some((magic) => startsWith(initrd, Buffer.from(magic)))) {
    return { name: 'cpio', config: null };
  }
  return fail('stock boot initrd compression format is unsupported');
}

export function validateDirectBootContract(kernel, initrd) {
  const configContents = extractKernelConfig(kernel);
  const config = parseKernelConfig(configContents);
  const codec = inspectInitrdCodec(initrd);
  const required = [
    ...REQUIRED_CONFIG,
    ...(codec.name === 'none' ? DIRECT_ROOT_CONFIG : []),
    codec.config,
  ].filter(Boolean);
  const observed = {};
  for (const name of required) {
    const value = config.get(name);
    if (value !== 'y') fail(`stock boot kernel requires ${name}=y`);
    observed[name] = value;
  }
  return {
    initrdCodec: codec.name,
    initrdKernelConfig: codec.config,
    kernelConfigSha256: crypto.createHash('sha256').update(configContents).digest('hex'),
    requiredKernelConfig: observed,
  };
}
