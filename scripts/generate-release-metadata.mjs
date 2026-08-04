#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildReleaseMetadata } from '../src/release-metadata.mjs';

function parseArgs(argv) {
  const options = { assets: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--assets', '--output'].includes(option) || options[option.slice(2)] !== null) {
      throw new Error(`unknown or duplicate argument: ${option}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    options[option.slice(2)] = value;
  }
  if (!options.assets || !options.output) {
    throw new Error('usage: generate-release-metadata.mjs --assets directory --output release-metadata.json');
  }
  return options;
}

function parseJson(bytes, name) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
}

export async function generateReleaseMetadata(assetsDirectory) {
  const root = resolve(assetsDirectory);
  const [manifestBytes, reportBytes, filesystemManifestBytes, releaseTagBytes, qemuBytes] = await Promise.all([
    readFile(join(root, 'resolved-sources.json')),
    readFile(join(root, 'validation-report.json')),
    readFile(join(root, 'filesystem-manifest.sha256')),
    readFile(join(root, 'release-tag.txt')),
    readFile(join(root, 'qemu-system-smoke.json')),
  ]);
  return buildReleaseMetadata({
    manifest: parseJson(manifestBytes, 'resolved-sources.json'),
    report: parseJson(reportBytes, 'validation-report.json'),
    filesystemManifest: filesystemManifestBytes.toString('utf8'),
    filesystemManifestBytes,
    releaseTag: releaseTagBytes.toString('utf8'),
    qemuSystemSmoke: parseJson(qemuBytes, 'qemu-system-smoke.json'),
    qemuSystemSmokeBytes: qemuBytes,
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  const metadata = await generateReleaseMetadata(options.assets);
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
