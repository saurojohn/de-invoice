# RUNBOOK — de-invoice production operations

> Tier 13. This document is the operator's
> reference for keeping de-invoice running
> in production. DEPLOY.md covers the
> initial setup; this covers what to do
> after it's running.
>
> **Sections:**
> 1. Health checks · 2. Logs · 3. Common
> operations · 4. Troubleshooting · 5.
> Capacity planning · 6. Update procedure ·
> 7. Active monitoring (Tier 13) · 8. PDF
> journal cap (Tier 13) · 9. Auth and rate
> limiting (Tier 13) · 10. Role-based
> access control (Tier 13) · 11. Audit
> log (Tier 13) · 12. CI (Tier 13) · 13.
> UStVA / ELSTER submission (Tier 13) ·
> 14. PDF generation (Tier 13)

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
---

## 7. Active monitoring (Tier 13)

Tier 12 added the `/health`, `/health/deep`,
and `/metrics` endpoints. Tier 13 wires
them up to a real monitoring system so the
operator actually finds out when the
backend is down (vs. learning about it
from a customer).

### 7.1 healthchecks.io active ping

`backend/scripts/healthchecks-ping.sh`
calls `/health/deep` every 5 minutes. If
the call returns 200, the script pings
healthchecks.io `/success`. If it returns
non-200 (DB or storage down) or the
backend is unreachable, it pings `/fail`.
After 2 consecutive missed pings
(configured at healthchecks.io: period=5min,
grace=5min), healthchecks.io sends an
alert email.

Setup (one-time, on the production host):

```bash
# 1. Sign up at https://healthchecks.io
# 2. Create a check (period=5, grace=5)
# 3. Copy the ping URL
sudo mkdir -p /etc/de-invoice
sudo tee /etc/de-invoice/healthchecks.env >/dev/null <<EOC
HEALTHCHECKS_PING_URL=https://hc-ping.com/your-uuid
BACKEND_URL=http://localhost:3001
EOC
sudo chmod 600 /etc/de-invoice/healthchecks.env

# 4. Install the systemd timer
sudo cp infra/systemd/de-invoice-healthchecks.service \
        /etc/systemd/system/
sudo cp infra/systemd/de-invoice-healthchecks.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now de-invoice-healthchecks.timer

# 5. Verify
sudo systemctl list-timers de-invoice-healthchecks*
sudo journalctl -u de-invoice-healthchecks.service -n 5
```

For Docker Compose deployments, replace
the systemd timer with a sidecar container
that runs the ping script in a loop:

```yaml
# docker-compose.prod.yml
services:
  healthchecks-ping:
    image: curlimages/curl:8.5.0
    environment:
      - HEALTHCHECKS_PING_URL=https://hc-ping.com/your-uuid
      - BACKEND_URL=http://backend:3001
    entrypoint: /bin/sh
    command: >
      -c "apk add --no-cache bash &&
          while true; do
            /opt/scripts/healthchecks-ping.sh;
            sleep 300;
          done"
    volumes:
      - ./backend/scripts/healthchecks-ping.sh:/opt/scripts/healthchecks-ping.sh:ro
    depends_on:
      - backend
```

### 7.2 Prometheus metrics

`/metrics` exposes the application-specific
metrics in Prometheus text format. To
actually scrape them:

```bash
# 1. Install Prometheus (macOS: brew install prometheus)
# 2. Drop infra/prometheus/scrape.yml into
#    your prometheus.yml's scrape_configs:
# 3. Restart Prometheus
brew services restart prometheus
open http://localhost:9090/graph
# 4. Try: de_invoice_http_requests_total
```

The included scrape config defines a
5-second scrape interval and recommended
alert rules (commented out — copy them
to `infra/prometheus/alerts.yml` if you
have Alertmanager set up).

