import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/burn-image.mjs', import.meta.url));
const partitionOverlay = fileURLToPath(
  new URL('../board-overlays/burn-partitions.dtso', import.meta.url),
);
const sourceBuiltDts = fileURLToPath(
  new URL('./fixtures/source-built-b860av11t.dts', import.meta.url),
);
const partitions = [
  ['conf', '0 400000', '1'],
  ['logo', '0 2000000', '1'],
  ['recovery', '0 2000000', '1'],
  ['rsv', '0 800000', '1'],
  ['tee', '0 800000', '1'],
  ['crypt', '0 2000000', '1'],
  ['misc', '0 2000000', '1'],
  ['boot', '0 2000000', '1'],
  ['system', '0 40000000', '1'],
  ['cache', '0 30000000', '2'],
  ['data', 'ffffffff ffffffff', '4'],
];

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b860-standalone-dtb-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fdtget(dtb, node, property, type) {
  const args = [];
  if (type) args.push('-t', type);
  args.push(dtb, node, property);
  return childProcess.execFileSync('fdtget', args, { encoding: 'utf8' }).trim();
}

function generate(input, output) {
  return childProcess.spawnSync(
    process.execPath,
    [cli, 'standalone-dtb', input, partitionOverlay, output],
    { encoding: 'utf8' },
  );
}

test('standalone DTB CLI emits an unpadded P211 FDT with the stock partition table', (context) => {
  const directory = fixture(context);
  const input = path.join(directory, 'board.dtb');
  const output = path.join(directory, 'meson1.dtb');
  childProcess.execFileSync('dtc', [
    '-q', '-I', 'dts', '-O', 'dtb', '-o', input, sourceBuiltDts,
  ]);

  const result = generate(input, output);

  assert.equal(result.status, 0, result.stderr);
  const image = fs.readFileSync(output);
  const fdtSize = image.readUInt32BE(4);
  assert.equal(image.readUInt32BE(0), 0xd00dfeed);
  assert.ok(fdtSize > 8);
  assert.equal(image.length, fdtSize);
  assert.equal(fdtget(output, '/', 'compatible'), 'amlogic,p212 amlogic,s905x amlogic,meson-gxl');
  assert.equal(fdtget(output, '/', 'amlogic-dt-id'), 'gxl_p211_1g');
  assert.match(fdtget(output, '/soc/ethernet@c9410000', 'compatible'), /meson-gxbb-dwmac/);
  assert.match(fdtget(output, '/soc/apb@d0000000/mmc@74000', 'compatible'), /meson-gx-mmc/);
  assert.match(fdtget(output, '/soc/hdmi-tx@c883a000', 'compatible'), /meson-gxl-dw-hdmi/);
  assert.equal(fdtget(output, '/soc/apb@d0000000/mmc@74000', 'max-frequency'), '50000000');
  const symbols = childProcess.spawnSync('fdtget', ['-l', output, '/__symbols__'], {
    encoding: 'utf8',
  });
  assert.notEqual(symbols.status, 0, 'runtime FDT must not retain overlay symbols');
  assert.ok(image.length <= 36864, 'runtime FDT must fit the stock P211 slot');

  const children = childProcess.execFileSync('fdtget', ['-l', output, '/partitions'], {
    encoding: 'utf8',
  }).trim().split(/\r?\n/);
  assert.deepEqual(children.toSorted(), partitions.map(([name]) => name).toSorted());
  assert.equal(fdtget(output, '/partitions', 'parts', 'x'), 'b');
  partitions.forEach(([name, size, mask], index) => {
    assert.equal(fdtget(output, `/partitions/${name}`, 'pname'), name);
    assert.equal(fdtget(output, `/partitions/${name}`, 'size', 'x'), size);
    assert.equal(fdtget(output, `/partitions/${name}`, 'mask', 'x'), mask);
    assert.equal(
      fdtget(output, '/partitions', `part-${index}`, 'x'),
      fdtget(output, `/partitions/${name}`, 'phandle', 'x'),
    );
  });

  const validation = childProcess.spawnSync(
    process.execPath,
    [cli, 'check-standalone-dtb', output],
    { encoding: 'utf8' },
  );
  assert.equal(validation.status, 0, validation.stderr);
  assert.deepEqual(JSON.parse(validation.stdout), {
    size: fdtSize,
    fdtSize,
    target: 'gxl_p211_1g',
    partitions: partitions.map(([name]) => name),
    layoutMiB: {
      bootloader: 0,
      reserved: 36,
      cache: 108,
      env: 884,
      conf: 900,
      logo: 912,
      recovery: 952,
      rsv: 992,
      tee: 1008,
      crypt: 1024,
      misc: 1064,
      boot: 1104,
      system: 1144,
      data: 2176,
    },
  });
});

test('standalone DTB validation rejects the wrong stock target id', (context) => {
  const directory = fixture(context);
  const source = path.join(directory, 'legacy.dts');
  const input = path.join(directory, 'legacy.dtb');
  const output = path.join(directory, 'meson1.dtb');
  fs.writeFileSync(source, `/dts-v1/;
/ {
  compatible = "amlogic,p212", "amlogic,s905x", "amlogic,meson-gxl";
  soc {
    ethernet@c9410000 { compatible = "amlogic,meson-gxbb-dwmac"; };
    apb@d0000000 { mmc@74000 { compatible = "amlogic,meson-gx-mmc"; }; };
    hdmi-tx@c883a000 { compatible = "amlogic,meson-gxl-dw-hdmi"; };
  };
};
`);
  childProcess.execFileSync('dtc', ['-q', '-I', 'dts', '-O', 'dtb', '-o', input, source]);
  const generated = generate(input, output);
  assert.equal(generated.status, 0, generated.stderr);

  childProcess.execFileSync('fdtput', ['-t', 's', output, '/', 'amlogic-dt-id', 'gxl_p212_1g']);
  const result = childProcess.spawnSync(
    process.execPath,
    [cli, 'check-standalone-dtb', output],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gxl_p211_1g/);
});
