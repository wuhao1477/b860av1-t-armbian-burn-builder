#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EXPECTED_RTL8189FS_ALIAS,
  EXPECTED_RTL8189FS_MODULE_PATH,
  validateRtl8189fsMetadata,
} from '../src/rtl8189fs.mjs';

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function selectKernelRelease(modulesRoot, kernelRelease) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(kernelRelease)) {
    throw new Error('kernel release is invalid');
  }
  const moduleDirectory = join(modulesRoot, kernelRelease);
  if (!statSync(moduleDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`kernel module tree is missing: ${kernelRelease}`);
  }
  return kernelRelease;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateMountedRtl8189fs(rootPath, kernelRelease) {
  if (typeof kernelRelease !== 'string') {
    throw new Error('kernel release is invalid');
  }
  const root = resolve(rootPath);
  const modulesRoot = join(root, 'usr/lib/modules');
  const selectedRelease = selectKernelRelease(modulesRoot, kernelRelease);
  const moduleDirectory = join(modulesRoot, selectedRelease);
  const moduleFile = join(moduleDirectory, EXPECTED_RTL8189FS_MODULE_PATH);
  const aliasFile = join(moduleDirectory, 'modules.alias');
  const dependencyFile = join(moduleDirectory, 'modules.dep');
  if (!statSync(moduleFile).isFile()) throw new Error('RTL8189FS module file is missing');
  if (!statSync(aliasFile).isFile()) throw new Error('RTL8189FS modules.alias is missing');
  if (!statSync(dependencyFile).isFile()) throw new Error('RTL8189FS modules.dep is missing');
  const aliasDatabase = readFileSync(aliasFile, 'utf8');
  const dependencies = readFileSync(dependencyFile, 'utf8');
  const metadata = {
    kernelRelease: selectedRelease,
    modulePath: EXPECTED_RTL8189FS_MODULE_PATH,
    moduleFileType: commandOutput('file', ['--brief', moduleFile]),
    moduleName: commandOutput('modinfo', ['-F', 'name', moduleFile]),
    vermagic: commandOutput('modinfo', ['-F', 'vermagic', moduleFile]),
    aliases: commandOutput('modinfo', ['-F', 'alias', moduleFile]).split(/\r?\n/).filter(Boolean),
    aliasDatabase,
    dependencies,
    moduleSha256: sha256File(moduleFile),
    modulesAliasSha256: sha256File(aliasFile),
    modulesDepSha256: sha256File(dependencyFile),
  };
  validateRtl8189fsMetadata(metadata);
  return {
    kernelRelease: selectedRelease,
    modulePath: EXPECTED_RTL8189FS_MODULE_PATH,
    moduleName: basename(EXPECTED_RTL8189FS_MODULE_PATH, '.ko'),
    sdioAlias: EXPECTED_RTL8189FS_ALIAS,
    vermagic: metadata.vermagic,
    moduleFileType: metadata.moduleFileType,
    moduleSha256: metadata.moduleSha256,
    modulesAliasSha256: metadata.modulesAliasSha256,
    modulesDepSha256: metadata.modulesDepSha256,
  };
}

function main(argv) {
  if (argv.length !== 2) {
    throw new Error('usage: validate-rtl8189fs.mjs rootfs kernel-release');
  }
  process.stdout.write(`${JSON.stringify(validateMountedRtl8189fs(argv[0], argv[1]))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
