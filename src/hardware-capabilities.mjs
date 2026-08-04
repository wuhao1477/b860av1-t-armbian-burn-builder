export const HARDWARE_CAPABILITY_RECIPE_PATH = 'config/hardware-capabilities.json';
export const HARDWARE_CAPABILITY_ASSET = 'hardware-capabilities.json';

const CAPABILITY_NAMES = ['emmc', 'ethernet', 'hdmi', 'infrared', 'usb', 'wifi'];
const CHECK_TYPES = new Set(['hex-cell', 'present', 'string', 'string-list', 'u32']);
const SHA256 = /^[0-9a-f]{64}$/;
const KERNEL_RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9][A-Za-z0-9._+~-]*$/;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function sameKeys(actual, expected, label) {
  const keys = Object.keys(actual).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function validateDtbCheck(check, label) {
  requireObject(check, label);
  if (typeof check.node !== 'string' || !check.node.startsWith('/') || check.node.includes('..')) {
    throw new Error(`${label}.node is invalid`);
  }
  if (typeof check.property !== 'string' || !/^[-A-Za-z0-9_,]+$/.test(check.property)) {
    throw new Error(`${label}.property is invalid`);
  }
  if (!CHECK_TYPES.has(check.type)) throw new Error(`${label}.type is invalid`);
  if (check.type === 'u32' && (!Number.isSafeInteger(check.expected) || check.expected < 0)) {
    throw new Error(`${label}.expected is invalid`);
  }
  if (['string', 'string-list', 'hex-cell'].includes(check.type)
    && (typeof check.expected !== 'string' || check.expected.length === 0)) {
    throw new Error(`${label}.expected is invalid`);
  }
  if (check.type === 'hex-cell' && (!Number.isSafeInteger(check.index) || check.index < 0)) {
    throw new Error(`${label}.index is invalid`);
  }
}

export function validateHardwareCapabilityRecipe(value) {
  const recipe = requireObject(value, 'hardware capability recipe');
  if (recipe.schemaVersion !== 1 || recipe.boardProfile !== 'b860av1-t') {
    throw new Error('hardware capability recipe identity is invalid');
  }
  const capabilities = requireObject(recipe.capabilities, 'hardware capability recipe capabilities');
  sameKeys(capabilities, CAPABILITY_NAMES, 'hardware capability recipe capabilities');
  for (const name of CAPABILITY_NAMES) {
    const capability = requireObject(capabilities[name], `hardware capability ${name}`);
    const config = requireObject(capability.kernelConfig, `hardware capability ${name} kernelConfig`);
    if (Object.keys(config).length === 0) throw new Error(`hardware capability ${name} kernelConfig is empty`);
    for (const [symbol, expected] of Object.entries(config)) {
      if (!/^CONFIG_[A-Z0-9_]+$/.test(symbol) || !['y', 'm'].includes(expected)) {
        throw new Error(`hardware capability ${name} kernelConfig is invalid`);
      }
    }
    if (!Array.isArray(capability.deviceTreeChecks) || capability.deviceTreeChecks.length === 0) {
      throw new Error(`hardware capability ${name} deviceTreeChecks is empty`);
    }
    capability.deviceTreeChecks.forEach((check, index) => validateDtbCheck(check, `${name}[${index}]`));
  }
  return recipe;
}

export function parseKernelConfig(source) {
  if (typeof source !== 'string') throw new TypeError('kernel config source must be text');
  const result = new Map();
  for (const line of source.split(/\r?\n/)) {
    const value = line.match(/^(CONFIG_[A-Z0-9_]+)=(.+)$/);
    const unset = line.match(/^# (CONFIG_[A-Z0-9_]+) is not set$/);
    if (value) result.set(value[1], value[2]);
    else if (unset) result.set(unset[1], 'n');
  }
  return result;
}

function observedMatches(check, actual) {
  if (check.type === 'present') return actual === true;
  if (check.type === 'string-list') return Array.isArray(actual) && actual.includes(check.expected);
  if (check.type === 'hex-cell') {
    const cell = Array.isArray(actual) ? actual[check.index] : undefined;
    return String(cell ?? '').replace(/^0x/i, '').toLowerCase() === check.expected.toLowerCase();
  }
  return actual === check.expected;
}

function printable(value) {
  return Array.isArray(value) ? value.join(' ') : String(value);
}

function evaluateCapability(name, definition, config, readDtb) {
  for (const [symbol, expected] of Object.entries(definition.kernelConfig)) {
    const actual = config.get(symbol) ?? 'missing';
    if (actual !== expected) {
      throw new Error(`${name} kernel ${symbol} expected ${expected}, got ${actual}`);
    }
  }
  const deviceTreeChecks = definition.deviceTreeChecks.map((check) => {
    const actual = readDtb(check);
    if (!observedMatches(check, actual)) {
      throw new Error(`${name} DTB ${check.node} ${check.property} expected ${check.expected ?? 'present'}, got ${printable(actual)}`);
    }
    return { ...check, actual, passed: true };
  });
  return { passed: true, kernelConfig: { ...definition.kernelConfig }, deviceTreeChecks };
}

export function evaluateHardwareCapabilities(recipeValue, kernelConfigSource, readDtb) {
  const recipe = validateHardwareCapabilityRecipe(recipeValue);
  if (typeof readDtb !== 'function') throw new TypeError('DTB reader must be a function');
  const config = parseKernelConfig(kernelConfigSource);
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [
    name,
    evaluateCapability(name, recipe.capabilities[name], config, readDtb),
  ]));
}

