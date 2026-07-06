# Deploy

Single Hetzner VPS + Cloudflare Tunnel. ~$5/month. No firewall config, no SSL
setup, no scripts.

## 1. Provision the VPS

[Hetzner Cloud](https://console.hetzner.cloud) → Add Server → Ubuntu 24.04 →
CX22 (€4.51/mo) → Frankfurt → your SSH key. Note the IPv4.

```bash
ssh root@<vps-ip>
apt update && apt install -y docker.io docker-compose-plugin git
adduser --disabled-password --gecos "" ops
usermod -aG docker ops
mkdir -p /home/ops/.ssh && cp ~/.ssh/authorized_keys /home/ops/.ssh/
chown -R ops:ops /home/ops/.ssh && chmod 600 /home/ops/.ssh/authorized_keys
```

## 2. Clone + configure

```bash
ssh ops@<vps-ip>
git clone https://github.com/Owotimilehin/MRS_SAMUEL.git /opt/mrs-samuel
cd /opt/mrs-samuel
cp .env.production.example .env
# Fill in secrets:
nano .env
# Generate strong values:
openssl rand -hex 32   # → JWT_SIGNING_KEY
openssl rand -hex 24   # → POSTGRES_PASSWORD
docker compose up -d
```

Wait ~30s. Smoke test:

```bash
curl -s http://localhost:3001/v1/health
# → {"status":"ok","checks":{"db":"ok"}}
```

## 3. Cloudflare Tunnel (HTTPS, no certs to manage)

In Cloudflare → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**:

1. Name it `ms-prod`. Save.
2. Copy the install command for Debian/Ubuntu and run it on the VPS:
   ```bash
   curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared.deb
   sudo cloudflared service install <TOKEN-FROM-DASHBOARD>
   ```
3. In the dashboard, add three public hostnames pointing at the local containers:

   | Hostname | Service |
   |---|---|
   | `www.mrssamuel.com` | `http://localhost:3002` |
   | `admin.mrssamuel.com` | `http://localhost:3010` |
   | `api.mrssamuel.com` | `http://localhost:3001` |

   Also add a root domain rule: `mrssamuel.com` → `http://localhost:3002`.

Cloudflare issues SSL certs automatically. Visit `https://www.mrssamuel.com`
in 30 seconds.

## 4. Register webhooks

In each provider's dashboard:

- **OPay** → callback URL: `https://api.mrssamuel.com/v1/webhooks/opay` (merchant dashboard). Primary provider; the callback is only a wake-up — payment is re-verified server-to-server via cashier/status.
- **Payaza** → webhook URL: `https://api.mrssamuel.com/v1/webhooks/payaza` (Settings → API Keys & Webhooks) — fallback provider.
- **Shipbubble** → webhook URL: `https://api.mrssamuel.com/v1/webhooks/shipbubble`

The webhook secrets in `.env` must match what each dashboard shows.

## 5. Nightly Postgres backup

One cron line (run `crontab -e`):

```cron
0 2 * * * cd /opt/mrs-samuel && docker compose exec -T postgres pg_dump -U ms ms_prod | gzip > /opt/backups/ms-$(date +\%F).sql.gz && find /opt/backups -name "ms-*.sql.gz" -mtime +30 -delete
```

```bash
mkdir -p /opt/backups
```

Restore: `gunzip -c /opt/backups/ms-2026-05-25.sql.gz | docker compose exec -T postgres psql -U ms ms_prod`

## 6. Subsequent deploys

```bash
ssh ops@<vps-ip>
cd /opt/mrs-samuel
git pull
docker compose up -d --build
```

That's it. The migrator runs automatically on every `up`; long-lived services
restart with the new images.

## Useful

| Task | Command |
|---|---|
| Logs (live) | `docker compose logs -f --tail=200 api worker` |
| Run a one-off psql | `docker compose exec postgres psql -U ms ms_prod` |
| Restart one service | `docker compose restart api` |
| Health | `curl http://localhost:3001/v1/health` |
