function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireHex(value, length, label) {
  const text = requireText(value, label).toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match the manifest`);
}

export function validateUbootBuild(value, manifest) {
  const summary = requireObject(value, 'U-Boot build summary');
  const board = requireObject(manifest?.board, 'manifest.board');
  const source = requireObject(manifest?.sources?.ubootSource, 'manifest.sources.ubootSource');
  const build = requireObject(board.ubootOverloadBuild, 'manifest.board.ubootOverloadBuild');
  if (summary.schemaVersion !== 1) throw new Error('U-Boot build summary schemaVersion is unsupported');

  const actualSource = requireObject(summary.source, 'U-Boot build source');
  for (const key of ['repository', 'ref', 'commit']) {
    equal(requireText(actualSource[key], `U-Boot build source ${key}`), source[key], `U-Boot source ${key}`);
  }

  const recipe = requireObject(summary.recipe, 'U-Boot build recipe');
  for (const key of ['patch', 'patchSha256', 'defconfig', 'output', 'crossCompile', 'sourceDateEpoch']) {
    equal(recipe[key], build[key], `U-Boot recipe ${key}`);
  }
  requireHex(recipe.patchSha256, 64, 'U-Boot build patch SHA-256');

  const artifact = requireObject(summary.artifact, 'U-Boot build artifact');
  equal(requireText(artifact.name, 'U-Boot artifact name'), board.ubootOverload, 'U-Boot artifact name');
  requireHex(artifact.sha256, 64, 'U-Boot artifact SHA-256');
  requirePositiveInteger(artifact.size, 'U-Boot artifact size');

  const sourceArchive = requireObject(summary.sourceArchive, 'U-Boot source archive');
  equal(requireText(sourceArchive.name, 'U-Boot source archive name'), 'u-boot-source.tar.gz', 'U-Boot source archive name');
  requireHex(sourceArchive.sha256, 64, 'U-Boot source archive SHA-256');
  requireHex(sourceArchive.treeSha256, 64, 'U-Boot source tree SHA-256');
  requirePositiveInteger(sourceArchive.size, 'U-Boot source archive size');

  const environment = requireObject(summary.environment, 'U-Boot build environment');
  equal(requireText(environment.arch, 'U-Boot build arch'), 'arm', 'U-Boot build arch');
  requireHex(environment.configSha256, 64, 'U-Boot config SHA-256');
  requireText(environment.compiler, 'U-Boot compiler identity');
  return summary;
}
