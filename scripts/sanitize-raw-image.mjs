#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SECTOR_SIZE = 512;
const MBR_SIZE = SECTOR_SIZE;
const BOOTSTRAP_SIZE = 440;
const RESERVED_OFFSET = 444;
const RESERVED_SIZE = 2;
const MAX_GAP_MIB = 16;

function readMbr(fd) {
  const mbr = Buffer.alloc(MBR_SIZE);
  const bytesRead = fs.readSync(fd, mbr, 0, MBR_SIZE, 0);
  if (bytesRead !== MBR_SIZE || mbr[510] !== 0x55 || mbr[511] !== 0xaa) {
    throw new Error('raw image does not contain a DOS MBR');
  }
  return mbr;
}

function findFirstPartition(mbr, imageSize) {
  const starts = [];
  for (let index = 0; index < 4; index += 1) {
    const offset = 446 + (index * 16);
    const type = mbr[offset + 4];
    const start = mbr.readUInt32LE(offset + 8);
    const sectors = mbr.readUInt32LE(offset + 12);
    if (type === 0 && start === 0 && sectors === 0) continue;
    if (type === 0 || start === 0 || sectors === 0) {
      throw new Error(`partition ${index + 1} has an incomplete MBR entry`);
    }
    if ((start + sectors) * SECTOR_SIZE > imageSize) {
      throw new Error(`partition ${index + 1} extends beyond the raw image`);
    }
    starts.push(start);
  }
  if (starts.length === 0) throw new Error('raw image has no MBR partitions');
  return Math.min(...starts);
}

function zeroRange(fd, start, length) {
  const chunk = Buffer.alloc(Math.min(length, 1024 * 1024));
  let position = start;
  let remaining = length;
  while (remaining > 0) {
    const count = Math.min(remaining, chunk.length);
    if (fs.writeSync(fd, chunk, 0, count, position) !== count) {
      throw new Error(`short write while clearing image at byte ${position}`);
    }
    position += count;
    remaining -= count;
  }
}

export function sanitizeRawImage(imagePath, bootloaderGapMiB) {
  if (!Number.isInteger(bootloaderGapMiB) || bootloaderGapMiB < 1 || bootloaderGapMiB > MAX_GAP_MIB) {
    throw new Error('bootloader gap must be an integer from 1 to 16 MiB');
  }
  const expectedStart = bootloaderGapMiB * 2048;
  const fd = fs.openSync(imagePath, 'r+');
  try {
    const imageSize = fs.fstatSync(fd).size;
    if (imageSize < MBR_SIZE || imageSize % SECTOR_SIZE !== 0) {
      throw new Error('raw image size is not sector aligned');
    }
    const firstPartitionStart = findFirstPartition(readMbr(fd), imageSize);
    if (firstPartitionStart !== expectedStart) {
      throw new Error(`first partition starts at sector ${firstPartitionStart}, expected ${expectedStart}`);
    }
    const gapLength = (firstPartitionStart - 1) * SECTOR_SIZE;
    zeroRange(fd, 0, BOOTSTRAP_SIZE);
    zeroRange(fd, RESERVED_OFFSET, RESERVED_SIZE);
    zeroRange(fd, SECTOR_SIZE, gapLength);
    fs.fsyncSync(fd);
    return {
      firstPartitionStart,
      zeroedBytes: BOOTSTRAP_SIZE + RESERVED_SIZE + gapLength,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readExpectedGap(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.board?.bootloaderGapMiB;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , imagePath, manifestPath] = process.argv;
  if (!imagePath || !manifestPath) {
    process.stderr.write('usage: sanitize-raw-image.mjs image.img manifest.json\n');
    process.exitCode = 2;
  } else {
    try {
      const result = sanitizeRawImage(imagePath, readExpectedGap(manifestPath));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    }
  }
}
