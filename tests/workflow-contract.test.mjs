import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const actionShas = {
  checkout: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  setupNode: '820762786026740c76f36085b0efc47a31fe5020',
  uploadArtifact: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  downloadArtifact: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
};

test('weekly workflow runs the detector every Monday and gates heavy jobs', () => {
  const workflow = read('.github/workflows/weekly-build.yml');

  assert.match(workflow, /cron:\s*['"]23 3 \* \* 1['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /force:/);
  assert.match(workflow, /detect:/);
  assert.match(workflow, /if:\s*>-?[\s\S]*needs\.detect\.outputs\.changed == 'true'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.force == true/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /timeout-minutes:/);
});

test('weekly workflow pins official Actions and separates publication permission', () => {
  const workflow = read('.github/workflows/weekly-build.yml');

  assert.match(workflow, new RegExp(`actions/checkout@${actionShas.checkout}`));
  assert.match(workflow, new RegExp(`actions/setup-node@${actionShas.setupNode}`));
  assert.match(workflow, new RegExp(`actions/upload-artifact@${actionShas.uploadArtifact}`));
  assert.match(workflow, new RegExp(`actions/download-artifact@${actionShas.downloadArtifact}`));
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents:\s*write/);
  assert.match(workflow, /prerelease:\s*true/);
  assert.doesNotMatch(workflow, /@[vV](?:\d+|latest)\b/);
});

test('CI installs the Expect runtime used by the QEMU smoke test', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /apt-get install --yes expect/);
});

test('CI installs the device-tree tools used by hardware capability tests', () => {
  const workflow = read('.github/workflows/ci.yml');
  const testJob = workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  source-built-uboot:'));
  assert.match(testJob, /apt-get install --yes[^\n]*device-tree-compiler/);
});

test('detector fails closed and only compares complete non-draft releases', () => {
  const workflow = read('.github/workflows/weekly-build.yml');

  assert.match(workflow, /set -Eeuo pipefail/);
  assert.match(workflow, /gh release list[^\n]+--exclude-drafts/);
  assert.match(workflow, /gh release view[^\n]+--json assets/);
  assert.match(workflow, /SHA256SUMS/);
  assert.match(workflow, /build-input-heads\.json/);
  assert.match(workflow, /release-tag\.txt/);
  assert.match(workflow, /\.img\.gz/);
  assert.match(workflow, /gh release download[^\n]+validation-report\.json/);
  assert.match(workflow, /validatePublishedState/);
  assert.doesNotMatch(workflow, /gh release download[^\n]*\|\|\s*true/);
});

test('detector retries transient failures while loading previous release state', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const detect = workflow.slice(workflow.indexOf('\n  detect:'), workflow.indexOf('\n  build:'));

  assert.match(detect, /retry_gh\(\)[\s\S]+for attempt in 1 2 3 4 5[\s\S]+sleep/);
  assert.match(detect, /latest_tag=\$\(retry_gh gh release list[^\n]+--exclude-drafts/);
  assert.match(detect, /retry_gh gh release view[^\n]+--json assets,isDraft,isPrerelease/);
  assert.match(detect, /retry_gh gh release download[^\n]+resolved-sources\.json/);
  assert.match(detect, /retry_gh gh release download[^\n]+validation-report\.json/);
  assert.doesNotMatch(detect, /retry_gh[^\n]*\|\|\s*true/);
});

test('detector audits every public release before fingerprint comparison', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const detect = workflow.slice(workflow.indexOf('\n  detect:'), workflow.indexOf('\n  build:'));
  const audit = read('scripts/audit-public-releases.sh');
  const resolver = read('scripts/resolve-sources.mjs');

  assert.match(detect, /scripts\/audit-public-releases\.sh/);
  assert.ok(detect.indexOf('scripts/audit-public-releases.sh') < detect.indexOf('latest_tag='));
  assert.match(audit, /--exclude-drafts/);
  assert.match(audit, /isDraft == false/);
  assert.doesNotMatch(audit, /isPrerelease == true/);
  assert.match(audit, /validatePublicRelease/);
  assert.match(audit, /--pattern resolved-sources\.json --pattern validation-report\.json/);
  assert.doesNotMatch(audit, /--pattern[^\n]*\.img\.gz/);
  assert.match(resolver, /scripts\/audit-public-releases\.sh/);
  assert.match(resolver, /src\/public-release-policy\.mjs/);
});

