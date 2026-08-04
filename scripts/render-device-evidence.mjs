#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseSerialLog,
  redactSensitiveText,
  validateDeviceEvidence,
} from '../src/device-evidence.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export async function renderDeviceEvidence(payload, serialSource, outputDirectory) {
  const normalized = redactSensitiveText(serialSource);
  const context = {
    evidenceId: payload.evidenceId,
    manifestFingerprint: payload.release?.manifestFingerprint,
    kernelRelease: payload.identity?.kernelRelease,
  };
  parseSerialLog(normalized, context);
  const evidence = {
    ...payload,
    serial: {
      asset: 'device-serial.log',
      sha256: sha256(normalized),
      bootFromPowerOn: true,
      linuxReady: true,
      androidMarkersAbsent: true,
    },
  };
  validateDeviceEvidence(evidence, { serialLog: normalized });
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await writeFile(resolve(directory, 'device-serial.log'), normalized, { mode: 0o600 });
  await writeFile(
    resolve(directory, 'device-validation.json'),
    `${JSON.stringify(stableValue(evidence), null, 2)}\n`,
    { mode: 0o600 },
  );
  return evidence;
}

async function main(argv) {
  const [payloadPath, serialPath, outputDirectory] = argv;
  if (!payloadPath || !serialPath || !outputDirectory) {
    throw new Error('usage: render-device-evidence.mjs payload.json serial.log output-dir');
  }
  const payload = JSON.parse(await readFile(resolve(payloadPath), 'utf8'));
  const serial = await readFile(resolve(serialPath), 'utf8');
  await renderDeviceEvidence(payload, serial, outputDirectory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

