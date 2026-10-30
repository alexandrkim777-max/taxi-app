#!/usr/bin/env bash
# Plays one whole cash ride through the live API on this server with two temporary test accounts
# and prints the first-ride checklist: what the server proved, what to check on two phones.
# Safe to run any time: the test accounts are deleted afterwards. Exit code 1 if a server check fails.
set -euo pipefail
cd "$(dirname "$0")"
docker compose exec -T api node --experimental-strip-types --no-warnings src/tools/first-ride-check.ts