test('detector verifies official Debian stable metadata before source resolution', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const detect = workflow.slice(workflow.indexOf('\n  detect:'), workflow.indexOf('\n  build:'));
  const verifier = read('scripts/verify-debian-stable.sh');

  assert.match(detect, /debian-archive-keyring/);
  assert.match(detect, /scripts\/verify-debian-stable\.sh\s+debian-stable\.json/);
  assert.match(detect, /resolve-sources\.mjs[^\n]+--debian-stable/);
  assert.match(verifier, /https:\/\/deb\.debian\.org\/debian\/dists\/stable\/InRelease/);
  assert.match(verifier, /for attempt in 1 2 3 4 5[\s\S]+curl/);
  assert.match(verifier, /gpgv[\s\S]+--keyring[^\n]+debian-archive-keyring\.gpg[\s\S]+--status-fd=3/);
  assert.match(verifier, /requireGpgvValidSignature/);
  assert.match(verifier, /resolve-debian-stable\.mjs/);

  const verify = verifier.indexOf('requireGpgvValidSignature');
  const normalize = verifier.indexOf('resolve-debian-stable.mjs');
  const resolve = detect.indexOf('resolve-sources.mjs');
  assert.ok(verify >= 0 && verify < normalize);
  assert.ok(detect.indexOf('verify-debian-stable.sh') < resolve);
});

test('publication is stable across workflow reruns', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const publish = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  keepalive:'));

  assert.match(workflow, /overwrite:\s*true/);
  assert.match(workflow, /release-tag\.txt/);
  assert.match(workflow, /gh release create[^\n]+--target\s+"\$GITHUB_SHA"/);
  assert.match(workflow, /gh release create[^\n]+--draft/);
  assert.match(workflow, /gh release upload[\s\S]+gh release edit[^\n]+--draft=false/);
  assert.match(workflow, /gh release edit[^\n]+--draft=false/);
  assert.match(publish, /validateReleaseTag/);
  assert.doesNotMatch(publish, /releaseTagForManifest/);
  assert.doesNotMatch(publish, /process\.env\.GITHUB_RUN_ATTEMPT/);
});

test('publication binds the release tag and server-side assets before un-drafting', () => {
  const workflow = read('.github/workflows/weekly-build.yml');

  assert.match(workflow, /validateReleaseTag/);
  assert.match(workflow, /validateDraftReleaseForPublication/);
  assert.match(workflow, /gh release view[^\n]+tagName,assets,isDraft,isPrerelease/);
  assert.match(workflow, /release-state\.json/);
  assert.match(workflow, /release-assets\.json/);
  assert.match(workflow, /localAssets/);
  assert.match(workflow, /release-tag\.txt/);
});

test('publisher retries server-side release asset validation', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const publish = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  keepalive:'));

  assert.match(publish, /for attempt in 1 2 3 4 5/);
  assert.match(publish, /gh release view[^\n]+tagName,assets,isDraft,isPrerelease/);
  assert.match(publish, /sleep/);
  assert.match(publish, /release_assets_verified=true/);
});

test('publisher retries draft readiness and uploads each asset idempotently', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const publish = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  keepalive:'));

  assert.match(publish, /timeout-minutes:\s*30/);
  assert.match(
    publish,
    /draft_release_ready\(\)[\s\S]+release_ready=false[\s\S]+for attempt in 1 2 3 4 5[\s\S]+draft_release_ready[\s\S]+gh release create[\s\S]+done[\s\S]+draft_release_ready[\s\S]+release_ready=true/,
  );
  assert.match(publish, /release_create_accepted=true/);
  assert.match(publish, /remote_asset_matches\(\)/);
  assert.match(publish, /return 2/);
  assert.match(publish, /remoteDigest === ''[\s\S]+process\.exit\(2\)/);
  assert.match(publish, /gh release upload\s+"\$tag"\s+"\$asset_path"\s+--clobber/);
  assert.doesNotMatch(publish, /gh release upload[^\n]+out\/\*\.img\.gz[^\n]+SHA256SUMS/);
  assert.match(publish, /asset_ready=false[\s\S]+remote_asset_matches[\s\S]+asset_ready=true/);
  assert.match(
    publish,
    /published_release_ready\(\)[\s\S]+release_published=false[\s\S]+--draft=false[\s\S]+done[\s\S]+published_release_ready[\s\S]+release_published=true/,
  );
});

test('publisher revalidates candidate provenance and content digest', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const publish = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  keepalive:'));

  assert.match(publish, /FINGERPRINT: \$\{\{ needs\.detect\.outputs\.fingerprint \}\}/);
  assert.match(publish, /node scripts\/validate-candidate-artifacts\.mjs out "\$FINGERPRINT"/);
});

