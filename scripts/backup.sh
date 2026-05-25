#!/usr/bin/env bash
# Nightly Postgres backup to Cloudflare R2. Cron with:
#   0 2 * * *  /opt/mrs-samuel/scripts/backup.sh >> /var/log/ms-backup.log 2>&1
#
# Prereqs on the host:
#   1. Install rclone:           sudo apt install -y rclone
#   2. Configure R2 remote:      rclone config  (name it "r2", type "s3", provider "Cloudflare")
#   3. Create bucket "ms-backups" in the Cloudflare dashboard.

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/mrs-samuel}"
REMOTE="${REMOTE:-r2:ms-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

cd "$PROJECT_DIR"

# Source production env to get POSTGRES_USER / DB.
set -a
. ./.env.production
set +a

stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
dump_name="ms-${stamp}.sql.gz"

docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip -9 \
  | rclone rcat "$REMOTE/$dump_name"

echo "[$(date -u +%FT%TZ)] uploaded $dump_name"

# Retention: drop anything older than RETAIN_DAYS.
rclone delete --min-age "${RETAIN_DAYS}d" "$REMOTE" || true
echo "[$(date -u +%FT%TZ)] retention sweep done"
