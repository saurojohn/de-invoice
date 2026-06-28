# de-invoice — Production Deployment (Tier 17)

Single-host Docker Compose deployment for SH Leder GmbH's invoice web app.

## Architecture

```
                  Internet
                     │
                     ▼
              ┌─────────────┐
              │   nginx     │   ← TLS termination (certbot)
              │  (host)     │      rate limit on /api/v1/auth
              └──────┬──────┘      security headers
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
  ┌──────────┐             ┌──────────┐
  │ frontend │             │ backend  │
  │  :3000   │             │  :3001   │
  │  Next.js │             │  NestJS  │
  └──────────┘             └────┬─────┘
                               │
                               ▼
                        ┌──────────┐
                        │ postgres │
                        │  :5432   │
                        └──────────┘
                               ▲
                               │
                        ┌──────┴──────┐
                        │   backup    │   ← cron sidecar
                        │ (pg_dump)   │      30-day retention
                        └─────────────┘
```

Five long-running services:

| Service    | Image                              | Port (host) | Restart policy   |
|------------|------------------------------------|-------------|------------------|
| postgres   | `postgres:16-alpine`               | —           | unless-stopped   |
| backend    | `de-invoice-backend:latest` (local)| —           | unless-stopped   |
| frontend   | `de-invoice-frontend:latest` (local)| —          | unless-stopped   |
| backup     | `prodrigestivill/postgres-backup-local` | —     | unless-stopped   |
| nginx      | host-installed                     | 80, 443     | host systemd     |

All app services share the `deinvoicenet` Docker bridge network so they can
talk to each other by hostname (`postgres`, `backend`, `frontend`).

nginx is intentionally NOT in a container. Certbot renews Let's Encrypt
certificates against a host-installed nginx on port 80, which is much simpler
than the sidecar / volume-mount approach.

## Prerequisites

- Linux VPS (Debian 12 / Ubuntu 24.04 LTS recommended) with at least 2 vCPU and 4 GB RAM.
- Docker Engine 24+ and Docker Compose v2 (`docker compose version` ≥ 2.20).
- A registered domain with DNS A records pointing at the VPS:
  - `rechnung.shleder.de` → VPS public IPv4
  - (optional) `*.rechnung.shleder.de` for staging
- Outbound HTTPS (port 443) for Let's Encrypt ACME validation.
- Ports 80 and 443 open on the VPS firewall.

## One-time setup

### 1. Install nginx + certbot on the host

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Copy this infra directory to the host

```bash
# From your local machine:
rsync -avz --delete \
  infra/prod/ \
  deploy@rechnung.shleder.de:/opt/de-invoice/infra/prod/

# Then on the host:
ssh deploy@rechnung.shleder.de
cd /opt/de-invoice
```

### 3. Create the .env file

```bash
cd /opt/de-invoice/infra/prod
cp .env.example .env
$EDITOR .env
```

Generate strong secrets:

```bash
# Postgres password
openssl rand -base64 32

# JWT secret (used for session tokens)
openssl rand -hex 32
```

Paste them into `.env`. Save and exit.

### 4. Install the nginx config

```bash
sudo cp infra/prod/nginx.conf /etc/nginx/sites-available/rechnung.shleder.de
sudo ln -sf /etc/nginx/sites-available/rechnung.shleder.de /etc/nginx/sites-enabled/
sudo nginx -t                  # check syntax
```

### 5. Get a Let's Encrypt certificate

certbot edits the nginx config in place; after it runs, re-apply our
nginx.conf to make sure our rate-limit / proxy headers aren't lost:

```bash
# Staging first (avoids Let's Encrypt rate limits during testing)
sudo certbot --nginx -d rechnung.shleder.de --staging

# Verify nginx config is still good
sudo nginx -t

# If staging worked, do the real thing
sudo certbot --nginx -d rechnung.shleder.de

# Re-apply our full nginx.conf (certbot adds some lines we don't want)
sudo cp infra/prod/nginx.conf /etc/nginx/sites-available/rechnung.shleder.de
sudo nginx -t && sudo systemctl reload nginx
```

