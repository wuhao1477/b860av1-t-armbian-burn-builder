import childProcess from 'node:child_process';
import fs from 'node:fs';

const AML_PAGE_BYTES = 2048;
const AML_ENTRY_BYTES = 56;
const VENDOR_DTB_INPUT_BYTES = 256000;
const VENDOR_DTB_MAX_BYTES = 256 * 1024;
const BOOTLOADER_SELECTED_TARGET = 'gxl_p211_1g';
const TARGETS = [
  'gxb_p200_1g',
  'gxb_p200_2g',
  'gxl_p211_1g',
  'gxl_p211_2g',
  'gxl_p215_1g',
  'gxl_p215_2g',
  'gxl_p215hc100_2g',
];
const LAYOUT_MIB = {
  bootloader: 0,
  reserved: 36,
  cache: 108,
  env: 884,
  conf: 900,
  logo: 912,
  recovery: 952,
  rsv: 992,
  tee: 1008,
  crypt: 1024,
  misc: 1064,
  boot: 1104,
  system: 1144,
  data: 2176,
};

function fail(message) {
  throw new Error(message);
}

function align(value, boundary) {
  return Math.ceil(value / boundary) * boundary;
}

function decodeProperty(image, offset) {
  const decoded = Buffer.alloc(16);
  for (let group = 0; group < decoded.length; group += 4) {
    for (let index = 0; index < 4; index += 1) {
      decoded[group + index] = image[offset + group + 3 - index];
    }
  }
  return decoded.toString('ascii').replace(/[ \0]+$/u, '');
}

function inspectVendorEntry(image, index, expectedOffset) {
  const entryOffset = 12 + (index * AML_ENTRY_BYTES);
  const target = [0, 16, 32]
    .map((delta) => decodeProperty(image, entryOffset + delta))
    .filter(Boolean)
    .join('_');
  const offset = image.readUInt32LE(entryOffset + 48);
  const size = image.readUInt32LE(entryOffset + 52);
  if (target !== TARGETS[index] || offset !== expectedOffset || size === 0
      || offset % AML_PAGE_BYTES !== 0 || size % AML_PAGE_BYTES !== 0
      || offset + size > image.length || image.readUInt32BE(offset) !== 0xd00dfeed) {
    fail(`vendor meson1.dtb entry is invalid: ${TARGETS[index]}`);
  }
  const fdtSize = image.readUInt32BE(offset + 4);
  if (fdtSize < 8 || fdtSize > size) fail(`vendor FDT size is invalid: ${target}`);
  return { target, offset, size, fdtSize };
}

export function inspectVendorBurnDtb(path) {
  const image = fs.readFileSync(path);
  if (image.length < VENDOR_DTB_INPUT_BYTES || image.length > VENDOR_DTB_MAX_BYTES
      || image.toString('ascii', 0, 4) !== 'AML_'
      || image.readUInt32LE(4) !== 2 || image.readUInt32LE(8) !== TARGETS.length) {
    fail('vendor meson1.dtb is not Amlogic multi-DTB v2');
  }
  const entries = [];
  let nextOffset = AML_PAGE_BYTES;
  for (let index = 0; index < TARGETS.length; index += 1) {
    const entry = inspectVendorEntry(image, index, nextOffset);
    entries.push(entry);
    nextOffset = entry.offset + entry.size;
  }
  if (nextOffset !== image.length) fail('vendor meson1.dtb payload length is invalid');
  return {
    format: 'amlogic-multi-dtb-v2',
    size: image.length,
    targets: entries.map(({ target }) => target),
    selectedTarget: BOOTLOADER_SELECTED_TARGET,
    entries,
  };
}

export function inspectLinuxBootDtb(path) {
  const image = fs.readFileSync(path);
  if (image.length < 8 || image.readUInt32BE(0) !== 0xd00dfeed) {
    fail('Linux boot DTB is not a plain FDT');
  }
  const fdtSize = image.readUInt32BE(4);
  if (fdtSize < 8 || fdtSize > image.length) fail('Linux boot DTB size is invalid');
  let compatible;
  try {
    compatible = childProcess.execFileSync('fdtget', ['-t', 's', path, '/', 'compatible'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split(/\s+/u);
  } catch {
    fail('Linux boot DTB compatible property is unavailable');
  }
  if (!compatible.includes('amlogic,p212')) fail('Linux boot DTB is not the B860 P212 target');
  return { format: 'flattened-device-tree', size: image.length, fdtSize, compatible };
}

function repackVendorDtb(vendorImage, vendor, linuxImage, linux) {
  const selectedIndex = vendor.entries.findIndex(
    ({ target }) => target === BOOTLOADER_SELECTED_TARGET,
  );
  if (selectedIndex < 0) fail('BL33-selected DTB target is missing');
  const selectedSlotSize = Math.max(
    vendor.entries[selectedIndex].size,
    align(linux.fdtSize, AML_PAGE_BYTES),
  );
  const totalSize = AML_PAGE_BYTES + vendor.entries.reduce(
    (total, entry, index) => total + (index === selectedIndex ? selectedSlotSize : entry.size),
    0,
  );
  if (totalSize > VENDOR_DTB_MAX_BYTES) fail('hybrid multi-DTB exceeds the BL33 256 KiB limit');
  const output = Buffer.alloc(totalSize);
  vendorImage.copy(output, 0, 0, AML_PAGE_BYTES);
  let offset = AML_PAGE_BYTES;
  vendor.entries.forEach((entry, index) => {
    const size = index === selectedIndex ? selectedSlotSize : entry.size;
    const tableOffset = 12 + (index * AML_ENTRY_BYTES);
    output.writeUInt32LE(offset, tableOffset + 48);
    output.writeUInt32LE(size, tableOffset + 52);
    const payload = index === selectedIndex
      ? linuxImage.subarray(0, linux.fdtSize)
      : vendorImage.subarray(entry.offset, entry.offset + entry.size);
    payload.copy(output, offset);
    offset += size;
  });
  return output;
}

export function replaceLinuxTargetDtb(vendorPath, linuxPath, outputPath) {
  const vendorImage = fs.readFileSync(vendorPath);
  const linuxImage = fs.readFileSync(linuxPath);
  const vendor = inspectVendorBurnDtb(vendorPath);
  const linux = inspectLinuxBootDtb(linuxPath);
  const output = repackVendorDtb(vendorImage, vendor, linuxImage, linux);
  fs.writeFileSync(outputPath, output);
  const outputVendor = inspectVendorBurnDtb(outputPath);
  const outputSelected = outputVendor.entries.find(
    (entry) => entry.target === BOOTLOADER_SELECTED_TARGET,
  );
  return {
    schemaVersion: 2,
    selectedTarget: outputSelected.target,
    slotOffset: outputSelected.offset,
    slotSize: outputSelected.size,
    vendor: outputVendor,
    linux: inspectLinuxBootDtb(linuxPath),
    layoutMiB: LAYOUT_MIB,
  };
}

export function validateBurnDtbRoles(vendorPath, linuxPath) {
  const vendor = inspectVendorBurnDtb(vendorPath);
  const linux = inspectLinuxBootDtb(linuxPath);
  return {
    schemaVersion: 1,
    vendor,
    linux,
    distinct: true,
    layoutMiB: LAYOUT_MIB,
  };
}