For Kubernetes, the same target
config works in a ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: de-invoice
spec:
  selector:
    matchLabels:
      app: de-invoice-backend
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
```

### 7.3 What to monitor

- **`up{job="de-invoice"} == 0`** — backend unreachable. Critical.
- **`de_invoice_db_connected == 0`** — SELECT 1 fails. Critical.
- **`de_invoice_storage_writable == 0`** — can't write to storage dir. Critical.
- **`rate(de_invoice_errors_total[5m]) > 0.1`** — 5xx error rate above 6/min sustained. Warning.
- **`de_invoice_http_request_duration_seconds`** — p95 latency. The histogram is bucket-counted so use `histogram_quantile(0.95, sum by (le) (rate(...[5m])))`.

## 8. PDF journal cap (Tier 13)

The `/api/v1/accounting/journal/pdf`
endpoint caps the number of returned
vouchers at **1000** (configurable in
`backend/src/modules/accounting/journal.service.ts`,
`const cap = 1000`). A wider date range
returns the FIRST 1000 and sets:

- `X-Journal-Capped: 1`
- `X-Journal-Total-Found: <actual count>`

Why 1000? A 1000-voucher journal
serializes to ~1-2 MB of PDF, which is
the upper end of what most browsers
can render in <2s and fits in a single
Express request without OOM-ing the
backend. The cap is enforced at the
database (`take: 1000` in the Prisma
`findMany`) so we never load more than
1000 rows into memory.

If a user picks a year-long range on a
busy customer (5-20k vouchers), the
response is still 200 + a usable PDF,
just truncated. The frontend should
show "showing first 1000 of 5432 —
bitte Datum eingrenzen" using the two
headers above.

**Future work — streaming**: the
service still collects the PDF into a
Buffer before responding, so peak
memory is ~1-2 MB per concurrent
request. If the cap is ever increased
or removed, the service should be
refactored to use
`doc.pipe(response)` instead of
collecting chunks. The current buffer
approach is fine for the 1000-row cap.

---

## 9. Auth and rate limiting (Tier 13)

The backend's `/auth/login` is rate-limited
at **5 requests per minute per IP** with a
**15-minute lockout** after 5 consecutive
failed attempts (per IP). This is enforced
by `@nestjs/throttler` + a per-IP in-memory
map in `auth.controller.ts`. The values are
hardcoded — if you ever need to relax them
for legitimate traffic, edit the `@Throttle`
decorator on the `login()` method.

### 9.1 How to debug a "too many failed logins" lockout

```bash
# The lock state is in-process memory in
# the running backend. It's NOT
# persisted to Postgres, so a backend
# restart clears all locks.
# If a single IP is locked out, restart:
pkill -9 -f "ts-node"
cd backend && bash scripts/start-backend.sh
```

If you need to whitelist a specific IP
(proxy, internal network), set
`TRUST_PROXY=true` in the env so the
backend reads the real client IP from
`X-Forwarded-For`. **Do this BEFORE the
lockout threshold is hit.**

### 9.2 What was REMOVED in Tier 13

Tier 12 had an `AUTH_RATE_LIMIT_DISABLED=1`
env-var bypass that raised the 5/min limit
to 100K. This was used by the Playwright
test suite but was a real production risk:
anyone who started the backend with that
env var by accident would have had login
rate-limiting disabled. **Tier 13 removed
it.** Tests now use the
`/tmp/cashbook-e2e-auth.env` cache
(written by `backend/e2e/_lib.sh`'s
`login()` on its first call) so the full
suite makes only 3-4 `/auth/login` calls
per run — well under the 5/min limit.

If you ever bring back the bypass for
debugging, **set the env var explicitly
in the shell, not in `.env`**, so a
forgotten env file can't ship a
production build with auth throttling
disabled.

---

## 10. Role-based access control (RBAC, Tier 13)

The `User.role` field accepts three values:
`admin`, `accountant`, `viewer`. The
permission matrix lives in
`backend/src/modules/users/users.service.ts`
(`PERMISSIONS` constant):

| Permission         | Required role |
| ------------------ | ------------- |
| `users.read`         | admin |
| `users.invite`       | admin |
| `users.changeRole`   | admin |
| `users.deactivate`   | admin |
| `company.update`     | admin |
| `invoice.create`     | accountant+ |
| `invoice.update`     | accountant+ |
| `invoice.delete`     | accountant+ |
| `invoice.send`       | accountant+ |
| `ustva.submit`        | admin |
| `accounting.delete`  | admin |
| `customer.read`      | viewer+ (any logged-in user) |
| `product.read`       | viewer+ |
| `reports.read`       | viewer+ |

A higher role satisfies every lower-role
permission (admin ≥ accountant ≥ viewer).

### 10.1 How to change a user's role

```bash
# 1. Find the user id
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "SELECT id, email, role FROM \"User\" WHERE email='alice@example.com';"

