#!/usr/bin/env bash
# Installed root-owned in /usr/local/lib/tech-woman; the SSH key can invoke only this command, never a shell.
# Protocol TWDEPLOY/2 on stdin (LF lines, ASCII). Deny-by-default: every check runs before any effect.
set -euo pipefail
umask 077
self=$(readlink -f -- "${BASH_SOURCE[0]}")

reject() { echo 'invalid digest or unsupported protocol' >&2; exit 64; }

IFS= read -r header || reject
IFS= read -r op || reject
[[ "$header" == 'TWDEPLOY/2' ]] || reject
if [[ "$op" == 'probe' ]]; then
  printf '{"protocol":2,"script_sha256":"%s"}\n' "$(sha256sum -- "$self" | cut -d' ' -f1)"
  exit 0
fi
[[ "$op" == 'deploy' ]] || reject
IFS= read -r digest || reject
IFS= read -r release_commit || reject
IFS= read -r release_tree || reject
IFS= read -r migrations_aggregate || reject
IFS= read -r migrations_count || reject
IFS= read -r token || reject
echo 'state marker unavailable' >&2
exit 70
