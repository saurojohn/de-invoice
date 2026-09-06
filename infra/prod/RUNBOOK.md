# RUNBOOK — de-invoice production operations

> **Tier 114.** Operator's day-to-day reference for the
> de-invoice stack on Hetzner Cloud (or any other VPS).
> The deploy runbook is in `HETZNER-DEPLOY.md` /
> `DIGITALOCEAN-DEPLOY.md`; this file covers what to do
> once the stack is running.

## Quick links

- Deploy: [`HETZNER-DEPLOY.md`](HETZNER-DEPLOY.md)
- DO deploy: [`DIGITALOCEAN-DEPLOY.md`](DIGITALOCEAN-DEPLOY.md)
- nginx → Caddy migration: [`MIGRATION-nginx-to-caddy.md`](MIGRATION-nginx-to-caddy.md)
- Security: [`SECURITY.md`](SECURITY.md)
- DR test: [`DR-TEST.md`](DR-TEST.md)
- Architecture & rationale: [`README.md`](README.md)

---

## 1. Health checks

### From the host (SSH in)

```bash
cd /opt/de-invoice/infra/prod

# Container-level.
docker compose ps

# App-level.
curl -s http://localhost:3001/api/v1/health | jq
# Expect: { "status": "ok", "uptime": ..., "version": "..." }

# Deep health — also checks the DB and storage.
curl -s http://localhost:3001/api/v1/health/deep | jq
# Expect: { "status": "ok",
#           "database": { "status": "ok" },
#           "storage": { "status": "ok" } }
```

### From anywhere (HTTPS through Caddy)

```bash
curl -s https://invoice.shleder.de/api/v1/health | jq
curl -s https://invoice.shleder.de/api/v1/health/deep | jq
```

The `health/deep` endpoint hits the DB and the storage
volume. If it returns 200, the app is functionally
complete. If it returns 503, the response body tells you
which dependency is broken.

### Wire it into an external monitor

Configure **Healthchecks.io** (recommended, free tier) or
**UptimeRobot** to ping `https://invoice.shleder.de/api/v1/health`
every 5 minutes. Alert via email / Slack / SMS when it
fails twice in a row (avoid alerting on a single blip).

The reason to use an external monitor (vs just checking
the host): the external monitor can detect "the VPS is up
but the app is wedged" AND "the VPS is down entirely".

---

## 2. Logs

### Live tail

```bash
cd /opt/de-invoice/infra/prod
docker compose logs -f --tail=100              # all services
docker compose logs -f backend                 # one service
docker compose logs -f caddy                   # reverse proxy
docker compose logs -f postgres                # database
```

### Recent errors only

```bash
# Backend errors in the last hour.
docker compose logs --since 1h backend 2>&1 \
  | grep -iE 'error|exception|ECONNREFUSED' | head -50
```

### Persisted logs (if you enabled the observability overlay)

```bash
# Grafana → Explore → Loki.
# Query: {service="de-invoice-backend"} |= "ERROR"
# Or: {service="de-invoice-caddy"} | json | status >= 500
```

Logs in Loki have a 30-day retention by default.

---

## 3. Common operations

### Deploy a new version

```bash
ssh deploy@invoice.shleder.de
cd /opt/de-invoice
git pull                                    # pull latest
docker compose -f infra/prod/docker-compose.yml build backend frontend
docker compose -f infra/prod/docker-compose.yml up -d backend frontend
# Postgres + Caddy are NOT touched by an app update.
```

If the new version includes a Prisma migration, also run:

```bash
docker compose -f infra/prod/docker-compose.yml exec backend \
  npx prisma migrate deploy
```

### After the deploy: run smoke-test.sh

The Tier 304-307 hardening arc (2026-09-05) added
4 production-bug-fix verifications to the
existing smoke-test.sh. After every deploy, the
operator should run:

```bash
DOMAIN=rechnung.shleder.de VPS_IP=<VPS_IP> \
  bash infra/prod/smoke-test.sh
```

This now runs **17 checks total** (13 original
+ 4 Tier 304-307 verifications):

- 14. Portal 401 auto-logout hijack fix (Tier 304)
- 15. Invoice schema drift fix (Tier 304 followup)
- 16. Audit log create wrap (Tier 304 followup)
- 17. Audit page mobile layout (Tier 307)

If any check fails, the deploy image is from
before the fixes — `git pull` again (the new
commits should be there), rebuild, redeploy,
or `deploy.sh --rollback` to the previous image.
Full details in `DEPLOY-READY-SUMMARY.md`.

```bash
docker compose -f infra/prod/docker-compose.yml exec backend \
  npx prisma migrate deploy
```

Then verify:

```bash
curl -s https://invoice.shleder.de/api/v1/health | jq
```

### Roll back

Code-only rollback (no schema change in the new version):

```bash
cd /opt/de-invoice
git log --oneline -5                          # find the previous commit
git checkout <previous-commit>
docker compose -f infra/prod/docker-compose.yml build backend frontend
docker compose -f infra/prod/docker-compose.yml up -d backend frontend
```

Full rollback (code + schema): see `DR-TEST.md` §"Restore
from backup".

There's also an automated `rollback.sh` script in this
directory that handles the code-only case end-to-end (with
audit trail + health check).

### Add a new admin user

The app has no public "register" flow that creates a new
company (admin invites only). Two options:

1. **Via the existing admin's UI**: Settings → Users →
   Invite. The new user gets an emailed link.
2. **Via direct SQL** (recovery scenario — admin locked out):

   ```bash
   docker compose -f infra/prod/docker-compose.yml exec postgres \
     psql -U de_invoice -d de_invoice -c "
       INSERT INTO \"User\" (id, email, name, \"passwordHash\",
                             role, \"companyId\", \"createdAt\", \"updatedAt\")
       VALUES (
         gen_random_uuid(),
         'new-admin@shleder.de',
         'New Admin',
         -- bcrypt hash of the new password; generate with:
         --   node -e 'console.log(require(\"bcrypt\").hashSync(\"the-password\", 12))'
         '\$2b\$12\$...',
         'ADMIN',
         '00000000-0000-0000-0000-000000000001',
         NOW(), NOW()
       );
     "
   ```

### Rotate `JWT_SECRET`

```bash
# Generate a new one.
NEW=$(openssl rand -hex 64)

# Edit .env.
$EDITOR /opt/de-invoice/infra/prod/.env
# Replace JWT_SECRET=<old> with JWT_SECRET=$NEW

# Restart the backend (and only the backend — postgres
# doesn't care, frontend re-fetches on next login).
cd /opt/de-invoice/infra/prod
docker compose up -d backend
```

**All users get logged out.** Cookies are signed with the
old secret and become invalid. Plan for a brief "everyone
has to log in again" window. To minimise disruption, do
this during off-hours.

### Rotate `POSTGRES_PASSWORD`

```bash
# Generate a new one.
NEW=$(openssl rand -base64 32)

# Update inside postgres.
docker compose -f infra/prod/docker-compose.yml exec postgres \
  psql -U de_invoice -d de_invoice \
  -c "ALTER USER de_invoice PASSWORD '$NEW';"

# Update .env + restart the backend.
$EDITOR /opt/de-invoice/infra/prod/.env
# Replace POSTGRES_PASSWORD=<old> with POSTGRES_PASSWORD=$NEW
cd /opt/de-invoice/infra/prod
docker compose up -d backend
```

No data loss. Existing connections are dropped (the
backend reconnects with the new password).

### Restart a single service

```bash
docker compose -f infra/prod/docker-compose.yml restart backend
# After a backend restart, /api/v1/health shows "unhealthy"
# for ~20s while Nest re-initialises (DB pool, modules, audit
# log, retry worker). This is normal.
```

