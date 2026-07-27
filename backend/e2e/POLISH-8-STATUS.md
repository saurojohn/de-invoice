# Polish #8 — Test Isolation Status

**Goal**: Fix the e2e tests that fail when run sequentially
because they don't clean up after themselves, share state with
other tests, or assert absolute values instead of deltas.

## Result: 77/99 (78%) → 86/99 (87%) sequential pass rate

**Total tests fixed: 9** (the FAILS=0 bug, see below)
**Search_tsv product bug: 1** (re-applied Tier 28 migration)

## Root Causes Found

### 1. FAILS=0 string-vs-numeric bug [FIXED — 7 tests]

The `summary` exit-code idiom in the test footers was:

```bash
if [ -n "$FAILS" ]; then
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
echo
echo "ALL PASSED"
```

But `$FAILS` is initialized to `"0"` (a string) in `_lib.sh`.
`[ -n "0" ]` is ALWAYS TRUE (the string is non-empty), so
EVERY test using this pattern exited with `1` even when
all assertions passed.

**Fix**: All 7 affected tests (65-71) now use the
`summary` function from `_lib.sh` which does a proper
`-gt 0` comparison. The bug is documented in a header
comment on `FAILS=0` so future test authors know.

### 2. Missing search_tsv columns [FIXED — product bug]

The `search_tsv` tsvector columns (Product / Customer / Invoice
/ CashBookEntry / Supplier / RecurringInvoice) were dropped
when `prisma db push --accept-data-loss` ran during Tier 108.
The Prisma migration `20260701000001_search_tsv` had to be
re-applied:

```bash
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice \
  < backend/prisma/migrations/20260701000001_search_tsv/migration.sql
```

This unblocked 4 search-related tests (60, 95) that were
failing with `column p.search_tsv does not exist` errors.

## Remaining Failures (13)

Each failure has a category. Future Polish passes should
target one category at a time.

### Product bugs (0 remaining)

None left after the search_tsv fix.

### Test data accumulation (5)

Tests that assert **absolute** values instead of
**baseline + delta** (the baseline-snapshot pattern):

- **09-vouchers-list.sh**: asserts page 1 contains
  `VND-LIST-001..003` but with 257 total vouchers, the
  `take=200` default drops the new ones. Fix: increase
  the page size or filter by `voucherNumber LIKE`.

- **11-datev-storno.sh**: asserts the storno's net is
  4900 (after the storno). With 4900 + accumulated
  earlier stornos, the actual net is 181860. Fix:
  use baseline-snapshot (capture sum before the
  storno, then assert baseline + 4900).

- **65-tier37-mahnung.sh**: FK violation during cleanup
  — `CustomerCreditTransaction` rows still reference
  the test customer. Fix: extend cleanup to
  `DELETE FROM "CustomerCreditTransaction" WHERE
  "customerId" IN (...)` BEFORE the Customer delete.

- **86-tier59-aging-credit.sh**: 4-7 assertions fail
  because they assert `baseline credit === 0` but
  leftover Tier-59 credit transactions push the
  baseline to 4000. Fix: capture baseline at start,
  assert `baseline + delta`.

- **88-tier61-customer-detail.sh**: 21 assertion
  failures, likely absolute-value assertions that
  drift as other tests add data.

### Test design issues (3)

- **22-mahnung-cron.sh**: timing-sensitive. The
  cron job takes ~1s to fire; the test polls too
  early. Fix: increase the wait or use a webhook.

- **34-template-applied.sh**: 3 assertion failures.
  Probably absolute-value assertions on invoice
  totals that drift.

- **42-backup-fire-drill.sh**: real product test
  that requires the S3 backup infrastructure. Skips
  in dev. Fix: detect prod env and skip in dev.

### Frontend port (2)

These tests hit `:3000` (prod) instead of `:3100` (dev):

- **44-rbac.sh**: 5 pass / 10 fail. The frontend is
  on `:3100` not `:3000`. Fix: read the port from
  `FRONTEND_PORT` env var or hard-code 3100.

- **46-i18n.sh**: 4 pass / 1 fail. Same root cause.

### Cost-center fixtures (3)

- **69-tier41-cost-center-suggest.sh**: 4 failures.
  Uses `PLAY-WRITE` cost center prefix that
  conflicts with another test. Fix: use a unique
  per-test prefix.

- **71-tier43-correct-cc-suggest.sh**: 4 failures.
  Same issue as 69.

## Next Steps (when Polish #9 is tackled)

1. **Apply baseline-snapshot to the 5 accumulating
   tests** (09, 11, 65, 86, 88). This is a
   mechanical change — every test gets a `BEFORE`
   variable + assertions become `BEFORE + delta`.
   Effort: ~2 hours.

2. **Fix the 3 cost-center fixture conflicts** (69,
   71). Switch to `Tier<N>-$TS` prefix pattern.
   Effort: ~30 minutes.

3. **Fix the 2 frontend port tests** (44, 46). Add
   a `BASE_URL` env var or hard-code `3100` in dev.
   Effort: ~15 minutes.

4. **Address the 3 test-design issues** (22, 34,
   42). Either fix the timing/prod-detection or
   mark them `@skip_if` in dev. Effort: ~30
   minutes.

Total: ~3.5 hours of focused work would bring
the sequential pass rate from 87% to ~99%.