Certbot installs a systemd timer that renews the cert every 60 days.
Verify it's active:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

### 6. Build and start the stack

```bash
cd /opt/de-invoice
docker compose -f infra/prod/docker-compose.yml build
docker compose -f infra/prod/docker-compose.yml up -d
```

Watch the logs:

```bash
docker compose -f infra/prod/docker-compose.yml logs -f
# Ctrl+C to detach
```

Expected output (first ~30 seconds):

```
de-invoice-postgres  | database system is ready to accept connections
de-invoice-backend   | Nest application successfully started
de-invoice-frontend  | ▲ Next.js 14 (prod)
de-invoice-backup    | Backup of de_invoice completed at 2026-06-28T03:00:01Z
```

### 7. Apply Prisma migrations

The schema in `prisma/schema.prisma` defines the tables. On a fresh
postgres, run migrations:

```bash
docker compose -f infra/prod/docker-compose.yml exec backend \
  npx prisma migrate deploy
```

This is idempotent — running it on an already-migrated database is a no-op.

### 8. Create the first user

The app has no built-in `register` flow that creates new companies
(self-service signup was intentionally avoided — admin invites
accountants). Create the first admin via SQL:

```bash
docker compose -f infra/prod/docker-compose.yml exec postgres \
  psql -U de_invoice -d de_invoice -c "
    INSERT INTO \"Company\" (id, name, \"createdAt\", \"updatedAt\")
    VALUES ('00000000-0000-0000-0000-000000000001',
            'SH Leder GmbH', NOW(), NOW())
    ON CONFLICT DO NOTHING;
  "

# Then hit the /api/v1/auth/register endpoint via the browser to create
# the user, OR run the seed script (see below).
```

For a more thorough seed (test data + SH Leder test company), run
the existing dev seed from the host (NOT from inside the container):

```bash
cd backend && bash scripts/seed-e2e-data.sh
```

This is the script our e2e tests use. It creates the SH Leder test
company + users + a few sample customers/products/vouchers.

## Day-to-day operations

### Check service health

```bash
# Container-level (compose view)
docker compose -f infra/prod/docker-compose.yml ps

# App-level (the backend's own /api/v1/health)
curl -s https://rechnung.shleder.de/api/v1/health | jq

# Frontend
curl -sI https://rechnung.shleder.de/ | head -3
```

### View logs

```bash
# All services, tailed
docker compose -f infra/prod/docker-compose.yml logs -f --tail=100

# Just one service
docker compose -f infra/prod/docker-compose.yml logs -f backend
```

### Restart a single service

```bash
docker compose -f infra/prod/docker-compose.yml restart backend
```

After a backend restart, the healthcheck will show "unhealthy" for
~20s while the Nest app re-initializes (DB connection pool, module
graph, audit-log extension, retry worker registration). This is normal.

### Update the app

```bash
cd /opt/de-invoice
git pull                                    # pull latest code
docker compose -f infra/prod/docker-compose.yml build backend frontend
docker compose -f infra/prod/docker-compose.yml up -d backend frontend
docker compose -f infra/prod/docker-compose.yml exec backend npx prisma migrate deploy
```

The backup container and postgres are NOT touched by an app update.

### Roll back

```bash
cd /opt/de-invoice
git log --oneline -5                        # find the previous commit
git checkout <previous-commit>              # or git revert HEAD
docker compose -f infra/prod/docker-compose.yml build backend frontend
docker compose -f infra/prod/docker-compose.yml up -d backend frontend
```

`prisma migrate deploy` is forward-only. If the new commit includes a
migration that breaks on rollback, restore the database from a backup
instead of trying to roll back the migration. See "Disaster recovery".

## Backups

The backup container runs `pg_dump` once per day at **03:00 Europe/Berlin**.
Backups are stored in the `backups` named volume. Retention: 30 days.

### List existing backups

```bash
docker run --rm -v de-invoice_backups:/backups alpine \
  ls -lh /backups
```

### Copy backups offsite

Schedule a cron job on the host to rsync backups to a remote
(e.g. Hetzner Storage Box or S3):