### View database directly

```bash
docker compose -f infra/prod/docker-compose.yml exec postgres \
  psql -U de_invoice -d de_invoice

# Inside psql:
\dt                    # list tables
\d+ "Invoice"          # describe Invoice table
\x                     # expanded display (one field per line)
SELECT COUNT(*) FROM "Invoice";
```

### View a user's audit log

```bash
docker compose -f infra/prod/docker-compose.yml exec postgres \
  psql -U de_invoice -d de_invoice -c "
    SELECT \"createdAt\", action, \"entityType\", \"entityId\"
    FROM \"AuditLog\"
    WHERE \"userId\" = '<user-uuid>'
    ORDER BY \"createdAt\" DESC
    LIMIT 50;
  "
```

---

## 4. Backups

### Confirm a backup ran

```bash
# List backups in the named volume.
docker run --rm -v deinvoicenet_backups:/backups alpine \
  ls -lh /backups

# Most recent should be <26h old.
```

### Restore from backup

The backup script writes one file per run:
`de_invoice-YYYY-MM-DDTHHMMSS.sql.gz`.

```bash
cd /opt/de-invoice/infra/prod

# 1. Stop the backend so it doesn't write to the DB
#    during the restore.
docker compose stop backend frontend

# 2. Find the backup you want.
ls -lh /var/lib/docker/volumes/deinvoicenet_backups/_data/

# 3. Restore. db.sql.gz is pg_dump custom format
#    (NOT plain SQL — gunzip -c alone will refuse).
#    Use pg_restore from a sibling postgres image with
#    the backup volume mounted read-only. The postgres
#    container is on the deinvoicenet network so we can
#    reach it via host.docker.internal. Tier 220
#    confirmed the path end-to-end (1.4s restore on
#    887 KB SQL dump, 6315 invoices / 31 customers /
#    4 vouchers / 3 payments / 3 webhooks / 11
#    deliveries — matches production mod the last 24h
#    of activity, well within RPO).
docker run --rm -i \
  -e PGPASSWORD=de_invoice_pass \
  -v /var/lib/docker/volumes/deinvoicenet_backups/_data:/backup:ro \
  postgres:16-alpine \
  pg_restore -h host.docker.internal -p 5432 -U de_invoice \
    -d de_invoice --no-owner --no-acl \
    "/backup/de_invoice-2026-07-28-030001.sql.gz"

# 4. Restart backend + frontend.
docker compose up -d backend frontend

# 5. Verify.
curl -s https://invoice.shleder.de/api/v1/health/deep | jq
```

If the backup is encrypted (you set
`BACKUP_ENCRYPTION_PASSPHRASE` in `.env`):

```bash
# Decrypt + decompress on the fly.
gpg --batch --yes --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
    --decrypt /var/backups/de-invoice/backup-2026-07-28/db.sql.gz.gpg \
  | gunzip \
  | docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice
```

### Manual backup (one-off)

```bash
# Local-only.
bash scripts/backup-prod.sh /tmp

# With off-site upload (uses BACKUP_RCLONE_REMOTE from .env).
bash scripts/backup-prod.sh
```

### Verify a backup is restorable (Tier 114)

The upgraded `backup-prod.sh` does this automatically. To
run it manually as a one-off:

```bash
# Pull the most recent backup and restore it into a
# throwaway database, then drop it.
#
# Note: db.sql.gz is a pg_dump custom-format archive
# (PostgreSQL custom database dump - v1.15-0), NOT
# plain SQL. gunzip -c alone will refuse to decompress
# it ("not in gzip format"). Use pg_restore instead —
# it reads the custom format directly from the .gz
# wrapper. Tier 220 verified this end-to-end (1.4s
# restore on 887 KB SQL dump).
LATEST=$(ls -1t /var/lib/docker/volumes/deinvoicenet_backups/_data/*.sql.gz | head -1)
docker exec de-invoice-postgres \
  createdb -U de_invoice de_invoice_restore_test
docker run --rm -i \
  -v /var/lib/docker/volumes/deinvoicenet_backups/_data:/backup:ro \
  postgres:16-alpine \
  pg_restore -h host.docker.internal -p 5432 -U de_invoice \
    -d de_invoice_restore_test --no-owner --no-acl "/backup/$(basename "$LATEST")"
docker exec de-invoice-postgres \
  dropdb -U de_invoice de_invoice_restore_test
echo "Backup verified: $LATEST"
```

