const DECIMAL_8GB = 8_000_000_000;

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

export function imageSizeLimit(board) {
  const capacity = requireSafeInteger(board?.storageCapacityBytes, 'storage capacity');
  const margin = requireSafeInteger(board?.storageSafetyMarginBytes, 'storage safety margin');
  if (capacity <= 0 || capacity > DECIMAL_8GB) {
    throw new Error('storage capacity exceeds the decimal 8GB board contract');
  }
  if (margin >= capacity) throw new Error('storage safety margin must be smaller than capacity');
  return capacity - margin;
}
