import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_SOURCE_BYTES = 256 * 1024;
const BINARY_SUFFIX = /\.(?:img|img\.gz|img\.xz|burn|iso|bin|deb|apk|zip|7z|rar|tar|tgz|xz|gz)$/i;

export function inspectTrackedFiles(projectRoot) {
  const root = resolve(projectRoot instanceof URL ? fileURLToPath(projectRoot) : projectRoot.toString());
  const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const violations = [];
  for (const relative of paths) {
    const absolute = resolve(root, relative);
    const size = statSync(absolute).size;
    if (size > MAX_SOURCE_BYTES) violations.push(`${relative}: exceeds ${MAX_SOURCE_BYTES} bytes`);
    if (BINARY_SUFFIX.test(relative)) violations.push(`${relative}: binary payload suffix is not allowed`);
    if (readFileSync(absolute).includes(0)) violations.push(`${relative}: contains NUL bytes`);
  }
  return violations.sort();
}