# 2. Promote / demote via the API
curl -X PATCH "http://localhost:3001/api/v1/users/$USER_ID/role?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $ADMIN_USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"role":"accountant"}'
# role ∈ admin | accountant | viewer
```

The endpoint requires the calling user to
have `users.changeRole` (admin only). A
viewer/accountant calling it gets 403.

### 10.2 When a new permission is needed

  1. Add the action to `PERMISSIONS` in
     `users.service.ts` with the required
     role.
  2. In the controller method, add the
     `UsersService.requireRole(req.user?.role, '...')`
     check (or use the `@Require('...')`
     decorator from `auth/roles.decorator.ts`).
  3. Add a test case in `e2e/44-rbac.sh`
     (positive for the role that should
     succeed, 403 for the role that
     shouldn't).

---

## 11. Audit log (Tier 13)

Every update / updateMany / delete /
deleteMany on a business-data model
(Customer, Invoice, Product, Expense,
Voucher, Attachment, Supplier, …) writes
an `AuditLog` row via the Prisma client
extension in
`backend/src/prisma/audit-log.extension.ts`.
The row captures: who (`userId`),
when (`createdAt`), what (`action`),
which entity (`entityType` + `entityId`),
the before-state (`oldData` JSON), the
after-state (`newData` JSON), and from
where (`ipAddress`, `userAgent`).

### 11.1 How to query the audit log

```bash
# Recent activity for a specific customer
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
SELECT
  \"createdAt\",
  action,
  \"userId\",
  \"ipAddress\",
  \"oldData\",
  \"newData\"
FROM \"AuditLog\"
WHERE \"entityType\" = 'Customer' AND \"entityId\" = '$CUSTOMER_ID'
ORDER BY \"createdAt\" DESC
LIMIT 20;"

# All deletions in the last 7 days
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
SELECT \"createdAt\", action, \"entityType\", \"entityId\", \"userId\"
FROM \"AuditLog\"
WHERE action LIKE '%.deleted' AND \"createdAt\" > now() - interval '7 days'
ORDER BY \"createdAt\" DESC;"

