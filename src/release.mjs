function requireVersion(value, label) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)*$/.test(value)) {
    throw new Error(`${label} must be a numeric version`);
  }
  return value;
}

function requireSlug(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new Error(`${label} must be a lowercase release slug`);
  }
  return value;
}

function requireBuildNumber(value, label) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${label} must be a positive integer`);
  return text;
}

export function releaseTagForManifest(manifest, runNumber, runAttempt) {
  const armbian = requireVersion(manifest?.sources?.base?.armbianVersion, 'Armbian version');
  const codename = requireSlug(manifest?.board?.distribution, 'Debian codename');
  const debian = manifest?.schemaVersion === 1
    ? codename
    : `${requireVersion(
      manifest?.schemaVersion >= 3
        ? manifest?.sources?.debian?.version
        : manifest?.board?.distributionVersion,
      'Debian version',
    )}-${codename}`;
  const kernel = requireVersion(manifest?.sources?.kernel?.version, 'kernel version');
  const run = requireBuildNumber(runNumber, 'workflow run number');
  const attempt = requireBuildNumber(runAttempt, 'workflow run attempt');
  return `armbian-${armbian}-debian-${debian}-k${kernel}-build-${run}.${attempt}`;
}

export function validateReleaseTag(tag, manifest, runNumber, runAttempt) {
  const expected = releaseTagForManifest(manifest, runNumber, runAttempt);
  if (tag !== expected) throw new Error(`release tag does not match manifest: ${tag}`);
  return expected;
}