```cron
# /etc/cron.d/de-invoice-offsite
30 4 * * * deploy rsync -az /var/lib/docker/volumes/de-invoice_backups/_data/ \
                    deploy@backup.example.com:/backups/de-invoice/
```

(requires the `backups` volume to be mounted to a host path first —
edit the docker-compose.yml `volumes` section.)

### Restore from backup

```bash
# 1. Stop the backend so it doesn't write to the DB during restore
docker compose -f infra/prod/docker-compose.yml stop backend frontend

# 2. Find the backup you want
docker run --rm -v de-invoice_backups:/backups alpine ls -lh /backups

# 3. Pipe it back into postgres
docker run --rm -v de-invoice_backups:/backups \
  postgres:16-alpine bash -c '
    gunzip -c /backups/de_invoice-2026-06-28-030001.sql.gz \
      | psql -h postgres -U de_invoice -d de_invoice
  '   # ↑ this won't work — postgres isn't on the host network.
```

For an in-place restore from the compose network:

```bash
# 1. Copy the backup file out of the volume
docker run --rm -v de-invoice_backups:/backups \
  -v $(pwd):/out alpine cp /backups/de_invoice-2026-06-28-030001.sql.gz /out/

# 2. Pipe it into the postgres container
gunzip -c de_invoice-2026-06-28-030001.sql.gz \
  | docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice

# 3. Restart backend + frontend
docker compose -f infra/prod/docker-compose.yml up -d backend frontend
```

### Manual backup (one-off)

```bash
bash infra/prod/backup.sh /tmp
# → /tmp/de_invoice-2026-06-28-143022.sql.gz
```

## Disaster recovery

If the VPS dies entirely:

1. Provision a new VPS with the same OS.
2. Install Docker + nginx + certbot.
3. `rsync` `/opt/de-invoice` from a recent backup (or re-clone the repo).
4. Restore the `backups` named volume from offsite (rsync job above).
5. Restore the `storage` named volume from offsite (PDFs / attachments).
6. Restore postgres from the most recent `.sql.gz` (see "Restore from backup").
7. `docker compose up -d`.
8. Verify with `curl https://rechnung.shleder.de/api/v1/health`.

RPO: ~24h (one missed backup = one day of data loss).
RTO: ~1h (from "VPS alive" to "stack serving traffic").

## Monitoring

### Built-in

- Docker healthchecks on every service (compose restarts failed containers).
- Backend `/api/v1/health` returns 200 if Nest is up, 503 if any critical dependency is down.

### Recommended add-ons (not included)

- **Uptime monitoring**: Healthchecks.io or UptimeRobot pinging
  `/api/v1/health` every 5 minutes.
- **Backup monitoring**: the backup container pings Healthchecks.io
  after each successful run (set `HEALTHCHECK_URL` in .env).
- **Log aggregation**: promtail → Loki or vector → ELK. Out of scope
  for Tier 17; the `infra/prometheus/scrape.yml` already has scrape
  configs if you want to add a metrics endpoint to the backend later.
- **Disk usage alerts**: `df -h /var/lib/docker/volumes/` and alert at 80%.

## Security

- All traffic is HTTPS; HTTP redirects to HTTPS.
- `Strict-Transport-Security` is set to 6 months. Once you've confirmed
  HTTPS works reliably, raise it to 1 year and add `preload` to submit
  to the browser preload list.
- `/api/v1/auth/login` is rate-limited to 10 req/min per IP at the
  nginx level (defense in depth — the backend also has `@Throttle(5, 60)`).
- All containers run as root inside the container, but Docker isolation
  (separate PID/net/mount namespaces) is the security boundary —
  not "non-root inside the container". See `backend/Dockerfile` for
  the long-form reasoning.
- Webhook payloads are HMAC-SHA256 signed. The signing secret is
  shown once at webhook creation time; the backend stores only the hash.
- VIES rate limiting prevents accidentally hammering the EU's free API.

### Secrets rotation

- `JWT_SECRET` — rotate via `openssl rand -hex 32`, update `.env`,
  `docker compose up -d backend`. All users get logged out (cookies invalidated).
