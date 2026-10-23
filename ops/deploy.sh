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

source "$(dirname -- "$self")/paths.env"
export PATH
if [[ "${lines[1]:-}" == 'probe' && ${#lines[@]} -eq 2 ]]; then
  phase=$("$TW_PYTHON" -I "$(dirname -- "$self")/cutover.py" phase)
  printf '{"protocol":2,"script_sha256":"%s","phase":"%s"}\n' "$(sha256sum -- "$self" | cut -d' ' -f1)" "$phase"
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


exec 9>"$TW_LOCK_FILE"
flock -n 9 || { echo 'deployment in progress' >&2; exit 66; }

here=$(dirname -- "$self")
rc=0
verdict=$("$TW_PYTHON" -I "$here/cutover.py" gate --digest "$digest" \
  --release-commit "$release_commit" --release-tree "$release_tree" \
  --migrations-aggregate "$migrations_aggregate" --migrations-count "$migrations_count") || rc=$?
[[ $rc -eq 0 ]] || exit "$rc"
if [[ "$verdict" == *'"op": "stage"'* ]]; then operation=stage
elif [[ "$verdict" == *'"op": "release"'* ]]; then operation=release
else echo 'unexpected gate verdict' >&2; exit 75; fi
candidate_sha=${verdict#*'"candidate_sha256": "'}
candidate_sha=${candidate_sha%%\"*}
script_sha=$(sha256sum -- "$self" | cut -d' ' -f1)

# Pull and verify the exact digest. Nothing is stopped, renamed or started before this has passed.
cfg=$(mktemp -d)
trap 'rm -rf "$cfg"' EXIT
image="ghcr.io/dellanio/tech-woman@$digest"
printf '%s' "$token" | docker --config "$cfg" login ghcr.io -u dellanio --password-stdin >/dev/null \
  || { echo 'registry login failed' >&2; exit 74; }
unset token
docker --config "$cfg" pull "$image" >/dev/null || { echo 'image pull failed' >&2; exit 74; }
rc=0
bash "$here/verify-image.sh" "$image" "$release_commit" "$migrations_aggregate" "$migrations_count" >/dev/null || rc=$?
[[ $rc -eq 0 ]] || exit "$rc"

if [[ "$operation" == stage ]]; then
  # Stage never activates anything and never writes the marker: the operator registers this attestation
  # with cutover.py register-stage after verifying the image locally.
  printf '{"stage":"verified","attestation":{"digest":"%s","release_commit":"%s","release_tree":"%s",' \
    "$digest" "$release_commit" "$release_tree"
  printf '"migrations_aggregate":"%s","migrations_count":%s,"candidate_sha256":"%s","script_sha256":"%s",' \
    "$migrations_aggregate" "$migrations_count" "$candidate_sha" "$script_sha"
  printf '"phase":"prepared"}}\n'
  exit 0
fi

# ---- Release in the PostgreSQL era (marker is pg_write_open, schema unchanged) ----
# Only a previously attested PostgreSQL image may ever be restarted. SQLite containers and images are never
# touched here: a running web that is not a known PostgreSQL image is denied (76) before any effect.
network=$TW_NETWORK
meta=$(docker inspect tech-woman --format '{{.Config.Image}}|{{(index .NetworkSettings.Networks "'"$network"'").IPAddress}}') \
  || { echo 'cannot inspect the running web' >&2; exit 74; }
previous_image=${meta%%|*}
ip=${meta##*|}
re_ip='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
[[ "$ip" =~ $re_ip ]] || { echo 'unexpected network description' >&2; exit 74; }
rc=0
last_good=$("$TW_PYTHON" -I "$here/cutover.py" release-check --previous-image "$previous_image") || rc=$?
[[ $rc -eq 0 ]] || exit "$rc"

ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$TW_BACKUP_DIR"
dump="$TW_BACKUP_DIR/pre-release-$ts.dump"
if ! docker exec "$TW_PG_CONTAINER" pg_dump -Fc -U "$TW_PG_DUMP_USER" "$TW_PG_DB" > "$dump" || [[ ! -s "$dump" ]]; then
  mv -- "$dump" "$dump.failed" 2>/dev/null || true
  echo 'pre-release backup failed; nothing was changed' >&2
  exit 79
fi

maintenance="require('http').createServer((q,r)=>{r.writeHead(503,{'Retry-After':'600','Content-Type':'text/plain'});r.end('Manutencao programada. Tente novamente em alguns minutos.')}).listen(3000,'0.0.0.0')"
smoke="fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
previous_name="tech-woman-previous-$ts"

rollback() {
  docker rm -f tech-woman >/dev/null 2>&1 || true
  if [[ "$last_good" != none ]]; then
    docker rename "$previous_name" tech-woman >/dev/null && docker start tech-woman >/dev/null
    docker start tech-woman-mailer >/dev/null 2>&1 || true
    echo 'release failed; the last good PostgreSQL web was restarted' >&2
  else
    docker run -d --name tech-woman --restart unless-stopped --network "$network" --ip "$ip" --network-alias app \
      --memory 64m --cpus 0.1 --log-opt max-size=10m --log-opt max-file=3 --entrypoint node "$image" -e "$maintenance" >/dev/null || true
    echo 'release failed and no last good image exists; maintenance page (503) kept' >&2
  fi
  exit 77
}

docker stop tech-woman-mailer >/dev/null 2>&1 || true
docker stop tech-woman >/dev/null || { echo 'cannot stop the web' >&2; exit 77; }
docker rename tech-woman "$previous_name" >/dev/null || { docker start tech-woman >/dev/null || true; exit 77; }
docker run -d --name tech-woman --restart unless-stopped --network "$network" --ip "$ip" --network-alias app \
  --env-file "$TW_ENV_DIR/web.env" --memory 384m --cpus 0.5 --log-opt max-size=10m --log-opt max-file=3 \
  "$image" >/dev/null || rollback
healthy=false
for attempt in $(seq 1 "$TW_SMOKE_ATTEMPTS"); do
  if docker exec tech-woman node -e "$smoke" >/dev/null 2>&1; then healthy=true; break; fi
  sleep "$TW_SMOKE_DELAY"
done
[[ "$healthy" == true ]] || rollback

docker rename tech-woman-mailer "tech-woman-mailer-previous-$ts" >/dev/null 2>&1 || true
docker run -d --name tech-woman-mailer --restart unless-stopped --network "$network" \
  --env-file "$TW_ENV_DIR/mailer.env" --workdir /tools --memory 256m --cpus 0.25 --log-opt max-size=10m \
  --log-opt max-file=3 --entrypoint node "$image" --import tsx scripts/email-worker.ts >/dev/null \
  || { echo 'web released but the mailer could not start' >&2; exit 77; }
printf '{"op":"release","release":"verified","attestation":{"digest":"%s","release_commit":"%s","release_tree":"%s",' \
  "$digest" "$release_commit" "$release_tree"
printf '"migrations_aggregate":"%s","migrations_count":%s,"candidate_sha256":"%s","script_sha256":"%s",' \
  "$migrations_aggregate" "$migrations_count" "$candidate_sha" "$script_sha"
printf '"previous_container":"%s","backup":"pre-release-%s.dump"}}\n' "$previous_name" "$ts"
exit 0
