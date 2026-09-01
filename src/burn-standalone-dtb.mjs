import childProcess from 'node:child_process';
import fs from 'node:fs';

const P211_DTB_SLOT_BYTES = 36 * 1024;
const ROOT_COMPATIBLES = ['amlogic,p212', 'amlogic,s905x', 'amlogic,meson-gxl'];
const LEGACY_BINDINGS = [
  'amlogic, Gxbb',
  'amlogic, aml_sd_emmc',
  'amlogic, amhdmitx',
];
const HARDWARE_BINDINGS = [
  ['/soc/ethernet@c9410000', 'amlogic,meson-gxbb-dwmac'],
  ['/soc/apb@d0000000/mmc@74000', 'amlogic,meson-gx-mmc'],
  ['/soc/hdmi-tx@c883a000', 'amlogic,meson-gxl-dw-hdmi'],
];
export const EMMC_NODE = '/soc/apb@d0000000/mmc@74000';
export const EMMC_MAX_FREQUENCY_HZ = '200000000';
const PARTITIONS = [
  ['conf', '0 400000', '1'],
  ['logo', '0 2000000', '1'],
  ['recovery', '0 2000000', '1'],
  ['rsv', '0 800000', '1'],
  ['tee', '0 800000', '1'],
  ['crypt', '0 2000000', '1'],
  ['misc', '0 2000000', '1'],
  ['boot', '0 2000000', '1'],
  ['system', '0 40000000', '1'],
  ['cache', '0 30000000', '2'],
  ['data', 'ffffffff ffffffff', '4'],
];
const MIB = 1024 * 1024;
const INHERENT_PARTITIONS = [
  ['bootloader', 4, 0],
  ['reserved', 64, 32],
  ['cache', 768, 8],
  ['env', 8, 8],
];

function fail(message) {
  throw new Error(message);
}

function fdtProperties(dtbPath, node) {
  try {
    return childProcess.execFileSync('fdtget', ['-p', dtbPath, node], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split(/\s+/u);
  } catch {
    return fail(`standalone DTB node is missing: ${node}`);
  }
}

function fdtget(dtbPath, node, property, type) {
  const args = [];
  if (type) args.push('-t', type);
  args.push(dtbPath, node, property);
  try {
    return childProcess.execFileSync('fdtget', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail(`standalone DTB property is missing: ${node}:${property}`);
  }
}

function fdtChildren(dtbPath, node) {
  try {
    const value = childProcess.execFileSync('fdtget', ['-l', dtbPath, node], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return value.length === 0 ? [] : value.split(/\r?\n/);
  } catch {
    fail(`standalone DTB node is missing: ${node}`);
  }
}

function validateContainer(image) {
  if (image.length < 8 || image.readUInt32BE(0) !== 0xd00dfeed) {
    fail('standalone DTB is not a plain FDT');
  }
  const fdtSize = image.readUInt32BE(4);
  if (fdtSize !== image.length || fdtSize > P211_DTB_SLOT_BYTES) {
    fail('standalone DTB must be an unpadded FDT that fits the stock P211 slot');
  }
  for (const binding of LEGACY_BINDINGS) {
    if (image.includes(Buffer.from(binding))) fail(`legacy Android DTB binding found: ${binding}`);
  }
  return fdtSize;
}

function validateHardware(dtbPath) {
  const root = fdtget(dtbPath, '/', 'compatible').split(/\s+/);
  if (ROOT_COMPATIBLES.some((compatible) => !root.includes(compatible))) {
    fail('standalone DTB root is not mainline P212');
  }
  if (fdtget(dtbPath, '/', 'amlogic-dt-id') !== 'gxl_p211_1g') {
    fail('standalone DTB target is not gxl_p211_1g');
  }
  for (const [node, expected] of HARDWARE_BINDINGS) {
    if (!fdtget(dtbPath, node, 'compatible').split(/\s+/).includes(expected)) {
      fail(`standalone DTB hardware binding is invalid: ${node}`);
    }
  }
  if (fdtget(dtbPath, EMMC_NODE, 'max-frequency') !== EMMC_MAX_FREQUENCY_HZ) {
    fail(`standalone DTB eMMC max-frequency is not ${EMMC_MAX_FREQUENCY_HZ}`);
  }
  // HS200 在这块板上必然失败（-74），且失败后内核不回退，直接停在 legacy 25 MHz。
  // 摘掉这条能力才能拿到 DDR52。放回来 = eMMC 掉回 22.4 MB/s。
  if (fdtProperties(dtbPath, EMMC_NODE).includes('mmc-hs200-1_8v')) {
    fail('standalone DTB eMMC must not advertise mmc-hs200-1_8v');
  }
  for (const required of ['cap-mmc-highspeed', 'mmc-ddr-1_8v']) {
    if (!fdtProperties(dtbPath, EMMC_NODE).includes(required)) {
      fail(`standalone DTB eMMC is missing ${required}`);
    }
  }
}

function validatePartitions(dtbPath) {
  const names = PARTITIONS.map(([name]) => name);
  if (fdtget(dtbPath, '/partitions', 'parts', 'x') !== 'b'
      || fdtChildren(dtbPath, '/partitions').toSorted().join('\n') !== names.toSorted().join('\n')) {
    fail('standalone DTB partition set is invalid');
  }
  PARTITIONS.forEach(([name, size, mask], index) => {
    const node = `/partitions/${name}`;
    if (fdtget(dtbPath, node, 'pname') !== name
        || fdtget(dtbPath, node, 'size', 'x') !== size
        || fdtget(dtbPath, node, 'mask', 'x') !== mask
        || fdtget(dtbPath, '/partitions', `part-${index}`, 'x')
          !== fdtget(dtbPath, node, 'phandle', 'x')) {
      fail(`standalone DTB partition is invalid: ${name}`);
    }
  });
  return names;
}

function stockEmmcLayoutMiB() {
  const layout = {};
  let end = 0;
  for (const [name, size, gap] of INHERENT_PARTITIONS) {
    const offset = end + gap;
    layout[name] = offset;
    end = offset + size;
  }
  for (const [name, size] of PARTITIONS) {
    if (Object.hasOwn(layout, name)) continue;
    const offset = end + 8;
    layout[name] = offset;
    if (size === 'ffffffff ffffffff') break;
    end = offset + (Number.parseInt(size.split(' ')[1], 16) / MIB);
  }
  return layout;
}

export function validateStandaloneDtb(dtbPath) {
  const fdtSize = validateContainer(fs.readFileSync(dtbPath));
  validateHardware(dtbPath);
  const partitions = validatePartitions(dtbPath);
  return {
    size: fdtSize,
    fdtSize,
    target: 'gxl_p211_1g',
    partitions,
    layoutMiB: stockEmmcLayoutMiB(),
  };
}
