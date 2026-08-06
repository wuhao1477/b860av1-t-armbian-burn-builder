import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';

import {
  inspectFatBootImage,
  inspectFatBootFiles,
  inspectDosMbr,
  inspectUbootEnvironment,
  validateEmmcBootChain,
  writeDosMbr,
  writeUbootEnvironment,
} from '../src/emmc-boot-chain.mjs';
import { makeSparse } from '../scripts/burn-image.mjs';

const MIB = 1024 * 1024;
const STOCK_ENV = new URL('../config/stock-environment.json', import.meta.url);
const CLI = new URL('../scripts/burn-image.mjs', import.meta.url);

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-emmc-chain-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('U-Boot environment preserves the vendor defaults and starts the eMMC autoscript', (context) => {
  const directory = fixture(context);
  const output = path.join(directory, 'env.PARTITION');

  writeUbootEnvironment(STOCK_ENV, output);
  const image = fs.readFileSync(output);
  const result = inspectUbootEnvironment(output);

  assert.equal(image.length, 65_536);
  assert.equal(image.readUInt32LE(0), crc32(image.subarray(4)));
  assert.equal(result.variableCount, 82);
  assert.equal(result.variables.bootcmd, 'run start_emmc_autoscript; run storeboot');
  assert.equal(
    result.variables.start_emmc_autoscript,
    'if fatload mmc 1 1020000 emmc_autoscript; then autoscr 1020000; fi;',
  );
  assert.equal(result.variables.upgrade_step, '2');
  assert.equal(result.variables.init_display.startsWith('imgread pic logo bootup'), true);
  assert.equal(result.variables.irremote_update.includes('\n'), true);
});

test('U-Boot environment validation rejects a modified CRC payload', (context) => {
  const directory = fixture(context);
  const output = path.join(directory, 'env.PARTITION');
  writeUbootEnvironment(STOCK_ENV, output);
  const image = fs.readFileSync(output);
  image[4096] ^= 0xff;
  fs.writeFileSync(output, image);

  assert.throws(() => inspectUbootEnvironment(output), /CRC32/);
});

test('DOS MBR maps the FAT boot and ext4 root filesystems to their Amlogic offsets', (context) => {
  const directory = fixture(context);
  const output = path.join(directory, '1.PARTITION');

  writeDosMbr(output, 512 * MIB, 3000 * MIB);
  const image = fs.readFileSync(output);
  const result = inspectDosMbr(output);

  assert.equal(image.length, 512);
  assert.equal(image.readUInt16LE(510), 0xaa55);
  assert.deepEqual(result.partitions, [
    { index: 1, bootable: false, type: 0x0c, startLba: 2_342_912, sectors: 1_048_576 },
    { index: 2, bootable: false, type: 0x83, startLba: 4_456_448, sectors: 6_144_000 },
  ]);
});

test('DOS MBR generation rejects a FAT image that crosses the rootfs start', (context) => {
  const directory = fixture(context);
  const output = path.join(directory, '1.PARTITION');

  assert.throws(
    () => writeDosMbr(output, 1100 * MIB, 3000 * MIB),
    /overlaps the root filesystem/,
  );
  assert.equal(fs.existsSync(output), false);
});

function writeFatFixture(filePath) {
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 256 * MIB);
  childProcess.execFileSync(
    'mformat', ['-i', filePath, '-F', '-N', '00000000', '-v', 'BOOT', '::'],
    { stdio: 'ignore' },
  );
  for (const [name, contents] of [
    ['emmc_autoscript', 'compiled boot script'],
    ['u-boot.emmc', Buffer.alloc(4096, 0x5a)],
    ['uEnv.txt', [
      'LINUX=/Image',
      'INITRD=/uInitrd',
      'FDT=/dtb/amlogic/board.dtb',
      'APPEND=root=UUID=50031852-ee90-4285-ada7-ab9dc14670c9 rw',
      '',
    ].join('\n')],
    ['Image', Buffer.alloc(8192, 0x11)],
    ['uInitrd', Buffer.alloc(4096, 0x22)],
  ]) {
    const source = path.join(path.dirname(filePath), `${name}.source`);
    fs.writeFileSync(source, contents);
    childProcess.execFileSync('mcopy', ['-o', '-i', filePath, source, `::${name}`]);
  }
  childProcess.execFileSync('mmd', ['-i', filePath, '::dtb', '::dtb/amlogic']);
  const dtbSource = path.join(path.dirname(filePath), 'board.dtb.source');
  fs.writeFileSync(dtbSource, Buffer.alloc(2048, 0x33));
  childProcess.execFileSync(
    'mcopy', ['-o', '-i', filePath, dtbSource, '::dtb/amlogic/board.dtb'],
  );
}

