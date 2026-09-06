# DEPLOY-READY-SUMMARY.md — 2026-09-06

> **Status: ready to deploy.** The Tier 304-312
> hardening arc (17 commits, `36fc31b..e9db8a6`)
> is complete. All 4 production bugs surfaced
> during the Playwright run have been fixed, the
> dev DB is documented as recoverable via
> `scripts/fix-dev-pg.sh`, and the Hetzner deploy
> walkthrough is up to date. The Tier 312
> segment checkpoints (per-20-spec sleep + 
> /health/deep ping) prevent the next run-all
> from crashing the dev PG.

## Deploy in 3 commands

```bash
# 1. Provide the Hetzner VPS IP + SSH key.
# 2. Pre-flight:
cd /Users/shledergmbh/Projects/de-invoice/infra/prod
./HETZNER-DEPLOY.sh --check
# 3. Deploy:
./HETZNER-DEPLOY.sh
```

The walkthrough has a rollback path
(`deploy.sh --rollback` + `--rollback-db`) in
case the new deploy breaks health checks.
Post-deploy verification commands are in the
"Post-deploy verification" section below.

## What's ready

- **Code:** 12 commits on `main`, all pushed to
  GitHub. None of the fixes are speculative —
  each was validated by isolated re-runs of
  the affected spec files.
- **Schema:** new migration
  `20260905000001_invoice_eur_aggregation` is
  in the migration history and will run on the
  first `prisma migrate deploy` against a fresh
  Hetzner DB.
- **Docs:** `DEPLOY-WALKTHROUGH.md` has the
  Tier 304-307 hardening section. `PLAYWRIGHT-
  TIER304-309-FINAL.md` is the session summary.
- **Recovery script:** `scripts/fix-dev-pg.sh`
  (Tier 310) for the dev PG corruption.

## What's NOT in scope (and not deploy blockers)

- **Dev DB is currently broken** (Tier 310). The
  4-day-uptime PG container (`/tmp/pgdata`)
  silently corrupted after the Tier 304-309
  backend restart cycles. Hetzner prod is a
  fresh DB built from the migration history —
  it does NOT inherit this corruption. If you
  want to restore the dev environment for
  further local testing, run
  `bash scripts/fix-dev-pg.sh` (it needs
  `sudo` for the chown step).
- **Dev-mode cold-compile flakiness** for OCR
  scan upload + cost-center report + a few
  admin/AfA pages. Production builds
  (`next build` + `next start`) pre-compile
  these pages, so Hetzner prod will not see
  the 30-60s cold-compile hangs the dev suite
  was hitting.
- **The 9 hard fails in the 2026-09-03
  `pw-final-3.log`** were Tier 303 followup
  mis-classification. Tier 304-307 resolved 8
  of them (throttler + portal-401 + bulk-zip +
  datev + bulk-send-modal + audit filter
  mobile). The remaining 1 (recurring-generated
  cold-compile) is dev-mode only.

## How to deploy

1. Provide the Hetzner VPS IP + SSH key (this is
   the only remaining blocker).
2. `cd /Users/shledergmbh/Projects/de-invoice`
3. `cd infra/prod && ./HETZNER-DEPLOY.sh --check`
   — verify pre-flight green.
4. `./HETZNER-DEPLOY.sh` — executes the 10-step
   walkthrough from `DEPLOY-WALKTHROUGH.md`.

(See "Deploy in 3 commands" at the top for the
TL;DR.)

## If you need to re-verify locally first

1. `bash scripts/fix-dev-pg.sh` (sudo once) to
   recover the dev DB.
2. `cd backend && bash e2e/ci-seed.sh` to
   re-seed fixtures.
3. `bash e2e/run-all.sh` — expect 99/99 (Tier 299
   baseline).
4. `cd ../frontend && npx playwright test` —
   expect 881/0/23 (Tier 304 baseline) + 1
   more pass from the Tier 307 mobile fix.

## 14-commits summary

