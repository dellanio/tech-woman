#!/usr/bin/env bash
# Installed root-owned in /usr/local/lib/tech-woman; the SSH key can invoke only this command, never a shell.
# Protocol TWDEPLOY/2 on stdin (LF lines, ASCII). Deny-by-default: every check runs before any effect.
set -euo pipefail
umask 077
export LC_ALL=C
self=$(readlink -f -- "${BASH_SOURCE[0]}")

reject() { echo 'invalid digest or unsupported protocol' >&2; exit 64; }

# Read at most 20000 bytes. A NUL byte or a longer input ends the read with status 0, which is rejected.
input=''
IFS= read -r -d '' -n 20001 input && reject
[[ "$input" =~ ^[[:print:]$'\n']*$ ]] || reject
[[ "$input" == *$'\n' ]] || reject
mapfile -t lines <<<"${input%$'\n'}"
for line in "${lines[@]}"; do (( ${#line} <= 4096 )) || reject; done
[[ "${lines[0]}" == 'TWDEPLOY/2' ]] || reject

if [[ "${lines[1]:-}" == 'probe' && ${#lines[@]} -eq 2 ]]; then
  printf '{"protocol":2,"script_sha256":"%s"}\n' "$(sha256sum -- "$self" | cut -d' ' -f1)"
  exit 0
fi
[[ "${lines[1]:-}" == 'deploy' && ${#lines[@]} -eq 8 ]] || reject
digest=${lines[2]} release_commit=${lines[3]} release_tree=${lines[4]}
migrations_aggregate=${lines[5]} migrations_count=${lines[6]} token=${lines[7]}
re_digest='^sha256:[0-9a-f]{64}$' re_sha1='^[0-9a-f]{40}$' re_sha256='^[0-9a-f]{64}$'
re_count='^[1-9][0-9]{0,3}$' re_token='^[A-Za-z0-9_.~+/=-]+$'
[[ "$digest" =~ $re_digest && "$release_commit" =~ $re_sha1 && "$release_tree" =~ $re_sha1 \
   && "$migrations_aggregate" =~ $re_sha256 && "$migrations_count" =~ $re_count \
   && "$token" =~ $re_token && ${#token} -le 512 ]] || reject
unset lines input

source "$(dirname -- "$self")/paths.env"
export PATH
exec 9>"$TW_LOCK_FILE"
flock -n 9 || { echo 'deployment in progress' >&2; exit 66; }

rc=0
verdict=$("$TW_PYTHON" -I "$(dirname -- "$self")/cutover.py" gate --digest "$digest" \
  --release-commit "$release_commit" --release-tree "$release_tree" \
  --migrations-aggregate "$migrations_aggregate" --migrations-count "$migrations_count") || rc=$?
[[ $rc -eq 0 ]] || exit "$rc"
printf '%s\n' "$verdict"
exit 0
