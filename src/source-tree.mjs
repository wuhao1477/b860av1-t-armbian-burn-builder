import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalStringify } from './canonical-json.mjs';

function fileSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function modeOf(stats) {
  return (stats.mode & 0o777).toString(8).padStart(3, '0');
}

function collectEntries(root, relative, output) {
  const directory = path.join(root, relative);
  const names = fs.readdirSync(directory).filter((name) => name !== '.git').sort();
  for (const name of names) {
    const entryPath = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, entryPath);
    const stats = fs.lstatSync(absolute);
    if (stats.isDirectory()) {
      output.push({ mode: modeOf(stats), path: entryPath, type: 'directory' });
      collectEntries(root, entryPath, output);
    } else if (stats.isFile()) {
      output.push({ mode: modeOf(stats), path: entryPath, sha256: fileSha256(absolute), size: stats.size, type: 'file' });
    } else if (stats.isSymbolicLink()) {
      output.push({ mode: modeOf(stats), path: entryPath, target: fs.readlinkSync(absolute), type: 'symlink' });
    } else {
      throw new Error(`unsupported source tree entry: ${entryPath}`);
    }
  }
}

export function sourceTreeFingerprint(root) {
  const stats = fs.statSync(root);
  if (!stats.isDirectory()) throw new Error('source tree root must be a directory');
  const entries = [];
  collectEntries(path.resolve(root), '', entries);
  return createHash('sha256').update(canonicalStringify(entries)).digest('hex');
}
