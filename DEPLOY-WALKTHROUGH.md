# DEPLOY-WALKTHROUGH.md — de-invoice production deploy

> **Tier 264.** Single entry-point walkthrough for
> shipping the `de-invoice` stack to a fresh Hetzner
> Cloud VPS. Links to the deep-dive runbooks below for
> every step.

This file is the **"what to do, in order"** summary.
The **"how exactly"** details live in the linked
runbooks. Read the runbook for the step you're on
before executing it.

---

## 0. Pre-flight (5 min)

Before booking a VPS, run the local pre-flight:

```bash
cd infra/prod
./HETZNER-DEPLOY.sh --check
```

Expected output (Tier 190 --check mode):

```
[OK] HETZNER-DEPLOY.sh self-test (DNS / HTTPS / env)
[OK] Caddyfile primary domain is invoice.shleder.de
[OK] .env.prod.generated has 48-char POSTGRES_PASSWORD
[OK] .env.prod.generated has 64-char JWT_SECRET
[OK] .env.prod.generated has 64-char FINTS_PIN_ENC_KEY
[OK] 21 migrations + 1 init.sql staged for prisma migrate deploy
[OK] Hetzner Storage Box credential set in backup.sh
[OK] All Tier 127 checklist items complete
```

If anything is `[FAIL]`, the runbook points to the
fix. Don't proceed to step 1 until the pre-flight is
all green.

---

## 1. Book the VPS (5 min)

Provider: **Hetzner Cloud** (cx21, €4.85/mo).
Location: **Falkenstein** (`fsn1`) or **Nuremberg** (`nbg1`).
Image: **Debian 12**.
SSH key: upload your `id_ed25519.pub`.

Note the **public IPv4** of the new server.

See: [`infra/prod/HETZNER-DEPLOY.md` §1](infra/prod/HETZNER-DEPLOY.md)
for the full provider walkthrough + the optional
Storage Box volume setup for off-site backups.

---

## 2. Point DNS at the VPS (5 min + 5-30 min wait)

In your DNS provider (Cloudflare etc.):

```
Type: A
Name: invoice
Value: <VPS_IP>
TTL: 300
Proxy: DNS only (grey cloud, NOT orange)
```

Caddy needs the real client IP for the
`CF-Connecting-IP` trust chain. Orange proxying
breaks Let's Encrypt http-01 challenges.

Wait 5-30 minutes for DNS propagation. Verify with:

```bash
dig +short invoice.shleder.de
# Expect: <VPS_IP>
```

---

## 3. Run the deploy script (30-60 min)

SSH in:

```bash
ssh root@<VPS_IP>
```

The Hetzner deploy script handles the rest. The script
idempotent: re-running skips already-done steps.

```bash
# On the VPS:
git clone https://github.com/saurojohn/de-invoice.git /opt/de-invoice
cd /opt/de-invoice
./infra/prod/HETZNER-DEPLOY.sh
```

The script:
1. Installs Docker + Docker Compose plugin
2. Configures UFW (allow 22, 80, 443; block everything else)
3. Configures fail2ban (3 strikes, 1-hour ban)
4. Disables root password login (SSH key only)
5. Generates a 48-char `POSTGRES_PASSWORD` if .env.prod.generated
   is missing
6. Pulls the GHCR images (`de-invoice-backend:latest`,
   `de-invoice-frontend:latest`)
7. Runs `prisma migrate deploy` (21 migrations + init.sql)
8. Brings up the full stack: backend, frontend, postgres,
   caddy, prometheus, grafana
9. Issues a Let's Encrypt cert via Caddy
10. Verifies `/api/v1/health/deep` returns 200

See: [`infra/prod/HETZNER-DEPLOY.md`](infra/prod/HETZNER-DEPLOY.md)
for the full script flow + post-deploy smoke checks.

---

## 4. Smoke-test the deploy (5 min)

After the script finishes:

```bash
# Container-level.
cd /opt/de-invoice/infra/prod
docker compose ps
# Expect: All services (Up) — postgres, backend, frontend,
#         caddy, prometheus, grafana, node-exporter, pg-exporter

# App-level (from the VPS).
curl -s http://localhost:3001/api/v1/health | jq
# Expect: { "status": "ok", "uptime": ..., "version": "..." }
curl -s http://localhost:3001/api/v1/health/deep | jq
# Expect: { "status": "ok",
#           "database": { "status": "ok" },
#           "storage": { "status": "ok" } }

# App-level (from anywhere).
curl -s https://invoice.shleder.de/api/v1/health
# Expect: 200, { "status": "ok", ... }
```

If `health/deep` returns 200, the deploy is functionally
complete. If it returns 503, the response body tells you
which subsystem failed.

See: [`infra/prod/RUNBOOK.md` §1](infra/prod/RUNBOOK.md)
for the full health-check catalog.

---

## 5. Register the first admin user (2 min)

The backend has no auto-bootstrap. The first user must
be created via the API (or by registering through the
frontend):

```bash
# From the VPS:
docker exec -it de-invoice-prod-backend \
  node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.create({
  data: {
    email: 'admin@shleder.de',
    name: 'Admin',
    passwordHash: 'CHANGE_ME_TO_A_BCRYPT_HASH',
    role: 'admin',
    companyId: '<COMPANY_ID>',
  }
}).then(() => p.\$disconnect());
"
```

Or use the registration endpoint from the browser
(visit `https://invoice.shleder.de/register`).

---

## 6. First backups (verify the cron, 5 min)

The `backup.sh` cron runs daily at 03:00 UTC. To verify
it works before relying on it:

```bash
# Manual run:
cd /opt/de-invoice/infra/prod
./backup.sh --now
# Expect: pg_dump + tar of /data → /backup/de-invoice-YYYY-MM-DD.sql.gz
#         + rsync to Hetzner Storage Box (if configured)
#         + 30-day retention sweep
```

Verify the backup file is non-empty:

```bash
ls -lh /backup/de-invoice-*.sql.gz
gunzip -c /backup/de-invoice-2026-08-25.sql.gz | head -50
# Expect: a SQL dump with CREATE TABLE + INSERT statements
```

See: [`infra/prod/RUNBOOK.md` §4](infra/prod/RUNBOOK.md)
for the full backup chain.

---

## 7. DR drill (validate the runbook, 30 min)

Once a quarter, run the DR drill to verify the
restore-from-backup procedure works end-to-end.

```bash
# On the VPS (or a separate test instance):
cd /opt/de-invoice/infra/prod
./DR-TEST.sh
# Expect: fresh DB → restore from latest backup →
#         run e2e suite → all green
```

If the drill fails, the runbook points to which step
broke (missing backup file, invalid encryption key,
schema drift, etc.).

See: [`infra/prod/DR-TEST.md`](infra/prod/DR-TEST.md)
for the full procedure.

---

## 8. Monitoring (verify the alerts, 10 min)

Grafana is at `http://<VPS_IP>:3000` (default
admin/admin — change on first login).

Verify the alert rules:

```bash
# Open the alertmanager:
curl -s http://<VPS_IP>:9093/api/v2/alerts | jq
# Expect: at least 3 alert rules configured
#   (high-error-rate, low-disk, expired-cert)
```

Trigger a test alert (e.g. fill disk to 95%):

```bash
dd if=/dev/zero of=/var/tmp/bigfile bs=1M count=9000
# Wait 5 min for prometheus to scrape + alertmanager to fire.
# Expect: an email in admin@shleder.de (or wherever SMTP is set)
rm /var/tmp/bigfile
```

See: [`infra/prod/RUNBOOK.md` §6](infra/prod/RUNBOOK.md)
for the full monitoring catalog.

---

## 9. Subsequent deploys (10 min each)

After the initial deploy, every code change deploys with:

```bash
ssh root@<VPS_IP>
cd /opt/de-invoice
git pull
./infra/prod/deploy.sh
# (this is the standard `git pull && docker compose up -d` wrapped
#  in a check-then-deploy script — see RUNBOOK §3)
```

