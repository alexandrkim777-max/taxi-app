#!/usr/bin/env bash
# Real restore after a disaster: replaces the live database with a dump (and, if given, the
# uploaded files with an archive). Stops the API first so nothing writes during the restore.
#   deploy/restore.sh /var/backups/taxi/taxi-2026-11-02-0300.dump [/var/backups/taxi/files-2026-11-02-0300.tgz]
set -euo pipefail
cd "$(dirname "$0")"
DUMP=${1:?usage: restore.sh <taxi-*.dump> [files-*.tgz]}
FILES=${2:-}
[ -f "$DUMP" ] || { echo "no such file: $DUMP"; exit 1; }
docker compose exec -T db pg_restore --list < "$DUMP" > /dev/null

echo "This REPLACES the live database with $DUMP."
read -r -p "Type RESTORE to continue: " ANSWER
[ "$ANSWER" = "RESTORE" ] || { echo "cancelled"; exit 1; }

docker compose stop api
psql() { docker compose exec -T db psql -U taxi -v ON_ERROR_STOP=1 -q "$@"; }
psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'taxi' AND pid <> pg_backend_pid()" >/dev/null
psql -d postgres -c "DROP DATABASE taxi" -c "CREATE DATABASE taxi OWNER taxi"
docker compose exec -T db pg_restore -U taxi -d taxi --no-owner --exit-on-error < "$DUMP"
if [ -n "$FILES" ]; then
  docker compose run --rm --no-deps -T --entrypoint sh api -c "rm -rf /data/files/* && tar -C /data -xzf -" < "$FILES"
fi
# The API runs any newer migrations on start; the background loops pick up where the data says.
docker compose up -d api
echo "restored from $DUMP"
