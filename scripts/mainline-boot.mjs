#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  createFitSource,
  createMainlineBootCommand,
  inspectMainlineBootCommand,
  validateMainlineFipEvidence,
} from '../src/mainline-boot-contract.mjs';

function fail(message) {
  throw new Error(message);
}

function fileEvidence(file) {
  const data = fs.readFileSync(file);
  return {
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}

function ubootVersion(image) {
  const start = image.indexOf(Buffer.from('U-Boot 2023.01'));
  if (start < 0) fail('raw BL33 has no U-Boot 2023.01 version');
  const end = image.indexOf(0, start);
  const version = image.subarray(start, end < 0 ? start + 160 : end).toString('ascii');
  if (!version.includes('r3300l')) fail('raw BL33 is not the R3300L U-Boot build');
  return version;
}

function environmentValue(image, name) {
  const marker = Buffer.from(`${name}=`);
  const values = [];
  let offset = 0;
  while ((offset = image.indexOf(marker, offset)) >= 0) {
    if (offset === 0 || image[offset - 1] === 0) {
      const end = image.indexOf(0, offset);
      if (end > offset) values.push(image.subarray(offset + marker.length, end).toString('ascii'));
    }
    offset += marker.length;
  }
  const unique = [...new Set(values)];
  if (unique.length !== 1) fail(`raw BL33 must contain one ${name} environment value`);
  return unique[0];
}

function fixedHex(value, label) {
  if (!/^0x[0-9a-f]+$/iu.test(value)) fail(`raw BL33 ${label} is invalid`);
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 0xffffffff) {
    fail(`raw BL33 ${label} is invalid`);
  }
  return `0x${parsed.toString(16).padStart(8, '0')}`;
}

function inspectRawUboot(rawUboot) {
  const image = fs.readFileSync(rawUboot);
  const text = image.toString('latin1');
  for (const marker of ['storeboot', 'imgread', 'boot_android', 'ANDROID!']) {
    if (text.includes(marker)) fail(`raw BL33 contains prohibited marker: ${marker}`);
  }
  const defaultBootCommand = environmentValue(image, 'bootcmd');
  return {
    version: ubootVersion(image),
    defaultBootCommand,
    ...inspectMainlineBootCommand(defaultBootCommand),
    bootTargets: environmentValue(image, 'boot_targets').split(/\s+/u).filter(Boolean),
    kernelCompAddress: fixedHex(environmentValue(image, 'kernel_comp_addr_r'), 'kernel_comp_addr_r'),
    kernelCompSize: fixedHex(environmentValue(image, 'kernel_comp_size'), 'kernel_comp_size'),
    rawSha256: fileEvidence(rawUboot).sha256,
  };
}

function componentEvidence(directory, name) {
  return fileEvidence(`${directory}/${name}`);
}

export function buildMainlineFipEvidence(fip, components, rawUboot) {
  return validateMainlineFipEvidence({
    schemaVersion: 1,
    status: 'format-valid / hardware-unverified',
    strategy: 'vendor-fip-mainline-bl33-fit',
    fip: {
      ...fileEvidence(fip),
      components: {
        bl2: componentEvidence(components, 'bl2.sign'),
        bl30: componentEvidence(components, 'bl30.enc'),
        bl301: componentEvidence(components, 'bl301.enc'),
        bl31: componentEvidence(components, 'bl31.enc'),
        bl33: componentEvidence(components, 'bl33.enc'),
      },
    },
    uboot: inspectRawUboot(rawUboot),
  });
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main([command, ...args]) {
  if (command === 'fit-source' && args.length === 0) {
    process.stdout.write(createFitSource());
  } else if (command === 'boot-command' && args.length === 2) {
    process.stdout.write(`${createMainlineBootCommand(args[0], Number(args[1]))}\n`);
  } else if (command === 'fip-evidence' && args.length === 3) {
    write(buildMainlineFipEvidence(...args));
  } else if (command === 'check-evidence' && args.length === 1) {
    write(validateMainlineFipEvidence(JSON.parse(fs.readFileSync(args[0], 'utf8'))));
  } else {
    fail('usage: mainline-boot.mjs fit-source | boot-command root-uuid fit-bytes | fip-evidence bootloader.PARTITION components-dir raw-uboot | check-evidence evidence.json');
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
