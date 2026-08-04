#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function renderDeviceValidationSummary(result, outputPath) {
  const summary = result?.summary ?? result;
  if (!summary || summary.status !== 'operator-attested / one-device') throw new Error('device validation summary status is invalid');
  const lines = [
    '# B860AV1.1-T device validation',
    '',
    `Status: \`${summary.status}\``,
    '',
    `- Release tag: \`${summary.tag}\``,
    `- Image: \`${summary.image}\``,
    `- Image SHA-256: \`${summary.imageSha256}\``,
    `- Manifest fingerprint: \`${summary.manifestFingerprint}\``,
    `- Kernel release: \`${summary.kernelRelease}\``,
    `- Evidence ID: \`${summary.evidenceId}\``,
    `- Collected at: \`${summary.collectedAt}\``,
    '',
    `Trust limitation: ${summary.trustLimitation}`,
    '',
    'The original static Release report remains `container-valid / hardware-unverified`.',
    '',
  ];
  const body = lines.join('\n');
  if (outputPath) writeFileSync(resolve(outputPath), body);
  else process.stdout.write(body);
  return body;
}

function main(argv) {
  const [resultPath, outputPath] = argv;
  if (!resultPath) throw new Error('usage: render-device-validation-summary.mjs validation-summary.json [output.md]');
  renderDeviceValidationSummary(JSON.parse(readFileSync(resolve(resultPath), 'utf8')), outputPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