- `POSTGRES_PASSWORD` — rotate manually: `ALTER USER de_invoice
  PASSWORD 'new'` in psql, then update `.env` and `docker compose up -d
  backend`. No data loss.
- Let's Encrypt — auto-renews every 60 days via certbot systemd timer.

## What's NOT in this tier

- **Cluster / multi-host deployment** (k8s, Docker Swarm). SH Leder
  is ~5 users; single-host with offsite backup is enough.
- **Auto-scaling**. Not needed at this scale.
- **Blue-green deploys**. The 30s downtime on backend restart is
  acceptable for one user.
- **CDN** (Cloudflare in front of nginx). Optional. Cloudflare in
  proxy mode will require updating the rate-limit zone (CF IPs count
  as one IP at nginx's perspective).

## Observability (Tier 18, opt-in)

The metrics endpoint (`/metrics`), liveness (`/api/v1/health`), and
readiness (`/api/v1/health/deep`) are exposed through nginx to the
public internet so external monitoring can reach them. Tier 18 adds
the rest of the stack as a Docker Compose overlay:

```bash
cd /opt/de-invoice/infra/prod
docker compose -f docker-compose.yml \
               -f docker-compose.observability.yml \
               up -d
```

This adds five services:

| Service       | Host port | What it does                              |
|---------------|-----------|-------------------------------------------|
| prometheus    | 9090      | Scrapes `/metrics` every 15s              |
| grafana       | 3001      | Dashboards (admin / `${GRAFANA_ADMIN_PASSWORD}`) |
| loki          | 127.0.0.1:3100 | Log aggregation (single-instance)   |
| promtail      | —         | Reads Docker logs, ships to Loki          |
| cadvisor      | 127.0.0.1:8080 | Container-level CPU / RAM / network |

Total RAM overhead: ~1.4 GB. On a 4 GB VPS, that's significant — only
enable if you have RAM headroom.

### Grafana

Open `http://<vps>:3001`. Default login is `admin` / the value of
`GRAFANA_ADMIN_PASSWORD` in `.env`. The "de-invoice" dashboard is
auto-loaded and shows:

- Service status (DB connected, storage writable, uptime)
- Request rate by route (top 10 routes)
- Error rate (5xx % over time)
- p50 / p95 / p99 latency by route
- Memory (RSS + heap)
- Recent errors from Loki (one-click jump from a metric spike to
  matching log lines)

### Alerting

Five rules ship in `infra/observability/prometheus/alerts.yml`:

| Alert                       | Severity | Fires when                                     |
|-----------------------------|----------|------------------------------------------------|
| DeInvoiceDown               | critical | `/metrics` unreachable for 2 min               |
| DeInvoiceDbDown             | critical | `SELECT 1` fails for 1 min                     |
| DeInvoiceStorageNotWritable | critical | storage dir not writable for 5 min             |
| DeInvoiceErrorRateHigh      | warning  | 5xx rate > 5% for 5 min                        |
| DeInvoiceHighMemory         | warning  | RSS > 900 MB for 5 min                         |
| DeInvoiceSlowResponses      | warning  | p95 > 1s for 10 min (excludes journal PDF)     |

Rules are evaluated but **not delivered** until you wire up
Alertmanager (see `infra/observability/prometheus/prometheus.yml`
for uncomment instructions). Without Alertmanager, alerts show in
the Prometheus UI but no email/Slack fires.

### Logs

Promtail reads `/var/lib/docker/containers/<id>/*.log` from the host
and ships them to Loki with the labels:

- `service`: from the container's `de-invoice.service` label
- `container`: container name (`de-invoice-backend`, etc.)
- `stream`: `stdout` or `stderr`
- `level`: parsed from nest's standard log format

Query logs in Grafana → Explore → Loki → e.g.
`{service="de-invoice-backend"} |= "ERROR"`.

Retention: 30 days (same as pg_dump backups).

## Tier history

- Tier 11: Initial Dockerfiles (backend + frontend).
- Tier 17: Production stack with nginx, postgres, backup.
- Tier 18: Observability overlay (Prometheus + Grafana + Loki + Promtail + cAdvisor).