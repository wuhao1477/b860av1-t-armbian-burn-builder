import fs from 'node:fs';
import path from 'node:path';

import { inspectSparseImage, readSparseExt4Uuid } from './android-sparse.mjs';

const SECTOR_BYTES = 512;
const MIB = 1024 * 1024;
const BOOT_PARTITION_BYTES = 32 * MIB;
const BOOT_START_MIB = 1104;
const ROOT_START_MIB = 2176;
const BURN_PARTITIONS = [
  'bootloader.PARTITION',
  'boot.PARTITION',
  'data.PARTITION',
];

function fail(message) {
  throw new Error(message);
}

export function inspectBurnPackagePartitions(packageDirectory) {
  const entries = fs.readdirSync(packageDirectory, { withFileTypes: true });
  const actual = entries.filter((entry) => entry.name.endsWith('.PARTITION'))
    .map((entry) => entry.name);
  for (const name of actual) {
    if (!BURN_PARTITIONS.includes(name)) fail(`unexpected partition payload: ${name}`);
  }
  for (const name of BURN_PARTITIONS) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry?.isFile() || fs.statSync(path.join(packageDirectory, name)).size === 0) {
      fail(`missing partition payload: ${name}`);
    }
  }
  return { partitions: [...BURN_PARTITIONS] };
}

export function inspectRawFitImage(imagePath) {
  const image = fs.readFileSync(imagePath);
  if (image.length === 0 || image.length > BOOT_PARTITION_BYTES
      || image.length % SECTOR_BYTES !== 0) {
    fail('boot.PARTITION FIT size must be positive, sector-aligned, and at most 32 MiB');
  }
  if (image.length < 8 || image.readUInt32BE(0) !== 0xd00dfeed) {
    fail('boot.PARTITION is not a raw FIT image');
  }
  const declaredBytes = image.readUInt32BE(4);
  if (declaredBytes < 8 || declaredBytes > image.length) {
    fail('boot.PARTITION FIT declares an invalid total size');
  }
  if (!image.subarray(declaredBytes).every((value) => value === 0)) {
    fail('boot.PARTITION FIT padding must be zero-filled');
  }
  return {
    declaredBytes,
    sectors: image.length / SECTOR_BYTES,
    size: image.length,
    startLba: (BOOT_START_MIB * MIB) / SECTOR_BYTES,
    startMiB: BOOT_START_MIB,
  };
}

export function validateEmmcBootChain(fitPath, rootfsPath, bootContract) {
  const fit = inspectRawFitImage(fitPath);
  const rootfs = inspectSparseImage(rootfsPath);
  const rootUuid = readSparseExt4Uuid(rootfsPath);
  if (!bootContract || typeof bootContract !== 'object' || Array.isArray(bootContract)) {
    fail('mainline U-Boot FIT contract is invalid');
  }
  if (bootContract.rootUuid !== rootUuid) fail('U-Boot root UUID differs from data.PARTITION');
  if (bootContract.fitLoadAddress !== '0x08000000') fail('U-Boot FIT load address is invalid');
  if (bootContract.fitStartLba !== fit.startLba) fail('U-Boot FIT start LBA differs');
  if (bootContract.fitSectors !== fit.sectors) fail('U-Boot FIT sector count differs');
  return {
    schemaVersion: 1,
    strategy: 'vendor-fip-mainline-bl33-fit',
    fit,
    rootfs: {
      ...rootfs,
      startLba: (ROOT_START_MIB * MIB) / SECTOR_BYTES,
      startMiB: ROOT_START_MIB,
    },
    rootUuid,
  };
}
