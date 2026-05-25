# Production deployment

Single-VPS deployment for Mrs. Samuel. Runs the entire stack via Docker
Compose with Caddy fronting HTTPS, plus Cloudflare for DNS, edge caching,
and DDoS. Total cost: **~$5/month**.

## 1. Provision the VPS

[Hetzner Cloud](https://console.hetzner.cloud) → **Add Server**.

| Setting | Value |
|---|---|
| Location | Frankfurt or Nuremberg |
| Image | Ubuntu 24.04 |
| Type | **CX22** (€4.51/mo — 4 GB RAM, 2 vCPU, 40 GB SSD) |
| Networking | Public IPv4 + IPv6 |
| SSH key | Your laptop's `~/.ssh/id_ed25519.pub` |
| Name | `ms-prod-1` |

Note the assigned IPv4 address.

## 2. Point DNS at the VPS

In Cloudflare → your zone `mrssamueljuice.com`:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | VPS IPv4 | DNS-only (grey) for first boot |
| A | `www` | VPS IPv4 | DNS-only |
| A | `admin` | VPS IPv4 | DNS-only |
| A | `api` | VPS IPv4 | DNS-only |

Flip to "Proxied" (orange cloud) only **after** Caddy has issued certs.

## 3. Bootstrap the VPS

```bash
ssh root@<vps-ip>

# System packages
apt update && apt upgrade -y
apt install -y docker.io docker-compose-plugin git rclone ufw

# Firewall: only SSH + web
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# Non-root user
adduser --disabled-password --gecos "" ops
usermod -aG docker ops
mkdir -p /home/ops/.ssh
cp ~/.ssh/authorized_keys /home/ops/.ssh/
chown -R ops:ops /home/ops/.ssh
chmod 700 /home/ops/.ssh
chmod 600 /home/ops/.ssh/authorized_keys
```

From here on, log in as `ops` (not root).

## 4. Clone the repo & wire env

```bash
ssh ops@<vps-ip>

git clone https://github.com/<you>/mrs-samuel.git /opt/mrs-samuel
cd /opt/mrs-samuel

cp .env.production.example .env.production
# Generate strong secrets:
echo "JWT_SIGNING_KEY=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
nano .env.production   # paste those, plus Payaza / Bolt / Resend / Sentry keys
```

Edit `Caddyfile` if your domain isn't `mrssamueljuice.com` — change all four
hostnames and the `email` directive.

## 5. First boot

```bash
chmod +x scripts/deploy.sh scripts/backup.sh
./scripts/deploy.sh
```

This builds the images, runs the migrator, and starts every long-lived
service. Caddy issues Let's Encrypt certs on first request to each hostname
(takes ~30 seconds per domain).

Smoke test:

```bash
curl https://api.mrssamueljuice.com/v1/health
# → {"status":"ok","checks":{"db":"ok"}}

curl -I https://www.mrssamueljuice.com
# → HTTP/2 200
```

If certs were issued cleanly, flip the four DNS records in Cloudflare to
"Proxied" (orange cloud). Now you get free CDN, Lagos edge, and DDoS.

## 6. Register webhooks

In each provider's dashboard:

- **Payaza** → Webhook URL: `https://api.mrssamueljuice.com/v1/webhooks/payaza`
- **Bolt Send** → Webhook URL: `https://api.mrssamueljuice.com/v1/webhooks/bolt`

The webhook secrets you put in `.env.production` must match exactly.

## 7. Backups

```bash
# Configure rclone for Cloudflare R2 (interactive — pick S3 + Cloudflare):
rclone config

# Test it once:
./scripts/backup.sh

# Install cron:
crontab -e
# Add this line:
0 2 * * * /opt/mrs-samuel/scripts/backup.sh >> /var/log/ms-backup.log 2>&1
```

Restore from a dump:

```bash
rclone copy r2:ms-backups/ms-2026-05-25T02-00-00Z.sql.gz /tmp/
gunzip /tmp/ms-2026-05-25T02-00-00Z.sql.gz
docker compose exec -T postgres psql -U ms ms_prod < /tmp/ms-2026-05-25T02-00-00Z.sql
```

## 8. Subsequent deploys

After you push a change:

```bash
ssh ops@<vps-ip>
cd /opt/mrs-samuel
./scripts/deploy.sh
```

`scripts/deploy.sh` does `git pull`, rebuilds changed images, runs the
migrator (idempotent), and rolls services.

## 9. Cloudflare hardening (optional but free)

In the Cloudflare dashboard:

- **SSL/TLS** → Mode = **Full (strict)**
- **SSL/TLS → Edge Certificates** → Always Use HTTPS = **On**
- **Speed → Optimization** → Auto Minify JS/CSS/HTML = On, Brotli = On
- **Caching → Configuration** → Browser Cache TTL = **Respect existing headers**
- **Security → Settings** → Security Level = Medium, Bot Fight Mode = On
- **Rules → Page Rules** (free tier gives 3):
  - `api.mrssamueljuice.com/*` → Cache Level: **Bypass**
  - `*.mrssamueljuice.com/assets/*` → Cache Level: **Cache Everything**, Edge TTL: a month

## 10. Monitoring

The bare minimum at this scale:

- **Sentry** captures all uncaught errors (DSN in `.env.production`).
- **Telegram** outbox alerts you on payment mismatches, dead-lettered events,
  failed deliveries, and overdue branch closes.
- **Uptime**: free tier on [UptimeRobot](https://uptimerobot.com) pinging
  `https://api.mrssamueljuice.com/v1/health` every 5 minutes.

If you want logs: `docker compose logs -f --tail=200 api worker`.

## What's NOT covered (intentionally)

- Multi-region failover. Single VPS in Frankfurt — if it goes down, you're
  down. Cloudflare won't save the API. Acceptable at this scale.
- Blue/green deploys. Each `deploy.sh` has ~30s of cold container restart.
- Autoscaling. CX22 handles >100k requests/day easily. Bump to CX32 (€8/mo)
  when you outgrow it.

## Cost summary

| Item | Monthly |
|---|---|
| Hetzner CX22 | €4.51 (~$5) |
| Cloudflare (DNS + proxy + Pages alt) | $0 |
| Cloudflare R2 (backups, ~1 GB) | ~$0.02 |
| Sentry, Resend, UptimeRobot — free tiers | $0 |
| **Total** | **≈ $5/mo** |
