# RUNBOOK — de-invoice production operations

> Tier 11. This document is the operator's
> reference for keeping de-invoice running
> in production. DEPLOY.md covers the
> initial setup; this covers what to do
> after it's running.

---

## 1. Health checks

The backend exposes two endpoints:

```
GET /api/v1/health         # liveness (no DB)
GET /api/v1/health/deep    # readiness (DB + storage ping)
```

The docker-compose.prod.yml healthcheck
uses `/health` (cheap, no DB hit). A
load-balancer readiness probe should use
`/health/deep` so traffic is only routed
to a replica whose database is reachable.

`/health/deep` returns:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptimeSec": 153,
  "checks": {
    "db":      { "status": "ok", "detail": "12ms" },
    "storage": { "status": "ok", "detail": "/data/invoice-system" }
  }
}
```

If `status: "fail"`, look at the
`checks` object — only the failing
component is named. Returns HTTP 503
on failure so a load balancer can
detect it via status code (no body
parse needed).

---

## 2. Logs

```bash
# Live tail of all services
docker compose -f docker-compose.prod.yml logs -f

# Just the backend
docker compose -f docker-compose.prod.yml logs -f backend

# Last 200 lines, no follow
docker compose -f docker-compose.prod.yml logs --tail=200 backend
```

Backend log lines are JSON-ish (Nest's
default logger). The startup banner shows
every mapped route — useful for diffing
across versions to spot accidentally
removed endpoints.

To rotate, set `LOG_MAX_SIZE=10m` in the
`backend` service (compose supports
`logging.driver.options`).

---

## 3. Common operations

### 3.1 Restart a single service

```bash
# Restart only the backend (zero-downtime
# if you have multiple replicas)
docker compose -f docker-compose.prod.yml restart backend

# Or rebuild + restart (after a code change)
docker compose -f docker-compose.prod.yml up -d --build backend
```

### 3.2 Read a row directly from Postgres

```bash
docker exec -it de-invoice-postgres psql -U de_invoice -d de_invoice
```

### 3.3 Open a shell in the backend container

```bash
docker exec -it de-invoice-backend sh
# You can run `npx prisma studio` from here
# to browse the data, but it'll bind to
# 0.0.0.0 inside the container — port-map
# it back to the host first:
#   docker exec -it -p 5555:5555 de-invoice-backend npx prisma studio
```

### 3.4 Force a backup

```bash
# On the host (where backup.sh has access
# to the postgres volume via the container)
./scripts/backup.sh
ls -lt ~/data/backups/de-invoice/ | head
```

### 3.5 Restore from a backup

See DEPLOY.md §3. The short version:

```bash
./scripts/restore.sh                       # latest
./scripts/restore.sh 2026-06-24            # day
./scripts/restore.sh 2026-06-24-101530     # exact
```

You will be prompted to type `yes`. The
script will:

1. Drop + recreate the DB
2. pg_restore the dump
3. Move the current attachments aside
4. Extract the attachments archive

The current attachments are kept at
`~/data/invoice-system.pre-restore-YYYYMMDD-HHMMSS`
in case the restore is wrong.

### 3.6 Verify a backup works

Quarterly: pick a backup at random, restore
it to a scratch database, log into the
running app, and click around. An untested
backup is the same as no backup.

```bash
# Restore into a separate DB
docker exec de-invoice-postgres psql -U de_invoice -d postgres -c \
  "CREATE DATABASE de_invoice_scratch;"
docker exec -i de-invoice-postgres pg_restore \
  -U de_invoice -d de_invoice_scratch \
  --no-owner --no-privileges --jobs=2 \
  < ~/data/backups/de-invoice/backup-2026-06-23-020000/db.sql.gz

# Then point a test instance at it
DATABASE_URL=...de_invoice_scratch... \
  ./start.sh
```

### 3.7 Rotate the JWT secret

JWT secret is in `backend/.env` as
`JWT_SECRET`. Rotating it invalidates
ALL active sessions — every user has to
log in again. Plan the rotation for a
low-traffic window.

```bash
# Generate a new one
openssl rand -hex 32
# Edit backend/.env, set JWT_SECRET=<new>
docker compose -f docker-compose.prod.yml restart backend
```

### 3.8 Rotate the Postgres password

```bash
# Stop the backend
docker compose -f docker-compose.prod.yml stop backend

# Change the password in Postgres
NEW_PASS=$(openssl rand -hex 16)
docker exec de-invoice-postgres psql -U de_invoice -d postgres -c \
  "ALTER USER de_invoice PASSWORD '$NEW_PASS';"

# Update POSTGRES_PASSWORD in .env, restart
docker compose -f docker-compose.prod.yml up -d
```

---

## 4. Troubleshooting

### "Backend boots but `/health/deep` returns 503 with `db: fail`"

Postgres isn't reachable from the backend
container. Check:

```bash
docker exec de-invoice-backend wget --spider http://postgres:5432 || echo "DNS / network problem"
docker exec de-invoice-postgres pg_isready -U de_invoice
```

If the DNS name fails, the `postgres`
service might be on a different compose
network. Both prod and dev compose files
use the `de-invoice-net` network — confirm
with `docker network inspect de-invoice-net`.

### "Uploads return 500"

The `storage` volume is full or the
backend can't write to it. Check:

```bash
docker exec de-invoice-backend ls -la /data/invoice-system
docker exec de-invoice-backend sh -c 'echo ok > /data/invoice-system/.test && rm /data/invoice-system/.test && echo writable'
```

### "Mails not sending"

The mail service has two modes:
- `SMTP_HOST` set → real delivery, status='sent'
- `SMTP_HOST` empty → no-smtp mode, status='opened', rows still appear in the Email Center

```bash
docker logs de-invoice-backend 2>&1 | grep -i smtp
```

### "Backup failed: pg_dump error"

Check that the postgres container is up
and the user has the right password:

```bash
docker exec de-invoice-postgres pg_dump -U de_invoice -d de_invoice --schema-only
```

If that works, the issue is the host-side
permissions on `BACKUP_ROOT` or
`ATTACHMENT_PATH`.

---

## 5. Capacity planning

| Component | Headroom indicator |
| --- | --- |
| Postgres | `pg_stat_activity` count, WAL lag |
| Storage volume | `df -h` for the host's `data/` mount |
| Backend CPU | `< 50%` sustained on a single core |
| Frontend CPU | typically < 5% (Next.js is mostly I/O) |

A single 2-vCPU / 4GB host comfortably
handles 10 concurrent users with ~10K
invoices/year. Beyond that, scale
horizontally: add backend replicas
(behind a load balancer), point the
frontend at the LB.

---

## 6. Update procedure

```bash
# 1. Pull the new code
git pull origin main

# 2. Rebuild + restart (zero-downtime if
#    you have 2+ backend replicas)
docker compose -f docker-compose.prod.yml up -d --build

# 3. Watch the logs for startup errors
docker compose -f docker-compose.prod.yml logs -f backend | head -100

# 4. Confirm health
curl -sS http://localhost:3001/api/v1/health/deep | jq

# 5. If anything is broken, roll back
docker compose -f docker-compose.prod.yml down
git checkout <previous-sha>
docker compose -f docker-compose.prod.yml up -d --build
```

A pre-upgrade backup is always a good
idea:

```bash
./scripts/backup.sh
```