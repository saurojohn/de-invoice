# de-invoice — Production Deployment (Tier 114)

Single-host Docker Compose deployment for SH Leder GmbH's invoice web app.

> **What's new in Tier 114** — this tier replaces the host-installed
> **nginx + certbot** stack with a **Caddy** container, ships a
> complete Hetzner Cloud (and DigitalOcean) deploy runbook, an
> upgraded backup script with encryption + rclone, a Prometheus
> + Grafana monitoring overlay, and a security + DR-test checklist.
> **New deployments use Caddy out of the box**; existing Tier 17
> installs migrate via [`MIGRATION-nginx-to-caddy.md`](MIGRATION-nginx-to-caddy.md).
>
> **Quick links**:
> - Deploy: [`HETZNER-DEPLOY.md`](HETZNER-DEPLOY.md) · [`DIGITALOCEAN-DEPLOY.md`](DIGITALOCEAN-DEPLOY.md)
> - Runbook: [`RUNBOOK.md`](RUNBOOK.md)
> - Security: [`SECURITY.md`](SECURITY.md)
> - DR test: [`DR-TEST.md`](DR-TEST.md)
> - nginx → Caddy: [`MIGRATION-nginx-to-caddy.md`](MIGRATION-nginx-to-caddy.md)
> - Monitoring overlay: [`monitoring.yml`](monitoring.yml) · [Prometheus config](prometheus/) · [Grafana dashboards](grafana/)
> - Legacy nginx config: [`nginx.conf`](nginx.conf) (kept for history; no longer used)

## Architecture

```
                  Internet
                     │
                     ▼
              ┌─────────────┐
              │ Cloudflare  │   ← OPTIONAL (Tier 19)
              │   (proxy)   │      DNS orange-cloud + CF-Connecting-IP
              └──────┬──────┘
                     │
                     ▼
              ┌─────────────┐
              │   Caddy     │   ← TLS termination (auto-LE, Tier 114)
              │  (container)│      rate limit on /api/v1/auth
              └──────┬──────┘      security headers
                     │             CF real-IP restore (if CF enabled)
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

Six long-running services (was five before Tier 114):

| Service    | Image                              | Port (host)        | Restart policy   |
|------------|------------------------------------|--------------------|------------------|
| postgres   | `postgres:16-alpine`               | —                  | unless-stopped   |
| backend    | `de-invoice-backend:latest` (local)| —                  | unless-stopped   |
| frontend   | `de-invoice-frontend:latest` (local)| —                 | unless-stopped   |
| backup     | `prodrigestivill/postgres-backup-local` | —            | unless-stopped   |
| caddy      | `caddy:2-alpine`                   | 80, 443            | unless-stopped   |
| ~~nginx~~  | _removed in Tier 114_              | _—_                | _—_              |

The `monitoring.yml` overlay (opt-in) adds `prometheus` + `grafana`
+ `node_exporter` + `postgres_exporter` — all bound to 127.0.0.1
on the host. Reach them via SSH tunnel.

All app services share the `deinvoicenet` Docker bridge network so they can
talk to each other by hostname (`postgres`, `backend`, `frontend`,
`caddy`).

**Why Caddy is in a container (Tier 114 change):**
Caddy stores its issued certs + the ACME account in a data dir that maps
cleanly to a named Docker volume. The Caddyfile is bind-mounted as a
read-only config file — no host-side `apt install caddy`, no
`/etc/caddy/Caddyfile` drift. `docker compose up -d` brings up the
entire stack (proxy included) in one command.

## Prerequisites

- Linux VPS (Debian 12 / Ubuntu 24.04 LTS recommended) with at least 2 vCPU and 4 GB RAM.
- Docker Engine 24+ and Docker Compose v2 (`docker compose version` ≥ 2.20).
- A registered domain with DNS A records pointing at the VPS:
  - `rechnung.shleder.de` → VPS public IPv4
  - (optional) `*.rechnung.shleder.de` for staging
- Outbound HTTPS (port 443) for Let's Encrypt ACME validation.
- Ports 80 and 443 open on the VPS firewall.

## One-time setup

> Tier 114 streamlined this from 5 manual steps to 1.
> Follow [`HETZNER-DEPLOY.md`](HETZNER-DEPLOY.md) for the full
> end-to-end walkthrough (Hetzner + DigitalOcean both work). The
> short version is below.

### 1. Nothing to install — Caddy ships in the compose stack

Tier 17 required `apt install -y nginx certbot python3-certbot-nginx`
on the host, plus a manual `certbot --nginx` dance, plus a re-apply
of the nginx config because certbot adds lines you don't want.
**Tier 114 drops all of that.** The `caddy` service in
`infra/prod/docker-compose.yml` handles TLS + ACME + auto-renewal.
UFW still needs 80 + 443 open (the `deploy-prep.sh` script does this).

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
chmod 600 .env
$EDITOR .env
```

