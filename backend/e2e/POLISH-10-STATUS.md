# Polish #10 — Status

**Date**: 2026-07-28 (post-Tier 112)

## Pass-rate progression

| Stage                                            | Pass | Fail | Rate  | Notes                          |
|--------------------------------------------------|------|------|-------|--------------------------------|
| Before Polish #8                                 |  77  |  22  |  78%  | FAILS=0 bug                    |
| After Polish #8                                  |  86  |  13  |  87%  | +FAILS=0 fix + search_tsv      |
| After Polish #9 partial                          |  77  |  22  |  78%  | 5 tests fixed individually     |
| After Tier 112 (schema)                          |  80  |  19  |  81%  | unchanged                      |
| **After Polish #10 (this pass)**                 |  93  |   6  |  94%  | +13 tests fixed                |

Net Polish #10 win: **+13 tests** (80 → 93 passing).

## Fixes applied (7 tests)

| Test | Root cause | Fix |
|------|------------|-----|
| 34-template-applied | `downloadPdf` endpoint didn't pass templateConfig to `generateInvoicePDF` (Tier 7.5 bug since 2024) | Pass templateConfig as 4th arg; also seed self-sufficient customer+invoice |
| 54-customer-statement-batch | Test needs 100+ customers but 65's cleanup wiped them all | Bulk-seed 120 Tier20 customers via SQL at start |
| 65-tier37-mahnung | (a) SepaDirectDebitMandate→Customer FK blocked cleanup, (b) wiping ALL customers broke 12 downstream tests | Scope cleanup to `name LIKE 'Tier37%'`; also delete SepaDirectDebit* first |
| 72-tier44-cost-center-yearly | No customer exists after 65 cleanup; residue VERTRIEB rows inflated aggregation | Seed Tier44 customer + wipe residue cost-center rows |
| 75-tier48-budget-vs-actual | Same as 72 — residue from prior runs inflated row count | Wipe VERTRIEB/MARKETING/WERKSTATT residue + Payment FK chain |
| 87-tier60-zugferd-embed | Test hardcoded `name LIKE 'Müller%'` but Müller was wiped | Seed self-sufficient Müller customer if missing |
| 95-tier68-global-search | Test queries "ANS" but no customer had "ANS" in name/address | Seed ANS Test Kunde |

## Real bug found

**34-template-applied**: The `GET /invoices/:id/pdf` endpoint was missing the
4th `renderConfig` argument to `generateInvoicePDF`. This was a real
Tier 7.5 regression — the InvoiceTemplate config (font, color, layout)
was NEVER applied to single-invoice downloads, only to the bulk-download
path. Fixed in commit `338683c`.

## Remaining failures (6)

| Test | Status | Why |
|------|--------|-----|
| 22-mahnung-cron | ✗ 1 fail | Timing-dependent: `disabled auto-run sent 8` — 8 reminders were triggered in a prior test run and the count is residue. The default-state baseline-snapshot fix helped but not enough. |
| 42-backup-fire-drill | ✗ 2 fail | `pg_restore FAILED` + row-count mismatch — the prod-env backup test depends on a clean state. Not fixable in the e2e. |
| 44-rbac | ✗ ? | Passes individually (no output). Cascade issue — depends on a specific test user existing. |
| 46-i18n | ✗ ? | 42 missing translation keys across de/en/zh. Pre-existing, requires adding keys to all 3 locales. |
| 80-tier53-credit-note | ✗ 9 fail | `Unique constraint failed (companyId, invoiceNumber)` — the CN number auto-generator conflicts with a prior run. Pre-existing. |
| 81-tier54-pdf-skonto-cn | ✗ 3 fail | Same CN number conflict as 80. Cascade. |

## Patterns used in Polish #10

1. **SepaDirectDebit FK cascade** — Tier 112 added 3 new tables with FK
   to `Customer`. All test cleanups that DELETE FROM Customer now
   need to also DELETE FROM `SepaDirectDebitCollection → Batch → Mandate`
   first, in that order.

2. **Self-sufficient fixtures** — Tests that depend on "any existing
   customer" or "the Müller GmbH customer" need to seed their own
   if the precondition isn't met. Use a fresh `email=...@example.com`
   (timestamped) to avoid the unique-email index.

3. **Baseline-snapshot for residue** — Tests that assert absolute
   values (e.g. "should be exactly 120 customers") break when prior
   tests leave residue. Use `BEFORE=$(...)` + assert `after == before + delta`.

4. **Cost-center residue cleanup** — Tests 72/75 were inflated by
   VERTRIEB/MARKETING/WERKSTATT rows from prior test runs. Added
   explicit DELETE with `costCenter IN ('VERTRIEB', 'MARKETING', 'WERKSTATT')`
   to the cleanup block (plus Payment FK chain since some invoices
   have synthetic payments).

5. **Bulk-seed via SQL** — When a test needs 100+ rows of data
   (e.g. 54's batch statement), inserting via the API is too slow.
   Use `INSERT ... SELECT FROM generate_series(N)` to seed in one
   statement.

6. **Tied-year fix** — The Tier 113 e2e used
   `YEAR=$((2025 + (TS % 3)))` which picked 2025/2026/2027 randomly.
   Combined with the `saleDate.slice(0,4) === year` filter, this
   could filter out transactions. Pinned `YEAR=2026` + adjusted
   `acquisitionDate` / `saleDate` pairs so all seeded transactions
   are within the 1-year Spekulationsfrist.

## What's next

- Polish #11: tackle the 6 remaining failures (CN number conflict,
  i18n missing keys, prod-env backup test)
- OR Tier 115 (next feature)
