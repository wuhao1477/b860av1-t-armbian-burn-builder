#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  normalizeBl2ForEvidence,
  verifyBl2Seal,
} from '../src/emmc-boot-chain.mjs';
import {
  createExtlinuxConfig,
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
  const start = image.indexOf(Buffer.from('U-Boot 2026.01'));
  if (start < 0) fail('raw BL33 has no U-Boot 2026.01 version');
  const end = image.indexOf(0, start);
  const version = image.subarray(start, end < 0 ? start + 160 : end).toString('ascii');
  if (!version.includes('r3300-l')) fail('raw BL33 is not the R3300-L U-Boot build');
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
  return {
    version: ubootVersion(image),
    defaultBootCommand: environmentValue(image, 'bootcmd'),
    bootTargets: environmentValue(image, 'boot_targets').split(/\s+/u).filter(Boolean),
    kernelCompAddress: fixedHex(environmentValue(image, 'kernel_comp_addr_r'), 'kernel_comp_addr_r'),
    kernelCompSize: fixedHex(environmentValue(image, 'kernel_comp_size'), 'kernel_comp_size'),
    rawSha256: fileEvidence(rawUboot).sha256,
  };
}

function componentEvidence(directory, name) {
  return fileEvidence(`${directory}/${name}`);
}

/**
 * BL2 从 FIP 偏移 0 开始，所以它的 sector 0 就是 eMMC 的 LBA 0，
 * 446..511 由 DOS MBR 分区表占用（见 emmc-boot-chain.mjs 的 embedDosMbr）。
 * 那 66 字节落在 BL2 自身摘要覆盖的 [0x70,0xC000) 里，嵌完必须重算摘要，
 * 否则 bootrom 不执行 BL2。比对原厂值时把 MBR 清零、摘要恢复成原厂那份，
 * 只证明签名段本身没被改动；同时校验交付的摘要与内容自洽。
 */
function bl2Evidence(directory) {
  const filePath = `${directory}/bl2.sign`;
  verifyBl2Seal(filePath);
  const image = fs.readFileSync(filePath);
  return {
    size: image.length,
    sha256: crypto.createHash('sha256')
      .update(normalizeBl2ForEvidence(image)).digest('hex'),
  };
}

export function buildMainlineFipEvidence(fip, components, rawUboot) {
  return validateMainlineFipEvidence({
    schemaVersion: 1,
    status: 'format-valid / hardware-unverified',
    strategy: 'vendor-fip-mainline-bl33-extlinux',
    fip: {
      ...fileEvidence(fip),
      components: {
        bl2: bl2Evidence(components),
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
  if (command === 'extlinux' && args.length === 3) {
    process.stdout.write(createExtlinuxConfig(Number(args[0]), args[1], args[2]));
  } else if (command === 'fip-evidence' && args.length === 3) {
    write(buildMainlineFipEvidence(...args));
  } else if (command === 'check-evidence' && args.length === 1) {
    write(validateMainlineFipEvidence(JSON.parse(fs.readFileSync(args[0], 'utf8'))));
  } else {
    fail('usage: mainline-boot.mjs extlinux memory-mib root-uuid dtb-path | fip-evidence bootloader.PARTITION components-dir raw-uboot | check-evidence evidence.json');
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
