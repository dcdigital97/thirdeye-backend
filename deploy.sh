#!/usr/bin/env bash
# Pull the latest code and (re)start the backend. Run from the repo dir on the VPS.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and fill in AISSTREAM_API_KEY + BACKEND_DOMAIN first."
  exit 1
fi

echo "==> Pulling latest…"
git pull --ff-only || echo "(skip git pull — not a git checkout)"

echo "==> Building + starting containers…"
docker compose up -d --build

echo "==> Waiting for health…"
sleep 3
docker compose ps
echo "==> Local health check:"
docker compose exec -T backend wget -qO- http://127.0.0.1:8080/api/health || true
echo
echo "Done. Public health check:  curl https://\$BACKEND_DOMAIN/api/health"
