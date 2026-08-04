function memoryToken(memoryLimitMiB) {
  if (!Number.isInteger(memoryLimitMiB) || memoryLimitMiB < 256 || memoryLimitMiB > 4096) {
    throw new Error('memory limit must be an integer from 256 to 4096 MiB');
  }
  return `mem=${memoryLimitMiB}M`;
}

export function applyMemoryLimit(text, memoryLimitMiB) {
  if (typeof text !== 'string') throw new TypeError('boot config must be text');
  const token = memoryToken(memoryLimitMiB);
  let changed = 0;
  const output = text.split(/\n/).map((line) => {
    if (!/^\s*(?:APPEND=|append\s+)/.test(line)) return line;
    changed += 1;
    const withoutMemory = line.replace(/[ \t]+mem=\d+[KMG](?=[ \t]|$)/gi, '').replace(/[ \t]+$/, '');
    return `${withoutMemory} ${token}`;
  }).join('\n');
  if (changed === 0) throw new Error('boot argument line is missing');
  return output;
}