---

## 5. Monitoring

If you enabled the `monitoring.yml` overlay (Prometheus +
Grafana + exporters):

### Open Grafana

```bash
# From your workstation:
ssh -L 3001:localhost:3001 deploy@invoice.shleder.de
# Then open http://localhost:3001 in your browser.
```

Default login is `admin` / the value of
`GRAFANA_ADMIN_PASSWORD` in `.env`.

### Pre-built dashboards

Two dashboards ship in `infra/prod/grafana/dashboards/`:

- **`de-invoice-app.json`** — backend request rate, p50/p95/p99
  latency, error rate by route, memory (RSS + heap).
- **`de-invoice-infra.json`** — node-exporter metrics
  (CPU, RAM, disk, network) and postgres-exporter
  (DB connections, query duration, replication lag).

### Useful PromQL queries

```promql
# Backend request rate (per second, by route).
sum by (route) (rate(http_requests_total[5m]))

# p99 latency by route.
histogram_quantile(0.99,
  sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))

# 5xx error rate.
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))

# DB connections used.
pg_stat_activity_count{state="active"}

# Disk usage on the host.
100 - (
  avg by (instance) (node_filesystem_avail_bytes{mountpoint="/"})
  / avg by (instance) (node_filesystem_size_bytes{mountpoint="/"}) * 100
)
```

### Alerting

The shipped alerts in `infra/prod/prometheus/alerts.yml`:

| Alert | Severity | Fires when |
|-------|----------|------------|
| `DeInvoiceDown` | critical | `/metrics` unreachable for 2 min |
| `DeInvoiceDbDown` | critical | `SELECT 1` fails for 1 min |
| `DeInvoiceStorageNotWritable` | critical | storage dir not writable for 5 min |
| `DeInvoiceErrorRateHigh` | warning | 5xx rate > 5% for 5 min |
| `DeInvoiceHighMemory` | warning | RSS > 900 MB for 5 min |
| `DeInvoiceSlowResponses` | warning | p95 > 1s for 10 min |
| `DeInvoiceDiskSpaceLow` | warning | disk > 85% full |
| `DeInvoiceCertExpiringSoon` | warning | cert expires in <14 days |
| `DeInvoiceBackupStale` | warning | no fresh backup in >36h |

`DeInvoiceDown` inhibits the downstream `DeInvoiceDbDown`
/ `DeInvoiceErrorRateHigh` / etc — when the backend is
down, the others are symptoms, not independent issues.

To configure receivers (Slack / email), set the
`SLACK_WEBHOOK_URL` / `SMTP_*` / `OPS_EMAIL` vars in
`.env`. See `README.md` §"Observability" for the full
Alertmanager routing tree.

---

## 6. Troubleshooting

### "The site is down"

```bash
# 1. Is the VPS reachable?
ping invoice.shleder.de

# 2. Is Caddy up?
ssh deploy@invoice.shleder.de
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml ps caddy
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml logs --tail=50 caddy

# 3. Is the backend up?
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml ps backend
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml logs --tail=50 backend

# 4. Is postgres up?
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml ps postgres
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml logs --tail=50 postgres
```

Common causes:

- **Cert didn't renew** (very rare; Caddy auto-renews at
  <30 days left). Check the Caddy logs for
  `error: obtaining certificate`. If you see one, ensure
  ports 80 + 443 are reachable from the internet
  (firewall / cloud security group).
