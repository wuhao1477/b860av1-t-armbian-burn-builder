import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

async function fileEvidence(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return {
    name: basename(filePath),
    size: (await stat(filePath)).size,
    sha256: hash.digest('hex'),
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function buildBurnReport({
  burnPath,
  emmcBootContractPath,
  mainlineFipContractPath,
  rawSourcePath,
  rootfsContractPath,
}) {
  const [burn, source, emmcBoot, mainlineFip, rootfs] = await Promise.all([
    fileEvidence(burnPath),
    fileEvidence(rawSourcePath),
    readJson(emmcBootContractPath),
    readJson(mainlineFipContractPath),
    readJson(rootfsContractPath),
  ]);
  return {
    schemaVersion: 4,
    status: 'format-valid / hardware-unverified',
    board: 'ZXV10 B860AV1.1-T',
    burn,
    source,
    emmcBoot,
    mainlineFip,
    rootfs,
  };
}

export async function validateBurnReport({ reportPath, ...inputs }) {
  const [actual, expected] = await Promise.all([
    readJson(reportPath),
    buildBurnReport(inputs),
  ]);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('burn report does not match independently validated evidence');
  }
  return actual;
}
