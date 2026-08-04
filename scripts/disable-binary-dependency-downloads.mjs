#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function disableBinaryDependencyDownloads(source) {
  const start = source.indexOf('download_depends() {');
  const endMarker = '\n}\n\nquery_kernel() {';
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('cannot locate the expected download_depends() function');
  const original = source.slice(start, end + 2);
  for (const required of ['git_pull_dir "${uboot_repo}"', 'git_pull_dir "${firmware_repo}"']) {
    if (!original.includes(required)) throw new Error(`unexpected upstream download_depends() body: ${required}`);
  }
  const replacement = [
    'download_depends() {',
    '    echo -e "${INFO} External U-Boot and firmware binary dependency downloads are disabled."',
    '}',
  ].join('\n');
  const patched = `${source.slice(0, start)}${replacement}${source.slice(end + 2)}`;
  if (patched.includes('git_pull_dir "${uboot_repo}"') || patched.includes('git_pull_dir "${firmware_repo}"')) {
    throw new Error('binary dependency download calls remain after patching');
  }
  return patched;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scriptPath] = process.argv.slice(2);
  if (!scriptPath) {
    process.stderr.write('usage: disable-binary-dependency-downloads.mjs rebuild\n');
    process.exit(2);
  }
  try {
    const source = fs.readFileSync(scriptPath, 'utf8');
    fs.writeFileSync(scriptPath, disableBinaryDependencyDownloads(source));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
