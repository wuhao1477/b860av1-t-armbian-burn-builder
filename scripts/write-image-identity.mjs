#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  IMAGE_IDENTITY_PATH,
  buildImageIdentity,
} from '../src/image-identity.mjs';

function safeIdentityDirectory(root) {
  const rootPath = fs.realpathSync(root);
  const directory = path.join(rootPath, path.dirname(IMAGE_IDENTITY_PATH));
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const relative = path.relative(rootPath, fs.realpathSync(directory));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('image identity directory escapes the mounted root');
  }
  return directory;
}

export function writeImageIdentity(root, manifestPath, kernelRelease) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  const identity = buildImageIdentity({
    boardProfile: manifest.board?.profile,
    manifestFingerprint: manifest.fingerprint,
    kernelVersion: manifest.sources?.kernel?.version,
    kernelRelease,
  });
  const directory = safeIdentityDirectory(path.resolve(root));
  const target = path.join(directory, path.basename(IMAGE_IDENTITY_PATH));
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error('image identity target is not a regular file');
  const temporary = path.join(directory, `.image-identity.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o644);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return identity;
}

function main(argv) {
  const [root, manifestPath, kernelRelease] = argv;
  if (!root || !manifestPath || !kernelRelease) {
    throw new Error('usage: write-image-identity.mjs root-mount resolved-sources.json kernel-release');
  }
  process.stdout.write(`${JSON.stringify(writeImageIdentity(root, manifestPath, kernelRelease))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
