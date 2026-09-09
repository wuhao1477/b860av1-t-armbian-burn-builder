#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
repository=${CNB_REPO_SLUG:-}
if [[ -z "${CNB_TOKEN:-}" ]]; then
  echo 'CNB_TOKEN not set, skipping release audit' >&2
  exit 0
fi
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo 'CNB_REPO_SLUG is invalid' >&2
  exit 1
}
cd -- "$repo_root"
exec node "$script_dir/cnb-release-audit.mjs"
