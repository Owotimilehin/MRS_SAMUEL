#!/usr/bin/env bash
# Pull latest, rebuild changed images, run migrator, swap services.
# Usage on the VPS (run from the repo root):
#   ./scripts/deploy.sh
#
# Safe to run repeatedly. Pre-flights:
#   - .env.production exists
#   - docker compose, git installed
#   - The host user is in the docker group

set -euo pipefail

if [[ ! -f .env.production ]]; then
  echo "ERROR: .env.production missing. Copy .env.production.example and fill it in."
  exit 1
fi

COMPOSE="docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml"

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Building images"
$COMPOSE build

echo "==> Running migrator"
$COMPOSE run --rm migrator

echo "==> Restarting long-lived services"
$COMPOSE up -d --remove-orphans

echo "==> Pruning dangling images"
docker image prune -f

echo "==> Status"
$COMPOSE ps

echo "==> Done. Health:"
sleep 4
curl -sf https://api.mrssamueljuice.com/v1/health || echo "(api not yet healthy — give it 10s)"
