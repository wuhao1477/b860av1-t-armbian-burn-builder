#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
repository=${GITHUB_REPOSITORY:-}
if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  echo 'GH_TOKEN or GITHUB_TOKEN is required' >&2
  exit 1
fi
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo 'GITHUB_REPOSITORY is invalid' >&2
  exit 1
}
cd -- "$repo_root"

tmp_dir=$(mktemp -d)
cleanup() { rm -rf -- "$tmp_dir"; }
trap cleanup EXIT

retry_gh() {
  local attempt output
  output=$(mktemp "$tmp_dir/gh-output.XXXXXX")
  for attempt in 1 2 3 4 5; do
    if "$@" >"$output"; then
      cat "$output"
      rm -f -- "$output"
      return 0
    fi
    (( attempt < 5 )) && sleep $((attempt * 2))
  done
  rm -f -- "$output"
  return 1
}

tag_file="$tmp_dir/tags"
retry_gh gh release list --repo "$repository" --limit 1000 --exclude-drafts \
  --json tagName,isDraft,isPrerelease \
  --jq '[.[] | select(.isDraft == false and (.tagName | startswith("armbian-"))) | .tagName] | .[]' \
  > "$tag_file"
tags=()
while IFS= read -r tag; do
  [[ -n "$tag" ]] && tags+=("$tag")
done < "$tag_file"

if [[ ${#tags[@]} -eq 0 ]]; then
  echo 'public release audit: no published Armbian prereleases'
  exit 0
fi

for tag in "${tags[@]}"; do
  [[ "$tag" =~ ^armbian-[A-Za-z0-9._-]+-build-[0-9]+\.[0-9]+$ ]] || {
    echo "invalid public release tag: $tag" >&2
    exit 1
  }
  release_dir="$tmp_dir/$tag"
  mkdir -p -- "$release_dir"
  retry_gh gh release view "$tag" --repo "$repository" \
    --json tagName,assets,isDraft,isPrerelease > "$release_dir/release.json"
  retry_gh gh release download "$tag" --repo "$repository" \
    --pattern resolved-sources.json --pattern validation-report.json \
    --dir "$release_dir" --clobber >/dev/null
  RELEASE_DIR="$release_dir" TAG="$tag" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { validatePublicRelease } from './src/public-release-policy.mjs';

const directory = process.env.RELEASE_DIR;
const tag = process.env.TAG;
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
validatePublicRelease({
  manifest: readJson('resolved-sources.json'),
  report: readJson('validation-report.json'),
  release: readJson('release.json'),
  tag,
});
process.stdout.write(`public release audit: ${tag}\n`);
NODE
done
