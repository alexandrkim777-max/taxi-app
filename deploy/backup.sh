#!/usr/bin/env bash
# Daily backup (run by cron from setup.sh): the database and the uploaded files (driver documents).
# A dump is written to a temporary name and only kept if pg_restore can read it back.
# Optional off-site copy: set BACKUP_RSYNC_TARGET in deploy/.env (e.g. backup@host:/srv/taxi) and
# give root an SSH key for it. Without it a dead server takes its backups with it.
set -euo pipefail
cd "$(dirname "$0")"
DIR=/var/backups/taxi
KEEP_DAYS=14
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP=$(date +%F-%H%M)

docker compose exec -T db pg_dump -U taxi -Fc taxi > "$DIR/.taxi-$STAMP.dump.part"
docker compose exec -T db pg_restore --list < "$DIR/.taxi-$STAMP.dump.part" > /dev/null
mv "$DIR/.taxi-$STAMP.dump.part" "$DIR/taxi-$STAMP.dump"

docker compose exec -T api tar -C /data -czf - files > "$DIR/.files-$STAMP.tgz.part"
mv "$DIR/.files-$STAMP.tgz.part" "$DIR/files-$STAMP.tgz"

find "$DIR" -name '*.part' -delete
find "$DIR" \( -name 'taxi-*.dump' -o -name 'files-*.tgz' \) -mtime +$KEEP_DAYS -delete

TARGET=$(grep -E '^BACKUP_RSYNC_TARGET=' .env | cut -d= -f2- || true)
if [ -n "$TARGET" ]; then
  rsync -a --delete -e "ssh -o BatchMode=yes" "$DIR/" "$TARGET/"
fi
echo "backup ok: $DIR/taxi-$STAMP.dump"