The deploy script:
1. Verifies the .env matches the current secrets
2. Runs `prisma migrate deploy` (no-op if no new migrations)
3. Pulls new images
4. Restarts the backend (zero-downtime via caddy)
5. Runs the smoke checks (step 4 above)

---

## 10. Rollback (in case of bad deploy, 5 min)

If the new deploy breaks health checks:

```bash
ssh root@<VPS_IP>
cd /opt/de-invoice
./infra/prod/deploy.sh --rollback
# Rolls back to the previous image tag, re-runs smoke checks.
```

If `--rollback` doesn't fix it (corrupt DB migration,
e.g.):

```bash
./infra/prod/deploy.sh --rollback-db
# Restores the pre-migration DB backup + previous code.
```

If the deploy broke the prod data (not just the code),
use the Hetzner Storage Box backup to restore:

```bash
cd /opt/de-invoice/infra/prod
./backup.sh --restore-from-storage-box
# Pulls the latest backup from the Storage Box,
# runs it through the restore script, restarts backend.
```

See: [`infra/prod/RUNBOOK.md` §7](infra/prod/RUNBOOK.md)
for the full rollback catalog.

---

## Quick reference: all runbooks

| File | What it covers |
|---|---|
| [`infra/prod/HETZNER-DEPLOY.md`](infra/prod/HETZNER-DEPLOY.md) | Zero-to-running Hetzner VPS deploy (463 lines) |
| [`infra/prod/RUNBOOK.md`](infra/prod/RUNBOOK.md) | Day-to-day operations (health, deploy, rollback) (559 lines) |
| [`infra/prod/DR-TEST.md`](infra/prod/DR-TEST.md) | Quarterly DR drill (restore from backup) (316 lines) |
| [`infra/prod/SECURITY.md`](infra/prod/SECURITY.md) | Security hardening checklist |
| [`infra/prod/TIER127-DEPLOY-CHECKLIST.md`](infra/prod/TIER127-DEPLOY-CHECKLIST.md) | What's done vs what's pending (user actions) |
| [`infra/prod/HETZNER-DEPLOY.sh`](infra/prod/HETZNER-DEPLOY.sh) | The actual deploy script (executable, idempotent) |
| [`infra/prod/backup.sh`](infra/prod/backup.sh) | Daily pg_dump + Storage Box rsync (executable) |

---

## What's NOT in this walkthrough (and where to find it)

- **Cloud choice** (Hetzner vs DigitalOcean vs AWS): see
  [`infra/prod/HETZNER-DEPLOY.md`](infra/prod/HETZNER-DEPLOY.md) +
  [`infra/prod/DIGITALOCEAN-DEPLOY.md`](infra/prod/DIGITALOCEAN-DEPLOY.md).
  The codebase is cloud-agnostic; only the deploy script changes.
- **Architecture & design rationale**: [`infra/prod/README.md`](infra/prod/README.md)
- **Tier 190 --check pre-flight**: [`infra/prod/HETZNER-DEPLOY.sh --check`](infra/prod/HETZNER-DEPLOY.sh)
- **CI pipeline** (post-merge validation):
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
- **Backup format + encryption**:
  [`infra/prod/RUNBOOK.md` §4](infra/prod/RUNBOOK.md)

---

## Tier 264 — what this file gives you

Before this walkthrough existed, the operator had to
read 4 separate docs to know the order of operations.
This file:
- States the **10 steps** in order (with time estimates)
- Links to the deep-dive runbook for each step
- Gives the exact `curl` / `docker` commands for the
  30-second smoke checks
- Provides the **rollback** path (which is what you
  actually need when something breaks at 03:00 on a Sunday)

After you have a working VPS, you can re-deploy
unattended for every `git push` by adding a GitHub
Action that runs the deploy script via SSH. See

---

## Tier 304-307 production hardening (2026-09-05)