test('eMMC boot contract binds MBR entries to the FAT boot and sparse ext4 images', (context) => {
  const directory = fixture(context);
  const mbr = path.join(directory, '1.PARTITION');
  const environment = path.join(directory, 'env.PARTITION');
  const fat = path.join(directory, 'system.PARTITION');
  const root = path.join(directory, 'rootfs.ext4');
  const sparse = path.join(directory, 'data.PARTITION');
  const fatBytes = 256 * MIB;
  const rootBytes = 8 * MIB;
  writeFatFixture(fat);
  const rootImage = Buffer.alloc(rootBytes);
  rootImage.writeUInt16LE(0xef53, 1024 + 0x38);
  Buffer.from('50031852ee904285ada7ab9dc14670c9', 'hex').copy(rootImage, 1024 + 0x68);
  fs.writeFileSync(root, rootImage);
  makeSparse(root, sparse, rootBytes);
  writeDosMbr(mbr, fatBytes, rootBytes);
  writeUbootEnvironment(STOCK_ENV, environment);

  const fatResult = inspectFatBootImage(fat);
  assert.equal(fatResult.bytesPerSector, 512);
  assert.equal(fatResult.size, fatBytes);
  assert.equal(fatResult.totalSectors, fatBytes / 512);
  assert.equal(fatResult.type, 'FAT32');
  const result = validateEmmcBootChain(mbr, environment, fat, sparse);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.strategy, 'stock-fip-env-emmc-fat');
  assert.equal(result.rootUuid, '50031852-ee90-4285-ada7-ab9dc14670c9');
  assert.equal(result.fat.startMiB, 1144);
  assert.deepEqual(result.fat.files.map(({ path: file }) => file), [
    'emmc_autoscript', 'u-boot.emmc', 'uEnv.txt', '/Image', '/uInitrd',
    '/dtb/amlogic/board.dtb',
  ]);
  assert.equal(result.fat.files.every(({ size }) => size > 0), true);
  assert.equal(result.rootfs.startMiB, 2176);
  assert.equal(result.environment.variableCount, 82);
});

test('FAT boot inspection rejects a kernel referenced by uEnv.txt but absent from the image', (context) => {
  const directory = fixture(context);
  const fat = path.join(directory, 'system.PARTITION');
  writeFatFixture(fat);
  childProcess.execFileSync('mdel', ['-i', fat, '::Image']);

  assert.throws(() => inspectFatBootFiles(fat), /lacks \/Image/);
});

test('eMMC boot contract rejects an MBR partition length that differs from FAT', (context) => {
  const directory = fixture(context);
  const mbr = path.join(directory, '1.PARTITION');
  const environment = path.join(directory, 'env.PARTITION');
  const fat = path.join(directory, 'system.PARTITION');
  const root = path.join(directory, 'rootfs.ext4');
  const sparse = path.join(directory, 'data.PARTITION');
  writeFatFixture(fat);
  const rootImage = Buffer.alloc(8 * MIB);
  rootImage.writeUInt16LE(0xef53, 1024 + 0x38);
  Buffer.alloc(16, 0x11).copy(rootImage, 1024 + 0x68);
  fs.writeFileSync(root, rootImage);
  makeSparse(root, sparse, rootImage.length);
  writeDosMbr(mbr, (256 * MIB) + 512, rootImage.length);
  writeUbootEnvironment(STOCK_ENV, environment);

  assert.throws(
    () => validateEmmcBootChain(mbr, environment, fat, sparse),
    /FAT partition length differs/,
  );
});

test('burn image CLI emits environment and MBR payloads for the factory package', (context) => {
  const directory = fixture(context);
  const environment = path.join(directory, 'env.PARTITION');
  const mbr = path.join(directory, '1.PARTITION');
  const envResult = childProcess.spawnSync(process.execPath, [
    CLI.pathname, 'uboot-env', STOCK_ENV.pathname, environment,
  ], { encoding: 'utf8' });
  const mbrResult = childProcess.spawnSync(process.execPath, [
    CLI.pathname, 'dos-mbr', mbr, String(512 * MIB), String(3000 * MIB),
  ], { encoding: 'utf8' });

  assert.equal(envResult.status, 0, envResult.stderr);
  assert.equal(mbrResult.status, 0, mbrResult.stderr);
  assert.equal(JSON.parse(envResult.stdout).variableCount, 82);
  assert.equal(JSON.parse(mbrResult.stdout).partitions[0].startLba, 2_342_912);
});
