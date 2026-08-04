const SIZE_TABLE_BYTES = 8;
const LEGACY_HEADER_BYTES = 64;
const LEGACY_MAGIC = 0x27051956;
const LEGACY_SCRIPT_TYPE = 6;
const LEGACY_NONE_COMPRESSION = 0;

function fail(message) {
  throw new Error(`invalid U-Boot script payload: ${message}`);
}

export function extractUbootScriptBody(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < SIZE_TABLE_BYTES) {
    fail('missing size table');
  }

  const scriptLength = payload.readUInt32BE(0);
  const terminator = payload.readUInt32BE(4);
  if (terminator !== 0) fail('missing size-table terminator');
  if (scriptLength === 0) fail('declared script length is zero');

  const scriptEnd = SIZE_TABLE_BYTES + scriptLength;
  if (scriptEnd > payload.length) fail('declared script length exceeds payload');

  if (payload.length !== scriptEnd) fail('trailing data is not allowed');

  return Buffer.from(payload.subarray(SIZE_TABLE_BYTES, scriptEnd));
}

export function validateUbootScriptImage(image, dumpimagePayload) {
  if (!Buffer.isBuffer(image) || image.length < LEGACY_HEADER_BYTES) {
    fail('missing legacy header');
  }
  if (image.readUInt32BE(0) !== LEGACY_MAGIC) fail('invalid legacy magic');
  const dataSize = image.readUInt32BE(12);
  if (dataSize !== image.length - LEGACY_HEADER_BYTES) fail('legacy data size mismatch');
  if (image[30] !== LEGACY_SCRIPT_TYPE) fail('unexpected image type');
  if (image[31] !== LEGACY_NONE_COMPRESSION) fail('unexpected compression');
  if (!Buffer.isBuffer(dumpimagePayload) || dumpimagePayload.length !== dataSize) {
    fail('dumpimage payload size mismatch');
  }
  if (!image.subarray(LEGACY_HEADER_BYTES).equals(dumpimagePayload)) {
    fail('dumpimage payload does not match legacy image');
  }
}
