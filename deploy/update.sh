#!/usr/bin/env bash
# Deploy the latest code: pull, rebuild, restart (migrations run on start).
set -euo pipefail
cd "$(dirname "$0")"
git -C .. pull --ff-only
docker compose up -d --build api caddy
docker image prune -f >/dev/null
docker compose ps
