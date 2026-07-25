# DEPLOY — de-invoice production deployment

> Tier 14. This document assumes the dev setup already
> works (`./start.sh` brings up Postgres + backend + frontend
> on a Mac). Production is the same shape, with the
> differences below.

---

## 1. Architecture

```
                ┌─────────────────┐
                │   Cloudflare /  │
                │   reverse proxy │
                │   (TLS + WAF)   │
                └────────┬────────┘
                         │
            ┌────────────┴────────────┐
            │                         │
       ┌────▼────┐              ┌─────▼─────┐
       │ Frontend│              │  Backend  │
       │  (Next) │              │  (NestJS) │
       │  :3000  │              │   :3001   │
       └────┬────┘              └─────┬─────┘
            │                        │
            └──────────┬─────────────┘
                       │
                 ┌─────▼─────┐
                 │ PostgreSQL │
                 │   :5432    │
                 └─────┬─────┘
                       │
            ┌──────────┴──────────┐
            │                     │
       ┌────▼─────┐         ┌─────▼────┐
       │ Backups  │         │Receipts  │
       │ ~/data/  │         │  ~/data/ │
       │ backups/ │         │ invoice- │
       │          │         │  system/ │
       └──────────┘         └──────────┘
```

**Two stateful directories that need a backup**:
- `postgres_data` (Docker named volume — the database)
- `~/data/invoice-system/` (the receipts — outside Docker)

---

## 2. First-time setup

### 2.1 Copy + configure env

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
# Fill in production values (DATABASE_URL, JWT_SECRET, SMTP, …)
```

Required env vars (the `docker-compose.prod.yml` fails to start without
these — they're declared as `${VAR:?VAR is required}`):
- `POSTGRES_PASSWORD` — the postgres role password (see 2.2)
- `JWT_SECRET` — the backend JWT signing secret (see below)
- `NEXT_PUBLIC_API_URL` — the **public** URL the browser uses to reach
  the backend (e.g. `https://api.example.com` or `http://localhost:3001`
  in dev). This is baked into the frontend bundle at build time.

Generate the JWT secret:
```bash
openssl rand -hex 32
```

### 2.2 Generate a stronger Postgres password

The `docker-compose.yml` defaults are `de_invoice:de_invoice_pass`
— fine for dev, change in production:
```bash
# Edit docker-compose.yml: POSTGRES_PASSWORD
# Edit backend/.env: DATABASE_URL
docker compose down
docker volume rm de-invoice_postgres_data   # ⚠ wipes the DB
docker compose up -d
```

### 2.3 Run Prisma + seed

```bash
cd backend
npx prisma generate
# In the prod container, prefer `migrate deploy`
# (the canonical migration path) over `db push`
# (which is the dev convenience). Both work, but
# migrate deploy ensures every migration file
# is applied in order — which is what prod expects.
npx prisma migrate deploy
# init.sql adds the generated columns (city_text,
# postal_code_text) and the search_tsv tsvector
# columns + the FTS GIN indexes. These are NOT
# in the Prisma schema (they're raw SQL additions
# for full-text search) so `migrate deploy` won't
# create them. Always re-run init.sql after the
# migrations:
psql -U de_invoice -d de_invoice -f prisma/init.sql
```

### 2.4 First backup

```bash
scripts/backup.sh
# Inspect:
ls -la ~/data/backups/de-invoice/
```

### 2.5 Install the daily cron

```bash
cp scripts/com.de-invoice.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.de-invoice.backup.plist
# Verify it's scheduled:
launchctl list | grep de-invoice
# Check the log:
tail -f /tmp/de-invoice-backup.log
```

---

## 3. Day-to-day operations

### Start / stop

```bash
./start.sh    # dev (Turbopack + ts-node)
./stop.sh     # tear down
```

For production, replace `./start.sh` with `docker compose up -d`
for the backend + frontend built images.

### Read the latest log

```bash
tail -f /tmp/backend.log
tail -f /tmp/next-dev.log
```

### Check the disk usage

```bash
df -h ~/data/
du -sh ~/data/backups/de-invoice/
du -sh ~/data/invoice-system/
```

### Restore from a backup

```bash
# See what's available
ls -lt ~/data/backups/de-invoice/ | head

# Restore the most recent (or pass a timestamp)
scripts/restore.sh                    # latest
scripts/restore.sh 2026-06-16         # day
scripts/restore.sh 2026-06-16-195250 # exact
```

The restore script:
1. Confirms the action (`type 'yes'`)
2. Drops + recreates the de_invoice DB
3. pg_restore's the dump
4. Extracts the receipts over `~/data/invoice-system/`
5. Backs up the *current* attachments dir to
   `~/data/invoice-system.pre-restore-YYYYMMDD-HHMMSS`
   in case the restore is wrong

### Force a backup

```bash
scripts/backup.sh
```

---

## 4. SMTP

The mail service has two modes:
- **SMTP configured** (prod): real delivery, status='sent'
- **SMTP not configured** (dev/CI): logs to /tmp/backend.log,
  status='opened', the row still appears in the Email Center

In production, set in `backend/.env`:
```
SMTP_HOST=smtp.deinprovider.de
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM_NAME="SH Leder GmbH"
SMTP_FROM_EMAIL=rechnung@shleder.de
```

Restart the backend after changing these.

---

## 5. Storage

`StorageService` writes to `~/data/invoice-system/`
(overridable via the storage config endpoint).
For production on a single host, this is fine —
just include it in the backup.

For multi-host or S3, update `StorageService` to push
to S3 / MinIO / Azure Blob. The Tier 12 Attachment
table is storage-agnostic — only the `storagePath`
column changes.

---

## 6. Security checklist

- [ ] `JWT_SECRET` rotated (`openssl rand -hex 32`)
- [ ] Postgres password rotated from `de_invoice_pass`
- [ ] SMTP credentials in env (not committed)
- [ ] Cloudflare / reverse proxy handles TLS
- [ ] `TRUST_PROXY=1` set when behind a load balancer
- [ ] Firewall: only 80/443 public; 3001 only on loopback
- [ ] Backup S3 bucket (optional but recommended) —
      set `BACKUP_S3_BUCKET` in the launchd environment

---

## 7. GoBD compliance notes

The system stores:
- All issued invoices (invoices + invoiceItems) — 10y
- All received bills (expenses) — 10y
- All Vouchers (Buchungsjournal) — 10y
- All attachments (originals) — 10y
- DATEV export — 10y

The backup is the safety net. **Verify quarterly** that
a restore works (e.g. to a scratch DB) — an untested
backup is the same as no backup.

---

## 8. CI/CD

See `.github/workflows/ci.yml`. Every push to `main`
runs:
- backend `tsc --noEmit`
- frontend `tsc --noEmit`
- 19 e2e tests against a fresh PostgreSQL service

Failed runs block merges via branch protection (configure
under Settings → Branches → main → "Require status checks
to pass before merging" → select `e2e`).
