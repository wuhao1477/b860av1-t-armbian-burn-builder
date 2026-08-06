import fs from 'node:fs';

const SPARSE_MAGIC = 0xed26ff3a;
const SPARSE_HEADER_BYTES = 28;
const CHUNK_HEADER_BYTES = 12;
const CHUNK_RAW = 0xcac1;
const CHUNK_FILL = 0xcac2;
const CHUNK_DONT_CARE = 0xcac3;
const CHUNK_CRC32 = 0xcac4;
const EXT4_SUPERBLOCK_OFFSET = 1024;
const EXT4_MAGIC_OFFSET = 0x38;
const EXT4_UUID_OFFSET = 0x68;
const EXT4_UUID_BYTES = 16;

function fail(message) {
  throw new Error(message);
}

function readAt(fd, length, position, label) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  if (read !== length) fail(`sparse image has a truncated ${label}`);
  return buffer;
}

function formatUuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sparseHeader(fd, fileSize) {
  const header = readAt(fd, SPARSE_HEADER_BYTES, 0, 'header');
  if (header.readUInt32LE(0) !== SPARSE_MAGIC || header.readUInt16LE(4) !== 1
      || header.readUInt16LE(6) !== 0) fail('data.PARTITION is not an Android sparse v1.0 image');
  const fileHeaderBytes = header.readUInt16LE(8);
  const chunkHeaderBytes = header.readUInt16LE(10);
  const blockSize = header.readUInt32LE(12);
  const totalBlocks = header.readUInt32LE(16);
  const totalChunks = header.readUInt32LE(20);
  if (fileHeaderBytes < SPARSE_HEADER_BYTES || fileHeaderBytes > fileSize
      || chunkHeaderBytes < CHUNK_HEADER_BYTES || blockSize < 4096
      || (blockSize & (blockSize - 1)) !== 0 || totalBlocks === 0 || totalChunks === 0) {
    fail('data.PARTITION sparse header is invalid');
  }
  return { fileHeaderBytes, chunkHeaderBytes, blockSize, totalBlocks, totalChunks };
}

function validateChunk(type, blocks, totalBytes, headerBytes, logicalBytes) {
  const expected = new Map([
    [CHUNK_RAW, headerBytes + logicalBytes],
    [CHUNK_FILL, headerBytes + 4],
    [CHUNK_DONT_CARE, headerBytes],
    [CHUNK_CRC32, headerBytes + 4],
  ]).get(type);
  if (expected === undefined || totalBytes !== expected || (type === CHUNK_CRC32 && blocks !== 0)) {
    fail('data.PARTITION sparse chunk encoding is invalid');
  }
}

export function inspectSparseImage(imagePath) {
  const fd = fs.openSync(imagePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = sparseHeader(fd, fileSize);
    let fileOffset = header.fileHeaderBytes;
    let logicalBlocks = 0;
    for (let index = 0; index < header.totalChunks; index += 1) {
      const chunk = readAt(fd, header.chunkHeaderBytes, fileOffset, 'chunk header');
      const type = chunk.readUInt16LE(0);
      const blocks = chunk.readUInt32LE(4);
      const totalBytes = chunk.readUInt32LE(8);
      const logicalBytes = blocks * header.blockSize;
      if (!Number.isSafeInteger(logicalBytes) || fileOffset + totalBytes > fileSize) {
        fail('data.PARTITION sparse chunk is invalid');
      }
      validateChunk(type, blocks, totalBytes, header.chunkHeaderBytes, logicalBytes);
      logicalBlocks += blocks;
      fileOffset += totalBytes;
    }
    const logicalBytes = logicalBlocks * header.blockSize;
    if (logicalBlocks !== header.totalBlocks || !Number.isSafeInteger(logicalBytes)
        || fileOffset !== fileSize) fail('data.PARTITION sparse extent is inconsistent');
    return { blockSize: header.blockSize, logicalBytes, totalBlocks: header.totalBlocks,
      totalChunks: header.totalChunks };
  } finally {
    fs.closeSync(fd);
  }
}

