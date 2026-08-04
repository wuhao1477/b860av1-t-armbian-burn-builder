import assert from 'node:assert/strict';
import test from 'node:test';

import { disableBinaryDependencyDownloads } from '../scripts/disable-binary-dependency-downloads.mjs';

const upstream = `download_depends() {
    git_pull_dir "\${uboot_repo}" main u-boot "\${uboot_path}"
    git_pull_dir "\${firmware_repo}" main firmware "\${firmware_path}"
}

query_kernel() {
    true
}
`;

test('builder policy removes both binary bundle download calls', () => {
  const patched = disableBinaryDependencyDownloads(upstream);

  assert.match(patched, /binary dependency downloads are disabled/i);
  assert.doesNotMatch(patched, /git_pull_dir "\$\{(?:uboot|firmware)_repo\}"/);
  assert.match(patched, /query_kernel\(\)/);
});

test('builder policy fails closed when the upstream function changes', () => {
  assert.throws(
    () => disableBinaryDependencyDownloads(upstream.replace('git_pull_dir "${firmware_repo}"', 'echo changed')),
    /unexpected upstream/i,
  );
  assert.throws(() => disableBinaryDependencyDownloads('download_depends() { :; }\n'), /cannot locate/i);
});
