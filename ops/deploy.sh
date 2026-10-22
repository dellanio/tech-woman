#!/usr/bin/env bash
# Installed root-owned; SSH key can invoke only this command, never a shell.
set -euo pipefail
IFS= read -r digest
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'invalid digest' >&2; exit 64; }
exec 9>/var/lock/tech-woman-deploy.lock
flock -n 9
cd /var/www/tech-woman
umask 077
cfg=$(mktemp -d)
trap 'rm -rf "$cfg"' EXIT
IFS= read -r token
printf '%s' "$token" | docker --config "$cfg" login ghcr.io -u dellanio --password-stdin >/dev/null
unset token
image="ghcr.io/dellanio/tech-woman@$digest"
docker --config "$cfg" pull "$image"
previous=$(docker inspect tech-woman --format '{{.Config.Image}}')
ip=$(docker inspect tech-woman --format '{{(index .NetworkSettings.Networks "dellaniocom_default").IPAddress}}')
backup="/var/www/tech-woman/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
python3 - "$backup" <<'PY'
import sqlite3, sys
source = sqlite3.connect('file:/var/www/tech-woman/dados/tech-woman.db?mode=ro', uri=True)
target = sqlite3.connect(sys.argv[1] + '/tech-woman.db')
source.backup(target)
assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
target.close()
source.close()
PY
printf '%s\n' "$previous" > "$backup/previous-image"
# Keep the old container (stopped), rather than delete it; rollback preserves DB.
old="tech-woman-previous-$(date -u +%Y%m%dT%H%M%SZ)"
docker stop tech-woman >/dev/null
docker rename tech-woman "$old"
rollback() {
  docker stop tech-woman >/dev/null 2>&1 || true
  docker rename tech-woman "tech-woman-failed-$(date -u +%Y%m%dT%H%M%SZ)" || true
  docker rename "$old" tech-woman
  docker start tech-woman >/dev/null
  echo 'deployment failed; previous container restored; database backup retained' >&2
  exit 1
}
trap rollback ERR
docker run -d --name tech-woman --restart unless-stopped --env-file .env \
  --network dellaniocom_default --ip "$ip" --network-alias app \
  --mount type=bind,src=/var/www/tech-woman/dados,dst=/app/data \
  --memory 384m --cpus 0.5 --log-opt max-size=10m --log-opt max-file=3 "$image" >/dev/null
healthy=false
for attempt in $(seq 1 45); do
  if docker exec tech-woman node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]] || rollback
# nginx may cache the old container IP; verify public route without restarting it.
curl --fail --silent --show-error --retry 8 --retry-all-errors --retry-delay 3 https://tech-woman.dellanio.com/ >/dev/null
printf '%s\n' "$image" > deployed-image
trap - ERR
echo "Deployed $image; backup $backup; previous $old"
