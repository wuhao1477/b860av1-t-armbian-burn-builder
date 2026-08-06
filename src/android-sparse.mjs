import fs from 'node:fs';

const SPARSE_MAGIC = 0xed26ff3a;
const SPARSE_HEADER_BYTES = 28;
const CHUNK_HEADER_BYTES = 12;
const CHUNK_RAW = 0xcac1;
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