Generate strong secrets:

```bash
# Postgres password
openssl rand -base64 32

# JWT secret (used for session tokens)
openssl rand -hex 64

# FinTS PIN encryption key (real-mode bank connections)
openssl rand -hex 32
```

Paste them into `.env`. Save and exit.

### 4. (No step 4 — no nginx config to install)

### 5. (No step 5 — Caddy auto-issues the LE cert on first request)

The first time a request hits `https://rechnung.shleder.de`, Caddy
runs the ACME HTTP-01 challenge on port 80, gets the cert from
Let's Encrypt, installs it, and serves the page. Total time from
first request to "site loads": usually <10s.

If you want to test against Let's Encrypt's STAGING endpoint
(issues untrusted test certs) first, see
[`Caddyfile.staging`](Caddyfile.staging).

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
- Caddy logs every request to stdout (visible in `docker compose logs caddy`).

### Recommended add-ons

- **External uptime monitoring**: Healthchecks.io or UptimeRobot pinging
  `/api/v1/health` every 5 minutes. See [`RUNBOOK.md` §1](RUNBOOK.md#1-health-checks).
- **Prometheus + Grafana**: enable the
  [`monitoring.yml`](monitoring.yml) overlay (Tier 114 recommended) or the
  older [`docker-compose.observability.yml`](docker-compose.observability.yml)
  (Tier 18 — adds Loki + Promtail on top). Both ship pre-built dashboards.
- **Backup monitoring**: the backup container pings Healthchecks.io
  after each successful run (set `HEALTHCHECK_URL` in .env). For richer
  alerting, use the upgraded `scripts/backup-prod.sh` (Tier 114) which
  also posts to a Slack/Discord webhook.
- **Disk usage alerts**: the `DeInvoiceDiskSpaceLow` alert in
  `prometheus/alerts.yml` fires at 85% full. The monitoring overlay
  needs to be enabled for the alert to actually deliver.

The full security checklist lives in [`SECURITY.md`](SECURITY.md).

## Security

> Full checklist in [`SECURITY.md`](SECURITY.md). Summary:
>
> - All traffic is HTTPS; HTTP redirects to HTTPS.
> - `Strict-Transport-Security` is set to **1 year** + `includeSubDomains`
>   + `preload` (Caddyfile). After a month of reliable HTTPS, submit to
>   https://hstspreload.org/.
> - `/api/v1/auth/*` is rate-limited to 10 req/min per IP at the
>   Caddy level (defense in depth — the backend also has `@Throttle(5, 60)`).
> - All containers run as root inside the container, but Docker isolation
>   (separate PID/net/mount namespaces) is the security boundary —
>   not "non-root inside the container". See `backend/Dockerfile` for
>   the long-form reasoning.
> - Webhook payloads are HMAC-SHA256 signed. The signing secret is
>   shown once at webhook creation time; the backend stores only the hash.
> - VIES rate limiting prevents accidentally hammering the EU's free API.

### Secrets rotation

> Full procedures in [`RUNBOOK.md` §3](RUNBOOK.md#3-common-operations).
> TL;DR:
>
> - `JWT_SECRET` — rotate via `openssl rand -hex 64`, update `.env`,
>   `docker compose up -d backend`. All users get logged out (cookies invalidated).
> - `POSTGRES_PASSWORD` — rotate manually: `ALTER USER de_invoice
>   PASSWORD 'new'` in psql, then update `.env` and `docker compose up -d
>   backend`. No data loss.
> - `FINTS_PIN_ENC_KEY` — DO NOT rotate. Losing it means every bank
>   connection must be re-created (real-mode FinTS only).
> - Let's Encrypt — auto-renews ~30 days before expiry via Caddy.
>   No action needed. Verify with `curl -vI https://rechnung.shleder.de | grep expire`.

## What's NOT in this tier

- **Cluster / multi-host deployment** (k8s, Docker Swarm). SH Leder
  is ~5 users; single-host with offsite backup is enough.
- **Auto-scaling**. Not needed at this scale.
- **Blue-green deploys**. The 30s downtime on backend restart is
  acceptable for one user.
- **Log aggregation** (Loki / ELK / Datadog). The
  `docker-compose.observability.yml` overlay (Tier 18) adds
  Loki + Promtail; enable it if you need it. Tier 114's
  `monitoring.yml` is metrics-only.
- **WAF** (Web Application Firewall). Cloudflare's free tier +
  Caddy's rate limit cover the common cases. If you ever get
  targeted traffic, add a WAF.

## Cloudflare mode (optional, Tier 19)

For production deployments behind Cloudflare (recommended — your
origin IP stays hidden, you get free DDoS protection + bot
filtering), see `infra/cloudflare/README.md` for the full setup.

**TL;DR**: enable the orange-cloud toggle in CF DNS, set SSL mode
to **Full (Strict)**, then uncomment the `trusted_proxies` +
`client_ip_headers` block at the bottom of [`Caddyfile`](Caddyfile)
(it's commented out by default since dev deployments don't need it).

The CF real-IP restore means:
- `{remote_host}` in Caddy = visitor's real IP (not CF edge IP)
- Caddy's `rate_limit` on `/api/v1/auth` works correctly
- Caddy access log records visitor IPs
- backend `req.ip` (via `trust proxy: 'loopback'`) = visitor IP

Without this, every CF-fronted visitor shares one CF edge IP
in the rate-limit zone, which makes the limit meaningless.

Run `bash infra/cloudflare/test-real-ip.sh` to verify (9 assertions,
runs in ~10s, self-contained Docker test).

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

This adds six services:

| Service       | Host port | What it does                              |
|---------------|-----------|-------------------------------------------|
| prometheus    | 9090      | Scrapes `/metrics` every 15s              |
| alertmanager  | 127.0.0.1:9093 | Receives fired alerts, dispatches to Slack + email (Tier 23) |
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

Rules are evaluated and **delivered** through Alertmanager (Tier 23).
Configuration lives in
`infra/observability/alertmanager/alertmanager.yml`:

- **Critical** alerts (`DeInvoiceDown`, `DeInvoiceDbDown`,
  `DeInvoiceStorageNotWritable`, `DeadMansSwitch`) → `#ops-alerts`
  Slack channel + email, repeated every hour until resolved.
- **Warning** alerts (`DeInvoiceErrorRateHigh`,
  `DeInvoiceHighMemory`, `DeInvoiceSlowResponses`) →
  `#ops-warning` Slack channel, once a day.
- **DeadMansSwitch** fires every 6 hours as a heartbeat. If
  you STOP receiving it, the entire alerting chain is
  broken — check Prometheus `/-/ready` and Alertmanager
  `/-/healthy` on `127.0.0.1:9093`.

To configure receivers, set in `infra/prod/.env`:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...
SLACK_CHANNEL_CRITICAL=#ops-alerts
SLACK_CHANNEL_WARNING=#ops-warning
SLACK_ONCALL_HANDLE=@oncall
SMTP_SMARTHOST=smtp.your-provider.com:587
SMTP_FROM=alertmanager@your-domain.com
SMTP_AUTH_USERNAME=alertmanager@your-domain.com
SMTP_AUTH_PASSWORD=...    # app-specific password
OPS_EMAIL=ops@your-domain.com
```

Without these set, Alertmanager starts and Prometheus fires
alerts into it, but the receivers fail to deliver (visible
in the Alertmanager UI at `127.0.0.1:9093/alerts`).

The `DeInvoiceDown` alert inhibits the downstream
`DeInvoiceDbDown` / `DeInvoiceErrorRateHigh` /
`DeInvoiceStorageNotWritable` / `DeInvoiceHighMemory` /
`DeInvoiceSlowResponses` alerts — when the backend is down,
the others are symptoms, not independent issues.

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
- Tier 19: Cloudflare real-IP restore + auto-refresh + backend trust-proxy hardening.
- Tier 24: `deploy-prep.sh` host-hardening script + rollback + smoke-test scripts.
- **Tier 114**: nginx → **Caddy** migration (auto-TLS, in-container). New
  deploy runbooks ([`HETZNER-DEPLOY.md`](HETZNER-DEPLOY.md),
  [`DIGITALOCEAN-DEPLOY.md`](DIGITALOCEAN-DEPLOY.md),
  [`MIGRATION-nginx-to-caddy.md`](MIGRATION-nginx-to-caddy.md)).
  Upgraded `scripts/backup-prod.sh` with rclone + gpg + webhook +
  restore-test. New [`monitoring.yml`](monitoring.yml) overlay
  (Prometheus + Grafana + node_exporter + postgres_exporter).
  [`RUNBOOK.md`](RUNBOOK.md) for day-to-day ops.
  [`SECURITY.md`](SECURITY.md) checklist. [`DR-TEST.md`](DR-TEST.md)
  quarterly DR plan.