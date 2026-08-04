#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_SCAN_CHUNK_BYTES = 1024 * 1024;
const TEXT_SCAN_OVERLAP_BYTES = 512;
const ANDROID_ROOTS = new Set([
  'system',
  'vendor',
  'recovery',
  'product',
  'odm',
  'system_ext',
  'apex',
  'vendor_dlkm',
  'odm_dlkm',
]);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || !argv[index + 1]) throw new Error(`invalid argument: ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  return values;
}

function requireArgument(values, name) {
  if (!values[name]) throw new Error(`missing argument: --${name}`);
  return resolve(values[name]);
}

function requireValue(values, name, pattern) {
  const value = values[name];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`invalid argument: --${name}`);
  }
  return value;
}

function walkEntries(root) {
  const files = [];
  const directories = [];
  const symlinks = [];
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) symlinks.push(path);
      else if (entry.isDirectory()) {
        directories.push(path);
        pending.push(path);
      }
      else if (entry.isFile()) files.push(path);
    }
  }
  return {
    files: files.sort(),
    directories: directories.sort(),
    symlinks: symlinks.sort(),
  };
}

function rel(root, path) {
  return relative(resolve(root), path).split(sep).join('/');
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

export function pathMarkers(root, path) {
  const name = rel(root, path).toLowerCase();
  const parts = name.split('/');
  const first = parts[0];
  const findings = [];
  const linuxBinderPath = /^(?:usr\/include\/linux|usr\/src\/linux-headers-[^/]+\/include\/uapi\/linux)\/android(?:\/binder(?:fs)?\.h)?$/.test(name);
  if (parts.includes('android') && !linuxBinderPath) findings.push(`${name}: android path component`);
  if (ANDROID_ROOTS.has(first)) {
    findings.push(`${name}: Android root path`);
  }
  const base = basename(name);
  const artifact = /^(?:vendor_boot|super|dtbo|vbmeta|system|vendor|recovery|logo|metadata)(?:[-_.].*)?\.img$/i;
  if (artifact.test(base) || /^(?:payload\.bin|build\.prop)$/i.test(base)) {
    findings.push(`${name}: Android image or property artifact`);
  }
  if (/^(?:init(?:\.[^.]+)*|ueventd(?:\.[^.]+)*)\.rc$/i.test(base)
    || /^default\.prop$/i.test(base) || /^fstab\.(?:amlogic|qcom|samsung)$/i.test(base)) {
    findings.push(`${name}: Android init configuration`);
  }
  if (/\.(?:apk|apex|dex|odex|vdex)$/i.test(base)) findings.push(`${name}: Android package or bytecode`);
  if (/^(?:adbd|vold|zygote|surfaceflinger|hwservicemanager|servicemanager|app_process(?:32|64)?)$/i.test(base)) {
    findings.push(`${name}: Android executable name`);
  }
  return findings;
}

function symlinkMarkers(root, path) {
  const rawTarget = readlinkSync(path).replaceAll('\\', '/');
  const linkName = rel(root, path);
  const targetPath = rawTarget.startsWith('/')
    ? posix.normalize(rawTarget)
    : posix.normalize(posix.join('/', posix.dirname(linkName), rawTarget));
  const target = targetPath.replace(/^\/+/, '').toLowerCase();
  if (/^(?:system|vendor|recovery|product|odm|system_ext|apex|vendor_dlkm|odm_dlkm)(?:\/|$)/.test(target)) {
    return [`${rel(root, path)}: Android symlink target`];
  }
  return [];
}

export function magicMarkers(path, headBuffer, tailBuffer) {
  const findings = [];
  const head = headBuffer.subarray(0, 8).toString('ascii');
  const head4 = headBuffer.subarray(0, 4).toString('ascii');
  const hex = headBuffer.subarray(0, 4).toString('hex');
  const tail = tailBuffer.toString('latin1');
  if (head === 'ANDROID!') findings.push(`${path}: Android boot image magic`);
  if (head === 'VNDRBOOT') findings.push(`${path}: Android vendor boot image magic`);
  if (hex === '3aff26ed') findings.push(`${path}: Android sparse image magic`);
  if (hex === 'd7b7ab1e') findings.push(`${path}: Android DTBO image magic`);
  if (head4 === 'CrAU') findings.push(`${path}: Android OTA payload magic`);
  if (head4 === 'AVB0' || head4 === 'AVBf' || tail.includes('AVBf')) {
    findings.push(`${path}: Android Verified Boot magic`);
  }
  if (hex === '6465780a') findings.push(`${path}: Android DEX magic`);
  if (head.startsWith('PK') && tail.includes('AndroidManifest.xml') && /classes\d*\.dex/.test(tail)) {
    findings.push(`${path}: Android APK contents`);
  }
  return findings;
}

export function contentMarkers(path, buffer) {
  const text = buffer.toString('utf8').toLowerCase();
  const androidProperty = /(?:^|[\s"'=])(?:androidboot\.[a-z0-9_.-]+|ro\.build\.[a-z0-9_.-]+)\s*=\s*[^\s"';&]/;
  const initramfsArgument = /(?:^|[\s=])skip_initramfs(?:$|[\s;&])/;
  const initArgument = /(?:^|[\s"'])init=\/init(?:$|[\s"'&])/;
  const androidService = /(?:^|\n)\s*service\s+(?:zygote|surfaceflinger|hwservicemanager)\b|\/system\/bin\/(?:zygote|surfaceflinger|hwservicemanager)\b/;
  if (androidProperty.test(text) || initramfsArgument.test(text) || initArgument.test(text) || androidService.test(text)
    || /partition-name\s*=\s*"(?:system|vendor|recovery|vendor_boot)"/.test(text)) {
    return [`${path}: Android boot or runtime marker`];
  }
  return [];
}

function readPrefix(path, limit = 256 * 1024) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(fstatSync(descriptor).size, limit));
    readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function readTail(path, limit = 64 * 1024) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function looksLikeText(buffer) {
  if (buffer.length === 0 || buffer.includes(0)) return false;
  let controls = 0;
  for (const byte of buffer) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls * 20 <= buffer.length;
}

function scanTextFile(path, name, prefix) {
  if (!looksLikeText(prefix)) return [];
  const descriptor = openSync(path, 'r');
  const size = fstatSync(descriptor).size;
  let offset = 0;
  let overlap = Buffer.alloc(0);
  try {
    while (offset < size) {
      const length = Math.min(TEXT_SCAN_CHUNK_BYTES, size - offset);
      const chunk = Buffer.alloc(length);
      readSync(descriptor, chunk, 0, length, offset);
      const content = Buffer.concat([overlap, chunk]);
      const findings = contentMarkers(name, content);
      if (findings.length > 0) return findings;
      overlap = content.subarray(Math.max(0, content.length - TEXT_SCAN_OVERLAP_BYTES));
      offset += length;
    }
  } finally {
    closeSync(descriptor);
  }
  return [];
}

export function scanTree(root, scanContents = false) {
  const entries = walkEntries(root);
  const paths = entries.files;
  const findings = [];
  for (const path of entries.directories) {
    findings.push(...pathMarkers(root, path));
  }
  for (const path of entries.symlinks) {
    findings.push(...pathMarkers(root, path));
    findings.push(...symlinkMarkers(root, path));
  }
  for (const path of paths) {
    const name = rel(root, path);
    findings.push(...pathMarkers(root, path));
    const content = readPrefix(path);
    findings.push(...magicMarkers(name, content, readTail(path)));
    if (scanContents) findings.push(...scanTextFile(path, name, content));
  }
  return { paths, findings };
}

export function scanInitrds(root) {
  const findings = [];
  for (const archive of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const archivePath = join(root, archive.name);
    const layers = readdirSync(archivePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^(?:main|early\d*)$/.test(entry.name))
      .map((entry) => join(archivePath, entry.name));
    for (const layer of layers.length > 0 ? layers : [archivePath]) {
      findings.push(...scanTree(layer, true).findings.map((finding) => `${archive.name}: ${finding}`));
    }
  }
  return { findings };
}

function parseKeyValues(path) {
  const result = {};
  for (const line of readText(path).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function component(root, role, path) {
  const stats = lstatSync(path);
  return { role, path: rel(root, path), size: stats.size, sha256: await sha256File(path) };
}

export function findBootDtb(boot, bootFiles, dtbName) {
  const matches = bootFiles.filter((path) => basename(path) === dtbName);
  if (matches.length !== 1) throw new Error('boot image must contain exactly one target DTB');
  const expected = `dtb/amlogic/${dtbName}`;
  if (rel(boot, matches[0]) !== expected) throw new Error(`target DTB is not at active DTB path: ${expected}`);
  return matches[0];
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const root = requireArgument(values, 'root');
  const boot = requireArgument(values, 'boot');
  const initrdRoot = requireArgument(values, 'initrd-root');
  const dtbSource = requireArgument(values, 'dtb-source');
  const output = requireArgument(values, 'output');
  const componentsOutput = requireArgument(values, 'boot-components');
  const dtbName = values['dtb-name'];
  const ubootName = values['uboot-name'];
  const expectedCodename = requireValue(
    values,
    'expected-codename',
    /^[a-z]+$/,
  );
  const expectedMajorVersion = requireValue(values, 'expected-major-version', /^[1-9][0-9]*$/);
  if (!dtbName || !ubootName) throw new Error('DTB and U-Boot names are required');

  const osRelease = parseKeyValues(join(root, 'etc/os-release'));
  const version = osRelease.VERSION_ID?.match(/^([1-9][0-9]*)(?:\.[0-9]+)*$/);
  const armbianRelease = join(root, 'etc/armbian-release');
  const armbianImageRelease = join(root, 'etc/armbian-image-release');
  const identity = {
    debian: osRelease.ID === 'debian'
      && osRelease.VERSION_CODENAME === expectedCodename
      && version?.[1] === expectedMajorVersion,
    armbian: statSync(armbianRelease).isFile() && statSync(armbianImageRelease).isFile()
      && readText(armbianRelease).trim().length > 0 && readText(armbianImageRelease).trim().length > 0,
  };
  if (!identity.debian || !identity.armbian) throw new Error('Debian or Armbian identity files are missing');

  const rootScan = scanTree(root, true);
  const initrdScan = scanInitrds(initrdRoot);
  const bootScan = scanTree(boot, true);
  const bootFiles = bootScan.paths;
  const bootFindings = bootScan.findings;
  const configFindings = bootFiles
    .filter((path) => ['uenv.txt', 'extlinux.conf'].includes(basename(path).toLowerCase()))
    .flatMap((path) => contentMarkers(rel(boot, path), readFileSync(path)));
  const dtbFindings = contentMarkers('device-tree.dts', readFileSync(dtbSource));

  const kernel = bootFiles.find((path) => /(?:^|\/)(?:image|image\.gz|zimage)$/i.test(path));
  const initrds = bootFiles.filter((path) => /(?:^|\/)(?:uinitrd|initrd\.img(?:-.+)?)$/i.test(path));
  const dtb = findBootDtb(boot, bootFiles, dtbName);
  const uboot = bootFiles.find((path) => basename(path) === ubootName);
  const derivedUboots = bootFiles.filter((path) => basename(path) === 'u-boot.ext');
  const primaryBootScript = bootFiles.find((path) => rel(boot, path) === 's905_autoscript');
  const installerBootScript = bootFiles.find((path) => rel(boot, path) === 'aml_autoscript');
  const configs = bootFiles.filter((path) => ['uenv.txt', 'extlinux.conf'].includes(basename(path).toLowerCase()));
  if (!kernel || initrds.length === 0 || !dtb || !uboot || !primaryBootScript || !installerBootScript) {
    throw new Error('boot component discovery failed');
  }
  const componentList = [await component(boot, 'kernel', kernel)];
  for (const path of initrds) componentList.push(await component(boot, 'initrd', path));
  componentList.push(await component(boot, 'dtb', dtb));
  componentList.push(await component(boot, 'uboot-overload', uboot));
  for (const path of derivedUboots) componentList.push(await component(boot, 'uboot-overload-derived', path));
  componentList.push(await component(boot, 'boot-script-primary', primaryBootScript));
  componentList.push(await component(boot, 'boot-script-installer', installerBootScript));
  for (const path of configs) componentList.push(await component(boot, 'boot-config', path));
  writeFileSync(componentsOutput, `${JSON.stringify({ schemaVersion: 2, components: componentList }, null, 2)}\n`);

  const result = {
    schemaVersion: 1,
    identity,
    checks: {
      debianIdentity: identity.debian,
      debianStableRelease: identity.debian,
      armbianIdentity: identity.armbian,
      knownAndroidMarkersAbsent: rootScan.findings.length === 0 && bootFindings.length === 0,
      initrdKnownAndroidMarkersAbsent: initrdScan.findings.length === 0,
      bootConfigKnownAndroidMarkersAbsent: configFindings.length === 0,
      dtbKnownAndroidMarkersAbsent: dtbFindings.length === 0,
    },
    findings: {
      rootfs: rootScan.findings,
      boot: bootFindings,
      initrd: initrdScan.findings,
      bootConfig: configFindings,
      dtb: dtbFindings,
    },
    components: componentList,
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  const failed = Object.entries(result.checks).filter(([, value]) => !value);
  if (failed.length > 0) {
    process.stderr.write(`${JSON.stringify(result.findings, null, 2)}\n`);
    throw new Error(`Android or identity checks failed: ${failed.map(([key]) => key).join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
