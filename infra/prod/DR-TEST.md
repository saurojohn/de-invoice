# Disaster Recovery test plan — de-invoice

> **Tier 114.** Quarterly DR test. The goal is to confirm
> that the documented RTO (Recovery Time Objective) and
> RPO (Recovery Point Objective) hold in practice, and to
> catch any drift between the runbook and reality.

## Definitions

- **RTO**: how long from "disaster declared" to "app
  serving traffic again". Target for de-invoice: **1 hour**
  (single host, no replica).
- **RPO**: how much data we lose. Target: **24 hours**
  (one daily `pg_dump` run; could be up to 36h if the
  backup ran late and the disaster happened just before the
  next one).

## Schedule

| Quarter | Test | Owner | Due |
|---------|------|-------|-----|
| Q1 | Full restore on fresh Hetzner CX21 | — | — |
| Q2 | Restore in a sidecar DB (no new VPS) | — | — |
| Q3 | Full restore on fresh Hetzner CX21 | — | — |
| Q4 | Restore + write a test invoice + email it | — | — |

The Q1 + Q3 "full restore on fresh Hetzner" exercises the
end-to-end runbook including the Caddy auto-TLS path. The
Q2 + Q4 lighter tests just confirm the backups are
restorable without touching production.

## Test 1 (Q1 / Q3) — Full restore on a fresh VPS

This is the canonical DR test. It exercises everything
that's documented in `HETZNER-DEPLOY.md` and the
`RUNBOOK.md` "Restore from backup" section.

### Pre-test

1. **Choose a target backup**. Pick the most recent
   successful backup. Note its filename:
   `de_invoice-YYYY-MM-DD-HHMMSS.sql.gz`.
2. **Note the current production state**:
   ```bash
   ssh deploy@rechnung.shleder.de
   # Production state at the start of the test.
   docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml ps
   curl -s https://rechnung.shleder.de/api/v1/health | jq
   ```
3. **Spin up a fresh Hetzner CX21** (€4.85 — destroy after
   the test). Name it `de-invoice-dr-test`.

### Test execution

Follow `HETZNER-DEPLOY.md` steps 1-8, with these
differences:

- **Step 1**: use a *different* SSH key for the test VPS,
  or just delete it after — no risk of conflicting with
  production.
- **Step 2**: don't change DNS. Use a temporary
  `/etc/hosts` entry on your workstation:
  `echo "<test VPS IP> dr.rechnung.shleder.de" | sudo tee -a /etc/hosts`.
  This makes the test fully isolated from production.
- **Step 4**: skip the "seed first company" step — the
  backup has the real company. But set `.env` to point at
  the test domain (`FRONTEND_URL=https://dr.rechnung.shleder.de`).
- **Step 5-6**: same as production. Prisma db push will
  build the schema; then the restore (step 7 below)
  overwrites the empty tables with the production data.
- **Step 7 (modified)**: skip `prisma db push`. Instead,
  restore the backup:

  ```bash
  # Copy the backup from off-site (Hetzner Storage Box).
  rclone copy "$BACKUP_RCLONE_REMOTE/backup-YYYY-MM-DD-HHMMSS/db.sql.gz.gpg" \
    /tmp/db.sql.gz.gpg
  # Decrypt + decompress.
  gpg --batch --yes --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
      --decrypt /tmp/db.sql.gz.gpg > /tmp/db.sql.gz
  # Restore into the test postgres.
  gunzip -c /tmp/db.sql.gz \
    | docker exec -i de-invoice-postgres \
        pg_restore --no-owner --no-privileges -d de_invoice
  ```

  If the backup is NOT encrypted (older backups before you
  enabled encryption):
  ```bash
  rclone copy "$BACKUP_RCLONE_REMOTE/backup-YYYY-MM-DD-HHMMSS/db.sql.gz" \
    /tmp/db.sql.gz
  gunzip -c /tmp/db.sql.gz \
    | docker exec -i de-invoice-postgres \
        pg_restore --no-owner --no-privileges -d de_invoice
  ```

- **Step 8**: bring up the stack on the test VPS.
  Caddy will issue a separate Let's Encrypt cert for
  `dr.rechnung.shleder.de` (you'll need a DNS A record
  pointing at the test VPS, OR use the Let's Encrypt
  staging ACME endpoint by switching to `Caddyfile.staging`).

### Smoke test on the DR VPS

Run all 13 checks from `infra/prod/smoke-test.sh` against
the DR VPS:

```bash
DOMAIN=dr.rechnung.shleder.de VPS_IP=<test VPS IP> \
  bash infra/prod/smoke-test.sh
```

Additionally:

- [ ] Login as the admin user with the production password
- [ ] Open a customer record — confirm the data is recent
      (not the seed data from the original `HETZNER-DEPLOY.sh`)
- [ ] Create a test invoice and download its PDF
- [ ] Send the test invoice by email (Tier 15 feature)
- [ ] Confirm the audit log shows the actions you just took
- [ ] Check the restored attachments directory
      (run `ls -la /var/lib/docker/volumes/deinvoicenet_storage/_data/`
      inside the test VPS)

### Record RTO and RPO

| Metric | Target | Actual | Notes |
|--------|--------|--------|-------|
| Time from "test VPS up" to "stack serving" | <60 min | ___ | |
| Time to restore DB from backup | <10 min | ___ | depends on backup size |
| Data loss (most recent backup → now) | <36 h | ___ | |

