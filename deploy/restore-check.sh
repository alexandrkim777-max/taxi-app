#!/usr/bin/env bash
# Weekly restore drill (run by cron from setup.sh): restores the newest dump into a scratch
# database next to the live one, checks that the data is really there, then drops it.
# A backup that was never restored is a hope, not a backup. The live database is not touched.
set -euo pipefail
cd "$(dirname "$0")"
DUMP=$(ls -1t /var/backups/taxi/taxi-*.dump 2>/dev/null | head -1)
[ -n "$DUMP" ] || { echo "restore check FAILED: no dump found"; exit 1; }
SCRATCH=taxi_restore_check
psql() { docker compose exec -T db psql -U taxi -v ON_ERROR_STOP=1 -qtA "$@"; }

psql -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH" -c "CREATE DATABASE $SCRATCH"
trap 'psql -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null' EXIT
docker compose exec -T db pg_restore -U taxi -d "$SCRATCH" --no-owner --exit-on-error < "$DUMP"

# Same number of migrations as the live database, and the core tables answer.
LIVE=$(psql -d taxi -c "SELECT count(*) FROM schema_migrations")
COPY=$(psql -d "$SCRATCH" -c "SELECT count(*) FROM schema_migrations")
USERS=$(psql -d "$SCRATCH" -c "SELECT count(*) FROM users")
RIDES=$(psql -d "$SCRATCH" -c "SELECT count(*) FROM rides")
PAYMENTS=$(psql -d "$SCRATCH" -c "SELECT count(*) FROM payments")
[ "$COPY" -ge 1 ] || { echo "restore check FAILED: no migrations in the copy"; exit 1; }
echo "restore check ok: $(basename "$DUMP") migrations=$COPY (live $LIVE) users=$USERS rides=$RIDES payments=$PAYMENTS"