export function validateSparseCapacity(imagePath, storageCapacityBytes, dataOffsetMiB,
  safetyMarginBytes) {
  for (const [name, value] of Object.entries({ storageCapacityBytes, dataOffsetMiB, safetyMarginBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid`);
  }
  const dataOffsetBytes = dataOffsetMiB * 1024 * 1024;
  const availableBytes = storageCapacityBytes - dataOffsetBytes - safetyMarginBytes;
  if (!Number.isSafeInteger(dataOffsetBytes) || availableBytes <= 0) {
    fail('data partition capacity is invalid');
  }
  const sparse = inspectSparseImage(imagePath);
  if (sparse.logicalBytes > availableBytes) {
    fail(`data.PARTITION logical size ${sparse.logicalBytes} exceeds ${availableBytes} available bytes`);
  }
  return {
    availableBytes, blockSize: sparse.blockSize, dataOffsetBytes,
    logicalBytes: sparse.logicalBytes, remainingBytes: availableBytes - sparse.logicalBytes,
    safetyMarginBytes, storageCapacityBytes, totalBlocks: sparse.totalBlocks,
    totalChunks: sparse.totalChunks,
  };
}

export function readSparseExt4Uuid(imagePath) {
  const fd = fs.openSync(imagePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = readAt(fd, SPARSE_HEADER_BYTES, 0, 'header');
    if (header.readUInt32LE(0) !== SPARSE_MAGIC || header.readUInt16LE(4) !== 1) {
      fail('data.PARTITION is not an Android sparse image');
    }
    const fileHeaderBytes = header.readUInt16LE(8);
    const chunkHeaderBytes = header.readUInt16LE(10);
    const blockBytes = header.readUInt32LE(12);
    const totalBlocks = header.readUInt32LE(16);
    const totalChunks = header.readUInt32LE(20);
    if (fileHeaderBytes < SPARSE_HEADER_BYTES || chunkHeaderBytes < CHUNK_HEADER_BYTES
        || blockBytes < 4096 || (blockBytes & (blockBytes - 1)) !== 0) {
      fail('data.PARTITION sparse header is invalid');
    }
    let fileOffset = fileHeaderBytes;
    let logicalOffset = 0;
    const wantedStart = EXT4_SUPERBLOCK_OFFSET;
    const wantedEnd = wantedStart + EXT4_UUID_OFFSET + EXT4_UUID_BYTES;
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = readAt(fd, chunkHeaderBytes, fileOffset, 'chunk header');
      const type = chunk.readUInt16LE(0);
      const blocks = chunk.readUInt32LE(4);
      const totalBytes = chunk.readUInt32LE(8);
      const logicalBytes = blocks * blockBytes;
      if (!Number.isSafeInteger(logicalBytes) || totalBytes < chunkHeaderBytes
          || fileOffset + totalBytes > fileSize) {
        fail('data.PARTITION sparse chunk is invalid');
      }
      const chunkEnd = logicalOffset + logicalBytes;
      if (wantedStart >= logicalOffset && wantedEnd <= chunkEnd) {
        if (type !== CHUNK_RAW || totalBytes !== chunkHeaderBytes + logicalBytes) {
          fail('ext4 superblock is not in a raw sparse chunk');
        }
        const dataOffset = fileOffset + chunkHeaderBytes + wantedStart - logicalOffset;
        const superblock = readAt(fd, EXT4_UUID_OFFSET + EXT4_UUID_BYTES, dataOffset, 'ext4 superblock');
        if (superblock.readUInt16LE(EXT4_MAGIC_OFFSET) !== 0xef53) {
          fail('data.PARTITION does not contain an ext4 filesystem');
        }
        return formatUuid(superblock.subarray(EXT4_UUID_OFFSET, EXT4_UUID_OFFSET + EXT4_UUID_BYTES));
      }
      logicalOffset = chunkEnd;
      fileOffset += totalBytes;
    }
    if (logicalOffset !== totalBlocks * blockBytes) fail('data.PARTITION sparse blocks are inconsistent');
    fail('data.PARTITION does not contain an inspectable ext4 superblock');
  } finally {
    fs.closeSync(fd);
  }
}
