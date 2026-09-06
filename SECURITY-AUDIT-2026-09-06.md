# SECURITY-AUDIT-2026-09-06.md

> **Snapshot**: full security + code-quality audit
> of the de-invoice repo on commit `84b8086`
> (28 commits in the Tier 304-319 hardening arc).
> Operator should re-run this audit after any
> future Tier ≥ 320 that touches the auth,
> search, or raw-SQL code paths.

## Summary

| Category | Verdict | Notes |
|----------|---------|-------|
| TypeScript | ✅ 0 errors | backend + frontend src + e2e |
| ESLint | ✅ 0 errors | 107 unused-vars warnings (cosmetic) |
| Bash syntax | ✅ 0 errors | 5 deploy/run scripts |
| Hardcoded secrets | ✅ None | `.env*` gitignored, prod uses env vars |
| XSS (stored) | ✅ Fixed (Tier 317) | search service HTML-escapes user text |
| XSS (reflected) | ✅ None | No `{{ userInput }}` direct inject |
| SQL injection | ✅ Guarded (Tier 318) | year + type validated before raw SQL |
| CORS | ✅ Whitelist | `FRONTEND_URL` env var + callback |
| Body size limit | ✅ 10MB | Express `json({ limit: '10mb' })` |
| File upload limits | ✅ 2-10MB | Per-endpoint `limits.fileSize` |
| Rate limiting | ✅ 4 endpoints | login 5/min, register 5/min, forgot 3/hr, reset 10/min |
| Password hashing | ✅ bcrypt(10) | `bcrypt.hash` + `bcrypt.compare` |
| Token storage | ✅ Hashed | Token plain in email, hash in DB |
| Secret strength | ✅ Env-driven | `JWT_SECRET` 64-char (deploy-time enforced) |
| Sensitive logging | ✅ None | Email + error message only, no password / token |
| File upload validation | ⚠️ Manual | MIME type check is per-controller |
| Session timeout | ⚠️ 1h | Hard-coded `expires = now + 60min` |

## Production bugs fixed in this arc

1. **Tier 304**: Portal 401 auto-logout hijack — token-auth path
   was treated as stale session, redirecting customers away
   from portal-error UI. Fix: `api.ts` also excludes `/portal*`.
2. **Tier 304 followup**: Invoice schema drift — Tier 118
   (2026-07-30) added 4 cross-currency columns
   (`exchangeRate`/`eurSubtotal`/`eurTotalVat`/`eurTotal`)
   without a migration. Fix: `20260905000001_invoice_eur_aggregation`
   with `IF NOT EXISTS` + EUR backfill.
3. **Tier 304 followup**: Audit log create wrap — Invoice
   create didn't write `invoiceNumber` to AuditLog newData
   (Tier 174 refactor moved it to a separate SELECT). Fix:
   extension explicitly surfaces `invoiceNumber` + `customerId`
   for Invoice + RecurringInvoice.
4. **Tier 307**: Audit page mobile layout — top bar was
   747px on 375px viewport. Fix: `flex-wrap` on the
   button row container.
5. **Tier 309**: 20-vat restart race — 25s wait was too
   short for cold ts-node compile, and the restart dropped
   `THROTTLE_DISABLED=1`. Fix: 50s wait + carry the env
   through the restart nohup.
6. **Tier 317**: Search snippet XSS — `markTermsInText`
   took raw DB text and wrapped with `<mark>` without
   escaping `<`/`>`/`&` first. Fix: HTML-escape the source
   text before wrapping.

## Code quality bugs fixed

- **Tier 316**: ESLint config was broken (couldn't find
  `eslint-config-next/core-web-vitals`). Fix: minimal flat
  config using `@typescript-eslint/parser` + `react-hooks`.
- **Tier 316**: `useExistingProductInline` was a misleadingly-
  named plain function being called inside an onMouseDown
  callback. Fix: rename to `selectExistingProduct`.

## SQL-injection guards (Tier 318)

The `nextInvoiceNumber()` / recurring generate path uses
`$queryRawUnsafe` with a template-interpolated SEQUENCE name
like `invoice_seq_inv_2026`. Two guards added:
- `year` must be an integer in `[1000, 9999]`
- `type` must match `/^[A-Z]{2,5}$/`

Both throw `BadRequestException` BEFORE the raw SQL is
constructed.

## Known limitations (not deploy blockers)

- **Dev-mode cold-compile flakiness**: OCR scan upload +
  cost-center report + a few admin/AfA pages take 30-60s on
  first hit in `next dev`. Production builds
  (`next build` + `next start`) pre-compile these, so
  Hetzner prod will not see this. The spec-level timeout
  bumps (30s/60s/120s/180s) buy headroom for dev mode
  flakiness.
- **File upload MIME type check**: per-controller
  (attachments accepts images+PDFs, bank-import only
  CAMT XML, etc.). Not centralized — but per-route limits
  ARE explicit (2MB-10MB).
- **Session timeout is hard-coded** to 1 hour in
  `auth.service.ts:100`. Could be moved to env var for
  per-tier tuning, but for an internal accounting app
  1h is reasonable.
- **`fix-dev-pg.sh` requires `sudo`** to chown the bind-
  mount. Dev-only artifact. Hetzner prod uses Docker
  volume, not a bind-mount, so sudo isn't required there.

## Recurring test infrastructure

- **Tier 312**: `backend/e2e/run-all.sh` segment checkpoints
  (every 20 specs, 10s sleep + /health/deep 200 ping).
- **Tier 313**: `frontend/scripts/run-all.sh` mirror pattern
  (every 50 specs, 15s sleep + /health/deep 200 ping).
- **Tier 310 + 311**: dev PG corruption root-cause analysis.
  Long-running shared dev PG is a ticking bomb. 4-day-uptime
  PG + multiple backend restarts = killed mid-write. The
  segment checkpoints prevent this. `scripts/fix-dev-pg.sh`
  is the recovery procedure.

## Deployment

All 28 commits pushed to `main` (`36fc31b..84b8086`). Hetzner
deploy is 100% ready, blocked only on user-provided VPS
IP + SSH key. After deploy:
- `bash infra/prod/HETZNER-DEPLOY.sh --check` (pre-flight)
- `bash infra/prod/HETZNER-DEPLOY.sh` (full deploy)
- `DOMAIN=... VPS_IP=... bash infra/prod/smoke-test.sh`
  (17 checks, includes Tier 304-307 verifications)
- Manual browser verification of the 4 prod-bug fixes

## Re-audit procedure

After any future Tier ≥ 320 that touches auth / search /
raw SQL / file upload code paths, re-run this audit:

```bash
cd /Users/shledergmbh/Projects/de-invoice

# TypeScript
cd backend && npx tsc --noEmit
cd ../frontend && npx tsc --noEmit

# ESLint (now actually works since Tier 316)
cd frontend && npx eslint src/

# Hardcoded secrets
grep -rn "password.*=.*['\"]" backend/src --include="*.ts"
grep -rn "JWT_SECRET\s*=\s*['\"]" backend/src --include="*.ts"

# XSS surface
grep -rn "dangerouslySetInnerHTML\|innerHTML" frontend/src

# SQL injection surface
grep -rn '\$queryRawUnsafe\|executeRawUnsafe' backend/src --include="*.ts"

# File upload size limits
grep -B 1 -A 2 "limits: {" backend/src

# Throttle coverage
grep -B 1 -A 1 "@Throttle" backend/src/modules/auth/
```

If any check returns new content that wasn't in the
2026-09-06 audit, investigate before deploying.