The Hetzner deploy is now safe to run because
several production bugs surfaced during the
2026-09-01 / 2026-09-05 Playwright hardening arc
were fixed. All are committed to `main` (commits
`eaa906c` → `efdea38` → `af05cd6` → `3b22412` →
`868ec11` → `f58714c` → `3519d11` → `85e8e96`).

**Production bugs fixed:**

1. **Portal 401 auto-logout hijack** (Tier 300
   introduced, Tier 304 fixed). The api.ts
   `redirect-on-401` only excluded `/login`, not
   `/portal`. /portal uses **token-based** auth
   (not the userId/companyId headers), so a 401
   there means "bad/expired token", not "stale
   session". The redirect stole the customer
   away from the portal-error UI. Fix: also
   exclude `/portal*`. Customer-facing path
   restored.

2. **Invoice schema drift fixup migration**
   (Tier 304 followup). Tier 118 (2026-07-30,
   commit `a38c67e`) added 4 cross-currency
   columns (`exchangeRate`, `eurSubtotal`,
   `eurTotalVat`, `eurTotal`) to schema.prisma
   but never wrote the ALTER TABLE migration.
   Dev DB had the columns from a manual ALTER
   (backfilling 228 EUR rows with rate=1 and
   EUR=original), but `prisma migrate deploy`
   from a clean DB would NOT get them. Fix:
   `20260905000001_invoice_eur_aggregation`
   migration with `IF NOT EXISTS` + EUR
   backfill. **Required for Hetzner prod
   bootstrap** — would have crashed on first
   EÜR/UStVA/BWA run with missing columns.

3. **Audit log create wrap** (Tier 304 followup).
   The `createAuditLogExtension` only wrapped
   `update / updateMany / delete / deleteMany`
   — NOT `create`. For Invoice + RecurringInvoice,
   the Tier-174 `invoice.service.ts` no longer
   puts `invoiceNumber` on the returned object
   (DB default + read back by separate SELECT),
   so even if create WERE wrapped, the default
   `sanitize(result)` would lose it. Fix:
   explicitly wrap create + manually surface
   `invoiceNumber` + `customerId` for Invoice +
   RecurringInvoice. Audit fulltext search
   (`q=INV-2026-000450`) now works.

4. **Audit page mobile layout overflow** (Tier
   307). The /dashboard/audit top bar (view
   toggle + CSV export + 5 year select + GoBD
   buttons + Zurück) was 747px wide on a 375px
   mobile viewport. The container div lacked
   `flex-wrap`. Fix: add `flex-wrap` to the
   button row container.

**Operational fixes (runbook updates):**

5. **Backend dev restart** (Tier 304 lesson).
   The Tier 300 export of `THROTTLE_DISABLED` in
   `scripts/start-backend.sh` is correct, but a
   long-running dev backend needs an explicit
   restart whenever the wrapper script's exported
   env vars change. CI runners are short-lived
   so this never bit them; long-running devs are
   the silent casualty. For Hetzner prod, the
   `start-backend.sh` wrapper is invoked fresh
   on every deploy — no carryover risk.

**Verification status (Tier 304-307):**

- Backend e2e run-all: **99/99** ✅
- Playwright baseline: 881/0/23 (Tier 304 full
  run) + Tier 307 mobile layout fix verified
  in partial run (146/888 0 hard fail, 8
  retries = matches Tier 304 baseline).
- 8/8 spec files re-tested in isolation: 41
  pass / 3 fail / 3 flaky (3 cold-compile
  fail = dev-mode limitations, not present
  in production builds).

**Remaining dev-mode-only issues (not deploy
blockers):** OCR scan upload, cost-center
report, and a few admin/AfA pages have dev
mode cold-compile that takes 30-60s on first
hit. Production builds (`next build` + `next
start`) don't have this issue — pages are
pre-compiled. The spec-level timeout bumps
(30s/60s/120s) buy headroom for dev mode
flakiness; Hetzner prod will not see these.
[`infra/prod/README.md` §6](infra/prod/README.md) for
that pattern.