export function requiresHardwareCapabilityValidation(manifest) {
  return Object.hasOwn(manifest?.recipe?.files ?? {}, HARDWARE_CAPABILITY_RECIPE_PATH);
}

function validateCapabilityResults(results, recipe) {
  const capabilities = requireObject(results, 'hardware capability results');
  sameKeys(capabilities, CAPABILITY_NAMES, 'hardware capability results');
  for (const name of CAPABILITY_NAMES) {
    const result = requireObject(capabilities[name], `hardware capability result ${name}`);
    const expected = recipe.capabilities[name];
    if (result.passed !== true
      || JSON.stringify(result.kernelConfig) !== JSON.stringify(expected.kernelConfig)
      || !Array.isArray(result.deviceTreeChecks)
      || result.deviceTreeChecks.length !== expected.deviceTreeChecks.length) {
      throw new Error(`hardware capability result ${name} is incomplete`);
    }
    expected.deviceTreeChecks.forEach((check, index) => {
      const actual = result.deviceTreeChecks[index];
      for (const key of ['node', 'property', 'type', 'expected', 'index']) {
        if (actual[key] !== check[key]) throw new Error(`hardware capability result ${name} check ${index} is invalid`);
      }
      if (actual.passed !== true || !observedMatches(check, actual.actual)) {
        throw new Error(`hardware capability result ${name} check ${index} failed`);
      }
    });
  }
}

function requireBoundFile(manifestText, path, digest, label) {
  const expected = `${digest}  ./${path}`;
  const matches = manifestText.split(/\r?\n/).filter((line) => line === expected);
  if (matches.length !== 1) throw new Error(`${label} is not bound to filesystem manifest`);
}

function validateBootDtb(bootComponents, deviceTree) {
  const components = requireObject(bootComponents, 'boot components');
  if (components.schemaVersion !== 2 || !Array.isArray(components.components)) {
    throw new Error('boot components are invalid');
  }
  const matches = components.components.filter((entry) => entry?.role === 'dtb'
    && entry.path === deviceTree.path && entry.sha256 === deviceTree.sha256);
  if (matches.length !== 1) throw new Error('device tree is not bound to boot components');
}

export function validateHardwareCapabilityEvidence(value, context) {
  const evidence = requireObject(value, 'hardware capability evidence');
  const recipe = validateHardwareCapabilityRecipe(context?.recipe);
  if (evidence.schemaVersion !== 1 || evidence.status !== 'passed') {
    throw new Error('hardware capability evidence status is invalid');
  }
  const recipeBinding = requireObject(evidence.recipe, 'hardware capability recipe binding');
  const expectedRecipeSha = context?.manifest?.recipe?.files?.[HARDWARE_CAPABILITY_RECIPE_PATH];
  if (recipeBinding.path !== HARDWARE_CAPABILITY_RECIPE_PATH
    || !SHA256.test(recipeBinding.sha256 ?? '') || recipeBinding.sha256 !== expectedRecipeSha) {
    throw new Error('hardware capability recipe binding is invalid');
  }
  const kernel = requireObject(evidence.kernel, 'hardware capability kernel');
  const config = requireObject(kernel.config, 'hardware capability kernel config');
  const expectedKernel = context?.manifest?.sources?.kernel?.version;
  const expectedConfigPath = `usr/src/linux-headers-${kernel.release}/include/config/auto.conf`;
  if (!KERNEL_RELEASE.test(kernel.release ?? '') || !kernel.release.startsWith(`${expectedKernel}-`)
    || config.path !== expectedConfigPath || !SHA256.test(config.sha256 ?? '')) {
    throw new Error('hardware capability kernel binding is invalid');
  }
  requireBoundFile(context.filesystemManifest, config.path, config.sha256, 'kernel config');
  const deviceTree = requireObject(evidence.deviceTree, 'hardware capability device tree');
  if (typeof deviceTree.path !== 'string' || !SHA256.test(deviceTree.sha256 ?? '')) {
    throw new Error('hardware capability device tree binding is invalid');
  }
  validateBootDtb(context.bootComponents, deviceTree);
  const wifi = requireObject(evidence.wifiDriver, 'hardware capability Wi-Fi driver');
  if (wifi.path !== 'rtl8189fs-driver.json' || wifi.sha256 !== context.rtl8189fsEvidenceSha256
    || context.rtl8189fsEvidence?.kernelRelease !== kernel.release) {
    throw new Error('hardware capability Wi-Fi driver binding is invalid');
  }
  validateCapabilityResults(evidence.capabilities, recipe);
  return evidence;
}