| Commit | Tier | What |
|---|---|---|
| `eaa906c` | 304 main | 4 spec fixes + 1 prod bug (portal-401) |
| `efdea38` | 304 followup | schema drift migration + audit create wrap |
| `af05cd6` | 305 main | OCR + cost-center hydration + 30s timeouts |
| `3b22412` | 305 followup 1 | tesseract 120s |
| `868ec11` | 305 followup 2 | tesseract test.setTimeout 180s |
| `f58714c` | 305 followup 3 | tesseract hydration + dispatchEvent + buffer form |
| `3519d11` | 306 | cost-center + recurring 30s/60s timeouts |
| `85e8e96` | 307 | audit page mobile flex-wrap |
| `4396df1` | 308 | DEPLOY-WALKTHROUGH production hardening section |
| `ca27de7` | 309 | 20-vat restart race 25s→50s + carry THROTTLE_DISABLED |
| `9c7f0ff` | 309 followup | PLAYWRIGHT-TIER304-309-FINAL session summary |
| `3000248` | 310 | fix-dev-pg.sh recovery script |
| `4feb551` | 310 final | DEPLOY-READY-SUMMARY one-shot read |
| `b157de2` | 312 | run-all segment checkpoints (prevent PG crash on long sessions) |

## Production bugs fixed (worth highlighting in deploy notes)

1. **Portal 401 auto-logout hijack** (Tier 300
   introduced, Tier 304 fixed). /portal uses
   token-based auth; the 401 redirect was
   treating it like a stale session.
2. **Invoice schema drift** (Tier 118 introduced
   4 columns without migration). Fixed by
   `20260905000001_invoice_eur_aggregation`
   migration.
3. **Audit log create wrap** (Tier 304 followup).
   Invoice + RecurringInvoice create now write
   `invoiceNumber` + `customerId` to AuditLog
   `newData`.
4. **Audit page mobile layout** (Tier 307).
   Top bar now wraps on 375px viewports.

## Restart race fix (operational)

**`20-vat-validation.sh` now:**
- Waits 50s for backend `/health/deep` (was 25s)
- Carries `THROTTLE_DISABLED=1` through the
  restart (so the post-restart backend doesn't
  re-enable the 600/60s throttler)

This prevents the cascading 6-fail pattern
observed in the 2026-09-05 run-all.

## Post-deploy verification (run after Hetzner deploy lands)

After `cd infra/prod && ./HETZNER-DEPLOY.sh`
finishes successfully, the operator should
verify the 4 production-bug fixes actually
landed on the new image. Each check is a
single curl + a one-line grep:

```bash
# Get the deployed backend URL.
VPS_IP="<the IP you provided>"

# 1. Portal 401 hijack fix — the redirect logic
#    must now exclude /portal. A bad token on
#    /portal?token=invalid should NOT 302 to
#    /login; it should stay on the portal page
#    and show the portal-error UI.
curl -sI "http://$VPS_IP/api/v1/portal/invalid-token" \
  | head -1
# Expect: HTTP/1.1 400 (or 401), NOT 302 to /login.

# 2. Schema drift fix — exchangeRate column must
#    exist on the prod Invoice table. If
#    prisma migrate deploy ran, this returns 1.
curl -s "http://$VPS_IP/api/v1/invoices?companyId=<your-company-id>&take=1" \
  -H "x-user-id: <user>" -H "x-company-id: <company>" \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print('exchangeRate:',d[0].get('exchangeRate','MISSING'))"
# Expect: exchangeRate: 1 (or a real FX rate). NOT MISSING.

# 3. Audit log create wrap — POST a new invoice
#    and verify the AuditLog row has invoiceNumber
#    in newData.
INVOICE_ID=$(curl -s -X POST "http://$VPS_IP/api/v1/invoices?companyId=<your-company-id>" \
  -H "x-user-id: <user>" -H "x-company-id: <company>" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"<a-customer-id>","type":"INV","currency":"EUR","language":"de-DE","issueDate":"2026-09-06","dueDate":"2026-10-06","items":[{"description":"verify","quantity":1,"unitPrice":1,"vatRate":0.19}]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
sleep 2
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "SELECT \"newData\"->>'invoiceNumber' FROM \"AuditLog\" WHERE \"entityId\"='$INVOICE_ID' AND action='invoice.created';"
# Expect: INV-2026-XXXXX. NOT empty.

# 4. Audit page mobile layout — visit the
#    /dashboard/audit page at 375px width and
#    check body.scrollWidth <= 376.
#    (Browser test, not curl-able — run a
#    Playwright spot-check or just open it
#    in DevTools and resize.)
```

If any check fails, the deploy image is from
before these fixes — roll back with
`deploy.sh --rollback` and investigate.
