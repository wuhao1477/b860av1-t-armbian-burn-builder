#!/usr/bin/env bash
set -Eeuo pipefail

output_path=${1:-debian-stable.json}
work_dir=${2:-"${RUNNER_TEMP:?RUNNER_TEMP is required}/debian-stable"}
source_url=https://deb.debian.org/debian/dists/stable/InRelease
project_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
inrelease="$work_dir/debian-stable.InRelease"
gpgv_status="$work_dir/gpgv-status"

mkdir -p "$work_dir"
downloaded=false
for attempt in 1 2 3 4 5; do
  if curl --fail --silent --show-error --location --output "$inrelease" "$source_url"; then
    downloaded=true
    break
  fi
  (( attempt < 5 )) && sleep $((attempt * 2))
done
[[ "$downloaded" == true ]] || { echo 'Debian stable InRelease download failed' >&2; exit 1; }

: > "$gpgv_status"
if gpgv --keyring /usr/share/keyrings/debian-archive-keyring.gpg \
  --status-fd=3 "$inrelease" 3>"$gpgv_status"; then
  gpgv_exit=0
else
  gpgv_exit=$?
fi

node --input-type=module - "$gpgv_status" "$gpgv_exit" "$project_root/src/debian-release.mjs" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const modulePath = pathToFileURL(process.argv[4]).href;
const { requireGpgvValidSignature } = await import(modulePath);
const signatures = requireGpgvValidSignature(fs.readFileSync(process.argv[2], 'utf8'));
if (process.argv[3] !== '0') {
  process.stderr.write(`gpgv exited ${process.argv[3]}; accepted ${signatures.length} trusted signature(s)\n`);
}
NODE

node "$project_root/scripts/resolve-debian-stable.mjs" \
  "$inrelease" "$output_path" "$source_url"
