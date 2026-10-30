#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 test server (run as root):
#   git clone https://github.com/alexandrkim777-max/taxi-app.git /opt/taxi && /opt/taxi/deploy/setup.sh
# Installs Docker, closes every port except SSH/HTTP/HTTPS, generates secrets, downloads the
# OpenStreetMap extract of Uzbekistan, prepares routing, and starts everything.
set -euo pipefail
cd "$(dirname "$0")"

IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN=${DOMAIN:-$IP.sslip.io}

echo "== Docker and firewall"
if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -yq ca-certificates curl ufw unattended-upgrades
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# Security updates install themselves.
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "== Secrets (kept only in deploy/.env on this server)"
if [ ! -f .env ]; then
  umask 077
  cat > .env <<ENV
NODE_ENV=staging
DOMAIN=$DOMAIN
PUBLIC_API_URL=https://$DOMAIN
PUBLIC_BASE_URL=https://$DOMAIN
FILE_BASE_URL=https://$DOMAIN/files/
DEFAULT_CITY_CODE=tashkent
AUTH_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NOMINATIM_PASSWORD=$(openssl rand -hex 24)
PAYMENT_TOKEN_KEY=$(openssl rand -base64 32)
FAKE_PAYMENT_SECRET=$(openssl rand -hex 24)
# Test server: SMS codes go to the API log, payments are pretend. Switch when the contracts are signed.
SMS_PROVIDER=console
PAYMENT_PROVIDERS=fake
PAYMENT_RETURN_URL=taxiapp://payment-result
PUSH_PROVIDER=expo
EXPO_ACCESS_TOKEN=
ENV
fi

echo "== OpenStreetMap extract of Uzbekistan"
mkdir -p data/osm data/osrm
curl -fL -o data/osm/uzbekistan-latest.osm.pbf https://download.geofabrik.de/asia/uzbekistan-latest.osm.pbf

echo "== Routing data (OSRM, a few minutes)"
cp data/osm/uzbekistan-latest.osm.pbf data/osrm/
OSRM=ghcr.io/project-osrm/osrm-backend:v5.27.1
docker run --rm -v "$PWD/data/osrm:/data" $OSRM osrm-extract -p /opt/car.lua /data/uzbekistan-latest.osm.pbf
docker run --rm -v "$PWD/data/osrm:/data" $OSRM osrm-partition /data/uzbekistan-latest.osrm
docker run --rm -v "$PWD/data/osrm:/data" $OSRM osrm-customize /data/uzbekistan-latest.osrm

echo "== Start"
docker compose up -d --build

echo "== Backups: daily (database + uploaded files, kept 14 days), weekly restore drill"
cat > /etc/cron.daily/taxi-backup <<CRON
#!/bin/sh
$(pwd)/backup.sh >> /var/log/taxi-backup.log 2>&1
CRON
cat > /etc/cron.weekly/taxi-restore-check <<CRON
#!/bin/sh
$(pwd)/restore-check.sh >> /var/log/taxi-backup.log 2>&1
CRON
chmod 700 /etc/cron.daily/taxi-backup /etc/cron.weekly/taxi-restore-check

echo
echo "Done. API: https://$DOMAIN   Staff panel: https://$DOMAIN/admin/"
echo "Address search imports in the background (about an hour): docker compose logs -f nominatim"