test('validation runs on a separate trusted job and binds every digest to the image', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const validateStart = workflow.indexOf('\n  validate:');
  const publishStart = workflow.indexOf('\n  publish:');
  const validate = workflow.slice(validateStart, publishStart);
  const publish = workflow.slice(publishStart, workflow.indexOf('\n  keepalive:'));

  assert.match(workflow, /^  validate:/m);
  assert.match(validate, /needs: \[detect, build\]/);
  assert.match(validate, /actions\/download-artifact/);
  assert.match(validate, /scripts\/validate-raw-image\.sh/);
  assert.match(validate, /validate-candidate-artifacts\.mjs out "\$EXPECTED_FINGERPRINT"/);
  assert.match(validate, /EXPECTED_FINGERPRINT/);
  assert.match(validate, /b860av1-t-built-\$\{\{ needs\.detect\.outputs\.fingerprint \}\}/);
  assert.match(validate, /out\/THIRD_PARTY_SOURCES\.md/);
  assert.match(publish, /needs: \[detect, validate\]/);
  assert.doesNotMatch(publish, /needs: \[detect, build\]/);
  assert.match(publish, /validate-candidate-artifacts\.mjs/);
});

test('validation and publication carry the hardware capability evidence asset', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const validate = workflow.slice(workflow.indexOf('\n  validate:'), workflow.indexOf('\n  publish:'));
  const publish = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  keepalive:'));

  assert.match(validate, /out\/hardware-capabilities\.json/);
  assert.ok((publish.match(/hardware-capabilities\.json/g) ?? []).length >= 2);
});

test('raw builder consumes exact manifest inputs and invokes the fixed board rebuild', () => {
  const script = read('scripts/build-raw-image.sh');

  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m);
  assert.match(script, /builder[^\n]*commit|builder_commit/i);
  assert.match(script, /base[^\n]*(?:url|asset)/i);
  assert.match(script, /sha256sum\s+(?:--check|-c)/);
  assert.match(script, /git\s+-C\s+[^\n]+checkout\s+--detach/);
  assert.match(script, /\.\/rebuild\s+-b\s+"\$board_profile"\s+-k\s+[^\s]+\s+-a\s+false\s+-t\s+ext4/);
  assert.match(script, /\.img\.gz/);
});

test('raw validator checks gzip, partitions, FAT, ext4, dynamic Debian identity, boot files, and Android exclusions', () => {
  const script = read('scripts/validate-raw-image.sh');

  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m);
  assert.match(script, /gzip\s+-t/);
  assert.match(script, /sfdisk|fdisk|parted/);
  assert.match(script, /fsck\.vfat|dosfsck/);
  assert.match(script, /e2fsck/);
  assert.match(script, /--expected-codename/);
  assert.match(script, /--expected-major-version/);
  assert.doesNotMatch(script, /VERSION_CODENAME=trixie/);
  for (const bootFile of ['uEnv.txt', 'Image', 'initrd.img', 'dtb']) {
    assert.match(script, new RegExp(bootFile.replace('.', '\\.')));
  }
  for (const prohibited of ['system', 'vendor', 'build.prop', 'recovery']) {
    assert.match(script, new RegExp(prohibited.replace('.', '\\.'), 'i'));
  }
  assert.match(script, /sha256sum/);
  assert.match(script, /container-valid/);
  assert.match(script, /hardware-unverified/);
});

test('release notes preserve the hardware-unverified status', () => {
  const script = read('scripts/render-release-notes.mjs');

  assert.match(script, /container-valid\s*\/\s*hardware-unverified/);
  assert.match(script, /resolved-sources\.json|fingerprint/);
  assert.match(script, /validation-report\.json|validation/i);
  assert.match(script, /persistent bootloader/i);
  assert.match(script, /existing compatible stock boot chain/i);
  assert.match(script, /qemu-system-smoke/);
});

test('release notes disclose static hardware capability evidence', () => {
  const script = read('scripts/render-release-notes.mjs');

  assert.match(script, /hardware-capabilities\.json/);
  assert.match(script, /eMMC|Ethernet|HDMI|infrared|USB/i);
});

test('release title and notes expose the full Debian point version', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const notes = read('scripts/render-release-notes.mjs');

  assert.match(workflow, /sources\.debian\.version/);
  assert.match(workflow, /title="Armbian[^\n]+Debian \$\{debian_point_version\}/);
  assert.match(notes, /sources\.debian\?\.version/);
});