- **Backend crashlooping** — usually a bad migration. Check
  `docker compose logs backend`. If the migration is the
  cause, restore from backup (§4 above).
- **Postgres out of disk** — `df -h /var/lib/docker/volumes/`.
  If the `pgdata` volume is full, increase the volume size
  (Hetzner: Console → Volumes → Resize) or prune old
  backups.

### "Login doesn't work"

```bash
# Check the backend is reachable.
curl -s https://invoice.shleder.de/api/v1/auth/login -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"test@shleder.de","password":"wrong"}'
# Expect 401 with { "error": "Invalid credentials" }
# If you get 502/503/504, the issue is network (Caddy ↔ backend).

# Check rate limiting.
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml logs caddy \
  | grep -i 'rate'
# If you see 429s, wait 1 minute or whitelist the IP in the
# Caddyfile's `rate_limit` directive.
```

### "PDFs aren't generating"

The PDF generation uses `pdfkit`, which has native bindings.
If the backend image was built on a different host (macOS
vs Linux) the bindings might not load.

```bash
# Check the backend logs for "Could not load binding".
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml logs backend \
  | grep -i 'binding\|pdfkit\|GLIBC'

# If you see binding errors, rebuild the image on the VPS:
cd /opt/de-invoice
docker compose -f infra/prod/docker-compose.yml build --no-cache backend
docker compose -f infra/prod/docker-compose.yml up -d backend
```

### "Backup failed"

```bash
# Check the backup container's logs.
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml logs backup

# If the off-site upload failed (e.g. rclone misconfigured),
# the local backup is still in /var/lib/docker/volumes/deinvoicenet_backups/_data/.
# Re-run the upload manually.
BACKUP_DIR=$(ls -1t /var/lib/docker/volumes/deinvoicenet_backups/_data/ | head -1)
rclone sync /var/lib/docker/volumes/deinvoicenet_backups/_data/$BACKUP_DIR \
  "$BACKUP_RCLONE_REMOTE/$BACKUP_DIR" --progress
```

---

## 7. Capacity planning

### When to upgrade the VPS

| Signal | Action |
|--------|--------|
| Backend RSS > 600 MB sustained | Upgrade to CX31 (8 GB). |
| Postgres connections > 80 | Increase `max_connections` in postgresql.conf, then upgrade. |
| p95 latency > 1s for non-PDF routes | Investigate queries first; upgrade if it's CPU-bound. |
| Disk > 70% full | Resize the volume. Add a second volume if backups are growing fast. |

### When to add a second VPS

Not for at least 18 months. SH Leder is ~5 users; a single
CX21 is enough for at least 50 users.

If you ever outgrow a single host, the path is:
- Move postgres to a managed service (RDS, Hetzner
  Managed Postgres, or Crunchy Bridge).
- Run multiple backend replicas behind a load balancer.
- Caddy as the load balancer + TLS terminator.

But that's a Tier N for some future N. Don't do it
prematurely.

---

## 8. Security operations

See [`SECURITY.md`](SECURITY.md) for the full checklist.
Quick wins to review quarterly:

- [ ] `JWT_SECRET` rotated (or note why it wasn't)
- [ ] `POSTGRES_PASSWORD` rotated (or note why it wasn't)
- [ ] `BACKUP_ENCRYPTION_PASSPHRASE` rotated
- [ ] Admin users reviewed (`SELECT email, last_login_at FROM "User" WHERE role='ADMIN'`)
- [ ] TLS cert expiry > 30 days (run `curl -vI` and check
      `expire:`)
- [ ] Fail2ban log reviewed (`sudo fail2ban-client status sshd`)
- [ ] Unattended-upgrades ran (`cat /var/log/unattended-upgrades/unattended-upgrades.log`)
- [ ] Off-site backup verified restorable
