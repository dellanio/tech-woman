#!/usr/bin/env bash
# Installed root-owned in /usr/local/lib/tech-woman; the SSH key can invoke only this command, never a shell.
# Protocol TWDEPLOY/2 on stdin (LF lines, ASCII). Deny-by-default: every check runs before any effect.
set -euo pipefail
umask 077
self=$(readlink -f -- "${BASH_SOURCE[0]}")

IFS= read -r header || true
IFS= read -r op || true
if [[ "$header" == 'TWDEPLOY/2' && "$op" == 'probe' ]]; then
  printf '{"protocol":2,"script_sha256":"%s"}\n' "$(sha256sum -- "$self" | cut -d' ' -f1)"
  exit 0
fi
echo 'invalid digest or unsupported protocol' >&2
exit 64
