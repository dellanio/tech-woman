#!/usr/bin/env bash
# verify-image.sh <image@sha256:digest> <release_commit> <migrations_aggregate> <migrations_count>
# Read-only verification of a pulled image: every docker run is --rm --network none. Env files are checked by
# variable NAME only; values are never read into a variable, printed or logged. Exit: 64 usage, 72 migrations,
# 74 invalid image, 76 SQLite fallback present.
set -euo pipefail
umask 077
export LC_ALL=C
self=$(readlink -f -- "${BASH_SOURCE[0]}")
here=$(dirname -- "$self")

fail() { echo "verify-image: $2" >&2; exit "$1"; }

# --image-only (CI): a local image id, no host env files. The host never passes it (deploy.sh, cutover.py).
image_only=false
if [[ "${1:-}" == --image-only ]]; then image_only=true; shift; fi
[[ $# -eq 4 ]] || fail 64 'usage: verify-image.sh [--image-only] <ref> <release_commit> <aggregate> <count>'
ref=$1 commit=$2 aggregate=$3 count=$4
re_ref='^ghcr\.io/dellanio/tech-woman@sha256:[0-9a-f]{64}$' re_sha1='^[0-9a-f]{40}$'
if [[ "$image_only" == true ]]; then re_ref='^sha256:[0-9a-f]{64}$'; fi
re_sha256='^[0-9a-f]{64}$' re_count='^[1-9][0-9]{0,3}$'
[[ "$ref" =~ $re_ref && "$commit" =~ $re_sha1 && "$aggregate" =~ $re_sha256 && "$count" =~ $re_count ]] \
  || fail 64 'invalid arguments'

source "$here/paths.env"
export PATH

in_image() { docker run --rm --network none --entrypoint test "$ref" "$@"; }

meta=$(docker image inspect "$ref" \
  --format '{{.Architecture}}|{{.Os}}|{{index .Config.Labels "org.opencontainers.image.revision"}}') \
  || fail 74 'image is not present locally'
[[ "$meta" == "arm64|linux|$commit" ]] || fail 74 'image platform or revision label does not match the release'

for required in /app/server.js /tools/scripts/email-worker.ts /tools/scripts/migration/migrate.ts; do
  in_image -f "$required" || fail 74 "image lacks $required"
done

rc=0
docker run --rm --network none --entrypoint tar "$ref" -cf - -C /tools/drizzle . \
  | "$TW_PYTHON" -I "$here/manifest.py" check-migrations-tar "$aggregate" "$count" >/dev/null || rc=$?
[[ $rc -eq 0 ]] || fail "$rc" 'image migrations differ from the sealed candidate'

for forbidden in /app/node_modules/better-sqlite3 /tools/node_modules/better-sqlite3; do
  in_image ! -e "$forbidden" || fail 76 'SQLite fallback present in the image'
done
rc=0
docker run --rm --network none --entrypoint grep "$ref" -rIlE 'better-sqlite3|sqlite-core' /tools/src/lib >/dev/null || rc=$?
case $rc in
  1) ;;
  0) fail 76 'SQLite code present in the image' ;;
  *) fail 74 'cannot scan the image for SQLite code' ;;
esac

checks='"platform","revision","entrypoints","migrations","no-sqlite"'
if [[ "$image_only" == true ]]; then
  printf '{"verified":true,"checks":[%s]}\n' "$checks"
  exit 0
fi

env_dir=$TW_ENV_DIR
for file in web.env mailer.env migrator.env; do
  [[ -f "$env_dir/$file" ]] || fail 74 "env file $file is missing"
done
if grep -Eq '^(MIGRATION_DATABASE_URL|MAILER_DATABASE_URL)=' "$env_dir/web.env"; then
  fail 74 'web env carries another role credential'
fi
if grep -Eq '^MIGRATION_DATABASE_URL=' "$env_dir/mailer.env"; then
  fail 74 'mailer env carries the migrator credential'
fi

printf '{"verified":true,"checks":[%s,"env-names"]}\n' "$checks"