If the actual RTO is >60 min, the runbook needs updating.
Common causes:
- Forgot to update `FRONTEND_URL` in the test `.env`
- DNS propagation for the test domain (use a real subdomain)
- Missing `BACKUP_ENCRYPTION_PASSPHRASE` (can't decrypt)
- Forgot to mount the storage volume (attachments missing)

### Tear down

```bash
# From the Hetzner Cloud Console:
#   - Delete the test CX21
#   - Delete the test volume (if you created one)
#   - Revoke the test SSH key (if it was a fresh one)
```

Remove the `/etc/hosts` entry on your workstation.

### Report

Write a short report (1 page max) and commit it to
`docs/dr-tests/2026-Q1.md`. Include:
- Date of the test
- The backup file used
- Actual RTO / RPO
- Any issues found (with the fix)
- Next test date

## Test 2 (Q2 / Q4) — Restore in a sidecar DB

This is faster (no new VPS) and exercises just the
restore-from-backup part of the runbook.

```bash
# 1. Pull the most recent backup from off-site.
rclone copy "$BACKUP_RCLONE_REMOTE/$(ls -1t | head -1)/" /tmp/dr-test/

# 2. Decrypt + decompress.
gpg --batch --yes --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
    --decrypt /tmp/dr-test/db.sql.gz.gpg > /tmp/dr-test/db.sql.gz

# 3. Spin up a temporary postgres.
docker run -d --name dr-test-postgres \
  -e POSTGRES_USER=de_invoice \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=de_invoice \
  postgres:16-alpine

# 4. Restore.
gunzip -c /tmp/dr-test/db.sql.gz \
  | docker exec -i dr-test-postgres \
      pg_restore --no-owner --no-privileges -d de_invoice

# 5. Verify.
docker exec dr-test-postgres psql -U de_invoice -d de_invoice \
  -c "SELECT COUNT(*) FROM \"Invoice\";"
# Should match the production count (modulo the last
# 24h of activity).

# 6. Tear down.
docker rm -f dr-test-postgres
rm -rf /tmp/dr-test
```

Record the RTO (which here is "time to pull + restore the
backup" — should be <10 min for a 1 GB backup on a 4 GB
VPS).

## What to do if a real DR happens

1. Declare the disaster (VPS unreachable for >15 min,
   data corruption confirmed, etc.).
2. Estimate the data loss:
   ```bash
   # From the off-site storage (Hetzner Storage Box / S3):
   rclone lsf "$BACKUP_RCLONE_REMOTE" --dirs-only
   # Pick the most recent directory.
   ```
3. Provision a fresh Hetzner CX21.
4. Follow `HETZNER-DEPLOY.md` steps 1-7, but skip `prisma
   db push` in step 6 — instead, restore the most recent
   backup (same as Test 1 above).
5. Update DNS to point at the new VPS's IP.
6. Verify with `smoke-test.sh`.
7. Notify users that the app is back. The downtime clock
   stops here — that's your RTO.
8. File a post-mortem: what failed, why, how do you
   prevent it next time (or detect it earlier).

## Document the actual RTO/RPO

| Date | Disaster type | RTO | RPO | Notes |
|------|---------------|-----|-----|-------|
| 2026-Q1 | Scheduled DR test | ___ | ___ | Test 1, see report |
| 2026-Q2 | Scheduled DR test | ___ | ___ | Test 2, see report |
| 2026-Q3 | Scheduled DR test | ___ | ___ | Test 1, see report |
| 2026-Q4 | Scheduled DR test | ___ | ___ | Test 2, see report |

If a real disaster happens, add a row with the date,
RTO, RPO, and a 1-paragraph description.

## Failure modes I've seen

Things that look fine in the runbook but break in practice:

- **Wrong `BACKUP_RCLONE_REMOTE`** — the rclone remote name
  has a typo, or the credentials file has been overwritten.
  Test by doing a `rclone ls $BACKUP_RCLONE_REMOTE` at the
  start of every DR test.
- **`.env` drift** — the test `.env` is generated from
  `.env.example` and is missing the BACKUP_ENCRYPTION_PASSPHRASE.
  Either copy the production `.env` (minus POSTGRES_PASSWORD)
  or set the passphrase explicitly in the test environment.
- **Old backup with old schema** — restoring a 6-month-old
  backup into a fresh stack with the current Prisma migrations
  fails on schema mismatch. The fix is `npx prisma migrate
  deploy` AFTER `pg_restore`, not before. (Prisma is good
  about this — it skips migrations that are already applied.
  But custom SQL migrations that don't have a Prisma
  migration file can confuse things. Run `prisma migrate
  status` to check.)
- **DNS cache on the test workstation** — the `/etc/hosts`
  entry is ignored if your browser has cached the
  production IP. Restart the browser, or use `curl --resolve
  dr.rechnung.shleder.de:443:<test IP>`.
- **Caddy rate-limit blocked the test** — if you hammer
  the test domain with smoke tests, Caddy's `rate_limit`
  on `/api/v1/auth/*` will trigger. The test should still
  pass because only 13 requests are made, but if you run
  the smoke test repeatedly in a loop, you'll hit the
  limit. Either wait a minute, or temporarily raise the
  rate limit in the test Caddyfile.
