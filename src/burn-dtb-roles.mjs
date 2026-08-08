import childProcess from 'node:child_process';
import fs from 'node:fs';

import { validateStandaloneDtb } from './burn-standalone-dtb.mjs';

const AML_PAGE_BYTES = 2048;
const AML_ENTRY_BYTES = 56;
const VENDOR_DTB_BYTES = 256000;
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
  if (image.length !== VENDOR_DTB_BYTES || image.toString('ascii', 0, 4) !== 'AML_'
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

export function replaceLinuxTargetDtb(vendorPath, linuxPath, outputPath) {
  const vendorImage = fs.readFileSync(vendorPath);
  const linuxImage = fs.readFileSync(linuxPath);
  const vendor = inspectVendorBurnDtb(vendorPath);
  const linux = inspectLinuxBootDtb(linuxPath);
  const selected = vendor.entries.find(
    ({ target }) => target === BOOTLOADER_SELECTED_TARGET,
  );
  if (!selected) fail('BL33-selected DTB target is missing');
  if (linux.fdtSize > selected.size) {
    fail('Linux FDT does not fit the selected vendor DTB slot');
  }
  validateStandaloneDtb(linuxPath);
  const output = Buffer.from(vendorImage);
  output.fill(0, selected.offset, selected.offset + selected.size);
  linuxImage.copy(output, selected.offset, 0, linux.fdtSize);
  fs.writeFileSync(outputPath, output);
  return {
    schemaVersion: 2,
    selectedTarget: selected.target,
    slotOffset: selected.offset,
    slotSize: selected.size,
    vendor: inspectVendorBurnDtb(outputPath),
    linux: inspectLinuxBootDtb(linuxPath),
    layoutMiB: LAYOUT_MIB,
  };
}

export function validateBurnDtbRoles(vendorPath, linuxPath) {
  const vendorImage = fs.readFileSync(vendorPath);
  const linuxImage = fs.readFileSync(linuxPath);
  const vendor = inspectVendorBurnDtb(vendorPath);
  const linux = inspectLinuxBootDtb(linuxPath);
  validateStandaloneDtb(linuxPath);
  const selected = vendor.entries.find(
    ({ target }) => target === BOOTLOADER_SELECTED_TARGET,
  );
  if (!selected || linux.fdtSize > selected.size
      || !vendorImage.subarray(selected.offset, selected.offset + linux.fdtSize)
        .equals(linuxImage)) {
    fail('BL33-selected P211 payload differs from the Linux FDT');
  }
  if (!vendorImage.subarray(selected.offset + linux.fdtSize, selected.offset + selected.size)
    .every((byte) => byte === 0)) {
    fail('BL33-selected P211 slot padding is not zero-filled');
  }
  return {
    schemaVersion: 1,
    vendor,
    linux,
    distinct: true,
    layoutMiB: LAYOUT_MIB,
  };
}
