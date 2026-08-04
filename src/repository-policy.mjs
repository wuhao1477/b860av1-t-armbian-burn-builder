import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const MAX_SOURCE_BYTES = 256 * 1024;
const BINARY_SUFFIX = /\.(?:img|img\.gz|img\.xz|burn|iso|bin|deb|apk|zip|7z|rar|tar|tgz|xz|gz)$/i;
const BOARD_INPUT_PREFIX = 'board-inputs/';

function boardInputAllowlist(root) {
  const configPath = resolve(root, 'config/burn-inputs.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config.files && typeof config.files === 'object' ? config.files : {};
  } catch {
    return {};
  }
}

export function inspectTrackedFiles(projectRoot) {
  const root = resolve(projectRoot instanceof URL ? fileURLToPath(projectRoot) : projectRoot.toString());
  const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const violations = [];
  const boardInputs = boardInputAllowlist(root);
  for (const relative of paths) {
    const absolute = resolve(root, relative);
    if (relative.startsWith(BOARD_INPUT_PREFIX)) {
      const name = relative.slice(BOARD_INPUT_PREFIX.length);
      const expected = boardInputs[name];
      if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
        violations.push(`${relative}: board input is not allowlisted`);
        continue;
      }
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      if (digest !== expected.toLowerCase()) {
        violations.push(`${relative}: sha256 does not match config/burn-inputs.json`);
      }
      continue;
    }
    const size = statSync(absolute).size;
    if (size > MAX_SOURCE_BYTES) violations.push(`${relative}: exceeds ${MAX_SOURCE_BYTES} bytes`);
    if (BINARY_SUFFIX.test(relative)) violations.push(`${relative}: binary payload suffix is not allowed`);
    if (readFileSync(absolute).includes(0)) violations.push(`${relative}: contains NUL bytes`);
  }
  return violations.sort();
}