# Activity for a specific user (e.g. the Steuerberater)
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
SELECT \"createdAt\", action, \"entityType\", \"entityId\"
FROM \"AuditLog\"
WHERE \"userId\" = '$USER_ID'
ORDER BY \"createdAt\" DESC LIMIT 50;"
```

The `oldData` / `newData` columns are JSON.
PostgreSQL's `->` and `->>` operators work:

```sql
-- Show what fields changed in a specific update
SELECT
  action,
  jsonb_diff(\"oldData\", \"newData\") AS changes
FROM \"AuditLog\"
WHERE id = '$AUDIT_ID';
-- (requires the jsonb_diff extension; not
-- enabled by default. Use a simple
-- jsonb_each_text comparison instead.)
```

### 11.2 Sensitive fields are redacted

The extension scrubs `passwordHash`,
`passwordResetToken`, `twoFactorSecret` from
`oldData` / `newData` before write. Other
fields (email, profile, notes, …) are
captured in full. The truncation kicks in
at 8 KB (replaced by `{_truncated: true,
_preview: "..."}`).

### 11.3 When the extension doesn't fire

The extension skips models NOT in
`AUDITED_MODELS` (see the top of
`audit-log.extension.ts`). User
management actions (User, UserInvitation,
2FA secret changes) are audited
**inline** in `auth.controller.ts` and
`users.service.ts` via direct
`prisma.auditLog.create()` calls — they
don't go through the extension because
the extension can't safely capture
sensitive auth-related fields via a
generic diff.

If a new model is added and you want
update/delete auditing, add the model
name (PascalCase) to `AUDITED_MODELS`.

### 11.4 Performance

The extension's overhead is **one extra
DB round-trip per mutation** (the
`findUnique` for oldData + the
`auditLog.create`). On bulk
`updateMany` / `deleteMany` the
oldData is skipped (we only log the
count, not the per-row pre-image).
Audit rows are indexed on
`(companyId, createdAt)` and
`(entityType, entityId)` so most queries
are sub-100ms even with 100k+ rows.

---

## 12. CI (Tier 13)

PR-triggered CI runs **51 tests** (43
backend e2e + 8 Playwright UI) on every
PR targeting `main`. See
`.github/workflows/ci.yml`.

The CI workflow is **the same scripts
the developer runs locally**:

```bash
# Local equivalent of what CI does:
cd backend && for f in e2e/[0-9]*.sh; do bash "$f"; done
cd frontend && npx playwright test
```

If a test fails in CI but not locally,
the usual culprit is one of:

  - **Backend state pollution**: a
    prior test left rows that the
    current test depends on. The
    cleanup is at the END of each
    test, so if a test crashes mid-way,
    the next run sees stale data.
    Fix: the e2e test should DELETE
    its own rows in a `trap EXIT`
    handler.

  - **The `AUTH_RATE_LIMIT_DISABLED`
    bypass is gone** (see §9.2). If
    a test makes >5 `/auth/login`
    calls in 60 seconds, CI will
    fail. The Playwright suite uses
    a shared `beforeAll` login so
    the count is 3-4.

  - **Throttler saturation**: the
    600/60s default throttler on all
    other endpoints. The full
    suite makes ~200 requests in
    ~3 minutes, so we're under
    600/60. If you add tests that
    burst >10 req/s on the same
    endpoint, they'll hit the
    throttler.

  - **Playwright + Next.js dev
    server**: the CI job starts
    `next dev` and waits 20s for the
    cold compile. If your test uses
    a page that hasn't been compiled
    yet, the first navigation takes
    >20s and the test times out. The
    fix is to either (a) increase
    `navigationTimeout` in the test,
    or (b) warm the dev server with
    a request to that route in
    beforeAll.

### 12.1 How to add a new e2e test

  1. Create the file:
     `backend/e2e/NN-feature-name.sh`
     where `NN` is the next number.
  2. The file should:
     - `source _lib.sh` at the top
       (gets the auth cache helper)
     - Use `assert_eq` / `assert` /
       `note` helpers from `_lib.sh`
     - Use `docker exec` for DB
       operations (not `psql` directly)
     - End with `echo "==== $PASS passed, $FAIL failed ===="` + `exit $FAIL`
  3. Test it locally:
     `cd backend && bash e2e/NN-feature-name.sh`
  4. CI picks it up automatically
     (the workflow globs `[0-9]*.sh`).

---

## 13. UStVA / ELSTER submission (Tier 13)

The project already generates **ERiC-compatible
XML** for UStVA. See
`docs/ELSTER_EVALUATION.md` for the
full decision document on how to
actually submit to the Finanzamt.

### 13.1 The current production path (as of Tier 13)

1. User clicks "UStVA abschließen" in
   the UI → `POST /api/v1/ustva/filings`
   saves a `UstvaFiling` row with
   `status='draft'`.
2. The Steuerberater (or the user
   themselves) downloads the XML:
   `GET /api/v1/ustva/filings/:id/elster-xml`
3. They upload to Mein ELSTER
   (https://www.elster.de/eportal/start)
4. They sign with their ElsterSecure
   certificate (.pfx + PIN)
5. Submit

This is a **manual** workflow but it's
correct and free. Step 4 is the
non-automatable part until you wire
in the official ERiC library.

### 13.2 What the XML output looks like

The XML is ERiC-compatible and includes
all required BMF Anlage UStVA fields
(Kz 20-23, 26-29, 36, 41, 43, 44,
50-66, 81). The schema is the
**calendar-year version** (currently
2026). Each year's Anlage has slightly
different field layouts — check
`elster.service.ts` for the
year-specific encoding rules.

The XML is validated by `e2e/49-elster-xml.sh`
which checks:

  - Root element is `<Datenlieferung>`
  - 13-digit `<Steuernummer>`
  - `<Vorgang>`, `<Eingangsdatum>` present
  - BMF B-prefix format on numerics
  - `<Kz81>` (Verbleibender Betrag) present
  - XML is well-formed (parseable)

When the BMF updates the Anlage UStVA
(typically each January), update
`elster.service.ts` accordingly and
the e2e test will catch any regression.

### 13.3 Future: ERiC integration

If/when we decide to self-host ERiC
(option A in
`docs/ELSTER_EVALUATION.md`):

  1. `libericapi` is a C library;
     we'd need a thin `ffi-napi`
     wrapper or call the bundled
     `eric` CLI via `child_process`
  2. The `fints-real.ts` wrapper
     (Tier 13.4.1) is a separate
     concern — that's the BANK
     connection, not ELSTER
  3. The XML generator is already
     correct; the integration is
     just "send the XML + signature
     to ELSTER, get the response,
     update the filing status"

**Recommendation**: defer until SH
Leder has >5 customers using the
system, or until the per-filing cost
of the manual workflow exceeds the
dev cost of the integration (~1-2
weeks).

---

## 14. PDF generation (Tier 13)

The accounting journal PDF and the
invoice PDFs are generated by
PDFKit (server-side, in
`backend/src/modules/accounting/journal.service.ts`
and `backend/src/modules/invoice/`).
They render to **in-memory Buffer**
before being sent to the client.

### 14.1 Memory considerations

  - **Invoices**: typically 50-200KB.
    100 concurrent invoice generations
    = 20MB peak memory. Fine.
  - **Accounting journal**: capped at
    1000 entries (Tier 13.3.1), which
    produces a 1-2MB PDF. Without
    the cap, a year-long date range
    on a busy customer could produce
    5-20MB. See §14.2.

### 14.2 The journal cap

`GET /api/v1/accounting/journal/pdf`
caps the response at **1000 vouchers**.
The cap is enforced at the DB level
(`take: 1000` in Prisma) so we never
load more than 1000 rows. When the
underlying count exceeds 1000:

  - `X-Journal-Capped: 1`
  - `X-Journal-Total-Found: <actual count>`

The frontend should show "showing
first 1000 of 5432 — bitte Datum
eingrenzen" using these headers. The
PDF itself contains the "Summe Soll =
Haben" line only when ALL entries
balance — a truncated journal may
not balance, so the line shows
the sum of the included rows
(±partial balance).

### 14.3 When the cap should be raised

If a customer is regularly hitting the
cap (e.g. they want a year-long
report for the Steuerberater), there
are two options:

  1. **Raise the cap**. Edit
     `const cap = 1000` in
     `journal.service.ts`. Doubling
     it doubles the peak memory. The
     cap exists specifically to avoid
     OOM. If you raise it, also
     consider increasing the
     container memory limit (see
     `docker-compose.prod.yml`).
  2. **Stream the PDF** (Tier 13.3.2,
     deferred). Refactor
     `renderPdf` to use `doc.pipe(res)`
     instead of collecting chunks.
     The Buffer is replaced by a
     pipeline; peak memory drops
     to ~100KB regardless of PDF
     size. The refactor is
     self-contained (one file,
     ~50 lines changed) — do it
     when you actually need to raise
     the cap past ~5000.

### 14.4 PDF font availability

PDFKit ships with PDF core 14 fonts
(Helvetica, Times-Roman, Courier +
bold/oblique variants). The journal
PDF uses `Helvetica-Bold` for the
header and `Helvetica` for body. Both
are built into every PDF reader — no
font embedding required. If you ever
need a non-standard font (e.g. for
branding), embed it via
`doc.registerFont('brand', 'path/to/font.ttf')`
and update the `doc.font(...)` calls
in `journal.service.ts`.