test('scheduled keepalive does not enter the build fingerprint or build gate', () => {
  const workflow = read('.github/workflows/weekly-build.yml');
  const resolver = read('scripts/resolve-sources.mjs');

  assert.match(workflow, /keepalive:/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
  assert.match(workflow, /42 \* 86400/);
  assert.match(workflow, /schedule-heartbeat/);
  assert.doesNotMatch(resolver, /schedule-heartbeat/);
});

test('heartbeat-only commits do not trigger CI compilation', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(
    workflow,
    /push:\s*\n\s*paths-ignore:\s*\n\s*- ['"]\.github\/schedule-heartbeat['"]/,
  );
});

test('device evidence PR workflow is read-only and limited to evidence changes', () => {
  const workflow = read('.github/workflows/device-evidence-pr.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /paths:\s*\n\s*- ['"]evidence\/\*\*['"]/);
  assert.match(workflow, /- ['"]!evidence\/\.gitkeep['"]/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /validate-device-evidence\.mjs/);
  assert.doesNotMatch(workflow, /\.img\.gz/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
});

test('manual device verification validates first and publishes unique assets second', () => {
  const workflow = read('.github/workflows/verify-device.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_tag:/);
  assert.match(workflow, /evidence_path:/);
  assert.match(workflow, /confirmation:/);
  assert.match(workflow, /== ['"]verify['"]/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /validate-device-evidence\.mjs/);
  assert.match(workflow, /publish:[\s\S]+needs:\s*validate/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /device-validation-\$\{?EVIDENCE_ID/);
  assert.match(workflow, /device-serial-\$\{?EVIDENCE_ID/);
  assert.match(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.doesNotMatch(workflow, /gh release delete|gh release edit/);
  assert.doesNotMatch(workflow, /\.img\.gz/);
});

test('burn workflow follows the public raw release and publishes direct-boot contracts', () => {
  const workflow = read('.github/workflows/weekly-burn-build.yml');
  const contracts = [
    'stock-bootloader-contract.json', 'boot-contract.json', 'dtb-contract.json',
    'rootfs-contract.json',
  ];

  assert.match(workflow, /validate-burn-image\.sh out\/burn\.img out\/burn-report\.json/);
  for (const contract of contracts) {
    const matches = workflow.match(new RegExp(contract.replace('.', '\\.'), 'g')) ?? [];
    assert.ok(matches.length >= 3, `${contract} is not checksummed, uploaded, and published`);
  }
  assert.match(
    workflow,
    /sha256sum[^\n]+stock-bootloader-contract\.json[^\n]+boot-contract\.json[^\n]+dtb-contract\.json[^\n]+rootfs-contract\.json[^\n]+burn-report\.json/,
  );
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /recipe_digest/);
  for (const recipeInput of [
    'board-overlays/burn-partitions.dtso',
    'config/burn-tooling.json',
    'board-inputs/meson1.dtb',
    'scripts/build-board-dtb.sh',
    'src/burn-dtb-roles.mjs',
    'src/burn-standalone-dtb.mjs',
    'src/direct-boot-contract.mjs',
    'src/emmc-boot-chain.mjs',
  ]) {
    assert.match(workflow, new RegExp(recipeInput.replaceAll('.', '\\.')));
  }
  // 料源为 ophub 的 s905lb-r3300l 成品镜像：S905M-B 在 ophub 设备库中与
  // s905lb 共用 meson-gxl-s905x-p212.dtb 和 u-boot-r3300l.bin，而 ophub
  // 并不单独发布 s905mb 资产。
  assert.match(workflow, /SOURCE_REPOSITORY:\s*ophub\/amlogic-s9xxx-armbian/);
  assert.match(workflow, /SOURCE_BOARD:\s*s905lb-r3300l/);
  assert.match(workflow, /SOURCE_SUITE:\s*trixie/);
  assert.match(workflow, /gh release download "\$PUBLIC_RELEASE" --repo "\$SOURCE_REPOSITORY"/);
  // ophub 的单个 release 带 200+ 个板型资产，整包下载会撑爆 runner 磁盘。
  assert.match(workflow, /--pattern "\$NAME"/);
  assert.doesNotMatch(workflow, /gh release download "\$PUBLIC_RELEASE" --repo "\$SOURCE_REPOSITORY" --dir/);
  // 发布标签必须同时暴露 Armbian 版本、Debian 代号和内核版本。
  assert.match(workflow, /tag="b860-burn-armbian-\$\{BASH_REMATCH\[1\]\}-\$\{BASH_REMATCH\[2\]\}-k\$\{BASH_REMATCH\[3\]\}/);
  assert.match(workflow, /gh release create[^\n]+--draft/);
  assert.match(workflow, /draft_release_ready\(\)[\s\S]+release_ready=false[\s\S]+for attempt in 1 2 3 4 5[\s\S]+release_ready=true/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /remote_asset_matches|release-assets\.json/);
  assert.match(workflow, /gh release edit[^\n]+--draft=false/);
  assert.match(workflow, /schedule:\s*\n\s*- cron:\s*['"]23 3 \* \* 1['"]/);
  assert.doesNotMatch(workflow, /workflow_run:/);
});

test('burn workflow builds the stock-kernel diagnostic only on a manually selected branch', () => {
  const workflow = read('.github/workflows/weekly-burn-build.yml');
  const diagnosticJobs = workflow.match(/stock_diagnostic_build:[\s\S]+$/)?.[0];
  const diagnosticPublish = workflow.match(/stock_diagnostic_publish:[\s\S]+$/)?.[0];

  assert.match(workflow, /detect:\s*\n\s*if:\s*.*default_branch/);
  assert.match(
    workflow,
    /stock_diagnostic_build:[\s\S]+github\.event_name == 'workflow_dispatch'[\s\S]+github\.ref_name != github\.event\.repository\.default_branch/,
  );
  assert.match(workflow, /build-stock-diagnostic-initramfs\.sh/);
  assert.match(workflow, /build-stock-diagnostic-burn\.sh/);
  assert.match(workflow, /validate-stock-diagnostic-burn\.sh/);
  assert.match(workflow, /qemu-user-static/);
  assert.match(workflow, /gcc-aarch64-linux-gnu/);
  assert.match(workflow, /xz -t out\/burn\.img\.xz/);
  for (const asset of [
    'burn.img', 'burn.img.xz', 'diagnostic-inputs-contract.json',
    'diagnostic-initramfs-contract.json', 'diagnostic-boot-contract.json',
  ]) {
    const matches = workflow.match(new RegExp(asset.replaceAll('.', '\\.'), 'g')) ?? [];
    assert.ok(matches.length >= 3, `${asset} is not checksummed, uploaded, and published`);
  }
  assert.match(workflow, /Purpose: stock-kernel diagnostic/);
  assert.match(workflow, /Status: format-valid \/ diagnostic \/ hardware-unverified/);
  assert.ok(diagnosticJobs, 'missing diagnostic jobs');
  assert.match(diagnosticJobs, /HTTP-only|HTTP status/);
  assert.doesNotMatch(diagnosticJobs, /Dropbear|SSH user|SSH key fingerprint/);
  assert.ok(diagnosticPublish, 'missing diagnostic publication job');
  assert.match(diagnosticPublish, /gh release create[^\n]+--target\s+"\$GITHUB_SHA"/);
});

test('burn workflow gates the HDMI console variant behind an explicit dispatch input', () => {
  const workflow = read('.github/workflows/weekly-burn-build.yml');
  const build = workflow.match(/stock_diagnostic_build:[\s\S]+?\n  stock_diagnostic_publish:/)?.[0];
  const buildScript = read('scripts/build-stock-diagnostic-burn.sh');
  const validateScript = read('scripts/validate-stock-diagnostic-burn.sh');

  assert.match(workflow, /diagnostic_console:\s*\n\s*description:[\s\S]+?default: false/);
  assert.ok(build, 'missing diagnostic build job');
  // 构建与独立验证必须落在同一个 job 里，才能共享同一个开关取值。
  assert.match(build, /B860_DIAGNOSTIC_CONSOLE: \$\{\{ inputs\.diagnostic_console && 1 \|\| 0 \}\}/);
  assert.match(build, /build-stock-diagnostic-burn\.sh/);
  assert.match(build, /validate-stock-diagnostic-burn\.sh/);
  for (const script of [buildScript, validateScript]) {
    assert.match(script, /B860_DIAGNOSTIC_CONSOLE:-0/);
    assert.match(script, /diagnostic-console-cmdline/);
    assert.match(script, /config\/stock-environment\.json/);
  }
  // 验证侧只能自己重新推导，不得从发布的契约里读回 cmdline。
  assert.doesNotMatch(validateScript, /consoleCmdline/);
});
