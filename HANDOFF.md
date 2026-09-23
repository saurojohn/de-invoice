# de-invoice — Handoff to Claude (2026-09-11)

**This file is the first thing a new Claude session should read.** It orients you
to the project state, the most recent changes, the known blockers, and the
exact commands + docs you need to be productive.

---

## 1. Project snapshot

- **Stack:** Next.js 15.5.7 + NestJS 11 + Prisma 5 + PostgreSQL 16 (Docker)
- **Repo:** github.com/saurojohn/de-invoice, branch `main`. Tiers 344–433 are
  in `git log`; §8 records what each learned. (Snapshot refreshed Tier 432.)
- **Domain:** German accounting / invoice web app (§ 146 AO GoBD compliant)
  - All UI text in **German** (operator-facing). PDF output in German. i18n:
    de / en / zh (de is source of truth).
  - Full accounting features required: Raten, Rabatte, Mahnung, DATEV,
    UStVA, UStJA, ELSTER, Anlage S/V, GoBD-Archiv, Berater-mode, audit log
    hash chain. **No simplified MVP** — every feature must be complete.
- **Test counts (last green CI, run 35854661681 / commit `a585803`, Tier 432):**
  - Backend e2e: **220 passed / 0 failed / 1 skipped** of 221 specs — 100
    two-digit + 121 three-digit (Tier 432 added `221-tier432-sepa-datev.sh`,
    Tier 431 `220-tier431-zahlungen-ohne-umweg.sh`,
    Tier 430 `219-tier430-zahlungsmeldung.sh`,
    Tier 429 `218-tier429-ratenplan.sh`,
    Tier 428 `217-tier428-zahlungsziel.sh`,
    Tier 427 `216-tier427-afa-monate.sh`,
    Tier 426 `215-tier426-bilanz-open-amounts.sh`, Tier 425 `214-tier425-kassenbuch.sh`,
    Tier 424 `213-tier424-document-scope.sh`,
    Tier 423 `212-tier423-datev-buchungsstapel.sh`,
    Tier 422 `211-tier422-skonto-settlement.sh`,
    Tier 421 `210-tier421-verzugszinsen.sh`,
    Tier 420 `209-tier420-gobd-archive-issued.sh`,
    Tier 419 `208-tier419-expense-net-cost.sh`,
    Tier 418 `207-tier418-pdf-pagination.sh`,
    Tier 417 `206-tier417-ustva-kennzahlen.sh`,
    Tier 416 `205-tier416-credit-note-tax.sh`,
    Tier 415 `204-tier415-amounts-in-cents.sh`,
    Tier 414 `203-tier414-zugferd-cii.sh`,
    Tier 413 `202-tier413-invoice-pdf-discount.sh`,
    Tier 412 `201-tier412-xrechnung-en16931.sh`,
    Tier 411 `200-tier411-net-revenue.sh`,
    Tier 410 `199-tier410-zero-vat-rate.sh`,
    Tier 409 `198-tier409-tax-breakdown.sh`,
    Tier 408 `197-tier408-bulk-audit.sh`,
    Tier 407 `196-tier407-audit-coverage.sh`,
    Tier 406 `195-tier406-transaction-audit.sh`,
    Tier 405 `194-tier405-keepalive.sh`;
    Tier 400 added `190-tier400-session-auth.sh`,
    Tier 402 `191-tier402-production-auth-mode.sh`, which restarts the backend
    with `ALLOW_HEADER_AUTH=0` and back, Tier 403
    `192-tier403-session-lifecycle.sh` and Tier 404
    `193-tier404-invoice-numbering.sh`; Tiers 391-398 extended existing ones —
    50-webhooks.sh, 21-system-errors.sh, 08-bank-import.sh, 17-email-send.sh,
    179-tier378-cross-tenant-ids.sh, 19-bulk-import.sh, 148, 157, 33 — and made
    92 self-sufficient; no new spec files); before Tier 361 only the two-digit ones ever ran.
    `QUARANTINE` empty. The one skip is `16-dark-mode.sh` (no frontend in the e2e
    job); since Tier 371 skips exit 77 and are listed, not counted as passes.
    Spec 172 (Tier 370) guards the harness itself: no spec may use `_lib.sh`
    assertions while exiting on its own counter, or discard `summary`'s result.
    Spec 170 asserts on the runner that the audit chain verifies with no re-hash
    and survives concurrent writes (Tier 367); spec 171 (new in Tier 368) asserts
    the auth audit rows exist at all and are signed — nothing had ever asserted
    on them, which is how a failed login for an unknown e-mail went unaudited.
  - Playwright: **930 passed / 0 failed / 0 skipped / 0 flaky** (Tier 428's
    run had one flaky — `list-pages.spec.ts` "Invoices list renders without
    console errors" expected the empty state and saw a populated list, then
    passed on retry). 930 tests (922 since Tier 390's
    page tests; +4 in Tier 401's session-cookie spec; +2 in Tier 413's
    invoice-discount-row spec; +2 in Tier 415's invoice-form-totals spec). Tier 365 turned the last 4 skips into real
    tests; Tier 365b fixed the one flaky test (`bwa-quarterly-tier163`).
    Tier 369 removed 28 silent-skip call sites — three intentional ones remained
    (two since Tier 381, which turned the webhook replay skip into a real wait),
    each with its reason written into the code — and Tier 369b closed the
    `webhook.requeue` race that surfaced as `911 passed, 1 flaky` in run
    34696678293.
  - `tsc --noEmit` and `eslint . --max-warnings 0` clean, backend + frontend
- **CI runs again.** The Tier 363 push (run 34610316607) was never started —
  GitHub: "recent account payments have failed or your spending limit needs
  to be increased". After the account was fixed, run 34617401242 (Tier 364,
  which includes 363) passed all 6 jobs: backend e2e 7 min, Playwright 21 min.
  Minutes are finite: docs-only commits use `[skip ci]`.
- **Reproduce CI locally:** `backend/scripts/local-ci-stack.sh run` (backend
  e2e) and `run-playwright [spec…]` — see §8.

## 2. Branch state

`main` is pushed; there is no work in progress between tiers. `git log --oneline -10`
is the reliable view — this file does not pin a HEAD any more (it went stale
every tier). `tmp-pw-fail/` (old Playwright failure artifacts) is gitignored
since Tier 344; leave it unless the user wants it gone.

## 3. Session arc, Tiers 339 → 343 (history; later tiers are in §8)

The session that produced `4a6b08a` was a 4-day CI-stabilization arc that
took the suite from "all jobs fail" to "all jobs green". For full context:

| Tier | commit | What it fixed |
|---|---|---|
| 333-338 | many | CI infra + 17 spec bugs + 1 deadlock + schema-drift fixup migration (Run #301→#312: e2e 84/99 → 99/99, Playwright 857/31/21 → 261/0/0) |
| **339** | `a644217` | Full audit doc, 0 critical/high (3 LOW deferred). `AUDIT-TIER339-2026-09-08.md`. |
| **340** | `564d1ce` | 3 PW spec hydration fixes (recurring-generated beforeAll race + bulk-send date input hydration + invoice-tax radio click hydration) |
| **341** | `3982a34` | 3 more PW race fixes (mobile auth cookie copy + mahnungen loading wait + recurring pg_isready wait) |
| **342** | `047344d` | rec147 stderr capture via `execFileSync` + stdin pipe — **revealed the true error that retry+pg_isready couldn't** |
| **343** | `4a6b08a` | rec147 SQL fix: `sortOrder` → `position` (schema column name drift — Tier 337 lesson applied to specs themselves, not just `ci-seed.sh`) |

The 3 LOW deferred items from Tier 339:
- L1: `stableStringify` doesn't handle BigInt / Prisma.Decimal — currently no
  audited model uses BigInt/Decimal so it's a latent issue, not active.
- L2: `parseCsvLine` in ECB rates service is naive split-on-comma — ECB's
  CSV has no embedded commas today; failure mode is loud (throws), not silent.
- ~~L3: 15 e2e scripts (154-247) lack `set -euo pipefail`~~ — **CLOSED in
  Tier 345. The finding was wrong on three counts:** it was 16 files not 15;
  they inherited `set -uo pipefail` from `_lib.sh` so exposure was nil; and
  the recommended `-e` would have **broken** the suite (see next bullet).
  Tier 345 added a local `set -uo pipefail` to all 16 for consistency.

## 4. Critical docs to read (in order)

1. **`README.md`** (1201 lines, trilingual DE/EN/ZH header) — quickstart, architecture
2. **`backend/AGENTS.md`** (103 lines) — project-specific backend lessons
   (UStVA, password reset, PDF currency rules, Prisma gotchas). **THIS IS THE
   REAL "MEMORY" FOR THIS REPO** — there is no in-repo equivalent.
3. **`frontend/AGENTS.md`** (5 lines) — points at Next.js 15.5.7 docs, warns
   "This is NOT the Next.js you know."
4. **`AUDIT-TIER339-2026-09-08.md`** (253 lines) — most recent audit snapshot
5. **`DEPLOY-READY-SUMMARY.md`** (278 lines) — what to do next when the
   Hetzner block lifts
6. **`DEPLOY-WALKTHROUGH.md`** (462 lines) — 10-step deploy, all runbooks linked
7. **`PLAYWRIGHT-TIER304-309-FINAL.md`** + **`PLAYWRIGHT-ROUNDS-11-34-SUMMARY.md`**
   + **`PLAYWRIGHT-TIER290-294-FINAL.md`** — Playwright arc history
8. **`SECURITY-AUDIT-2026-09-06.md`** (190 lines) — security + code-quality
   snapshot at commit `054a5a0`

Operational scripts:
- **`infra/prod/HETZNER-DEPLOY.sh`** (380 lines) — single-command Hetzner
  deploy (also has `--check` pre-flight mode)
- **`infra/prod/smoke-test.sh`** (300 lines) — 17-check post-deploy verification
- **`infra/prod/HETZNER-DEPLOY.md`** (495 lines) — full Hetzner runbook
- **`infra/prod/RUNBOOK.md`** (590 lines) — operator day-to-day
- **`infra/prod/DR-TEST.md`** (316 lines) — quarterly disaster-recovery drill
- **`infra/prod/SECURITY.md`** (144 lines) — running security checklist
- **`scripts/fix-dev-pg.sh`** (99 lines) — dev PG corruption recovery (needs
  `sudo` for the chown step)
- **`backend/scripts/audit-rehash.ts`** (114 lines) — one-off tool to
  re-hash the audit-log chain in `seq` order (Tier 367; only needed if the
  chain really is corrupted — a healthy chain verifies without it)

## 5. CI configuration (`.github/workflows/ci.yml`, 595 lines, 6 jobs)

- **Jobs:** `backend-typecheck`, `backend-lint`, `frontend-lint`,
  `frontend-typecheck`, `e2e`, `playwright` — all in parallel, no `needs:`, no
  artifact handoff (e2e and playwright each run `ci-seed.sh`). Normal runtime:
  lint/typecheck < 1 min, e2e ~8 min, playwright ~27 min.
- **Triggers:** push to `main` + pull_request to `main`
- **`concurrency.cancel-in-progress: true`** is set — a new commit cancels
  the prior run on the same ref.
- **`timeout-minutes` on every job** since Tier 364 (15 / 15 / 15 / 15 / 30 /
  60; `release.yml` 45). Before that each job could run 360 minutes.
- **All `actions/*` pinned to `@v7`** since Tier 345 (was `@v4`, which
  declares `runs.using: node20` — GitHub deprecated that runtime and was
  force-running them on Node 24). **Gotcha: `actions/upload-artifact@v5` is
  still node20** — v6 is the first node24 release for that action, unlike
  checkout/setup-node where v5 already moved. Verified non-applicable before
  bumping: no `pull_request_target`/`workflow_run` (checkout v7 fork-PR
  restriction), no `packageManager` field in either package.json and an
  explicit `cache: npm` (setup-node v5/v6 auto-cache changes), and
  `runs-on: ubuntu-latest` is GitHub-hosted so upload-artifact v6's
  runner >= 2.327.1 requirement is met. `docker/*` actions in `release.yml`
  were left alone — not flagged, third-party release cadence.
- **5 `if:` clauses** — artifact uploads only. No conditional test-skipping.
- **No commented-out steps**, no TODO/FIXME in the workflow file.

## 6. Schema + migrations

- **28 migrations** in `backend/prisma/migrations/` (oldest:
  `20240101000000_baseline`, newest: `20260923000001_payment_notices`
  (Tier 430); Tier 428 `20260922000003_customer_payment_terms_nullable`;
  Tier 425 `20260922000002_cashbook_payment`, Tier 423
  `20260922000001_datev_personenkonten`).
- **62 models** in `backend/prisma/schema.prisma`. CI workflow enforces
  `TABLE_COUNT >= 62` after `db push` (`.github/workflows/ci.yml:254`).
- **Raw-SQL migrations:** 1 — `20260701000001_search_tsv/migration.sql`
  (Tier 28 full-text search with snippet highlight; uses `IF NOT EXISTS`
  for idempotency; applied via `prisma db execute --stdin`).
- **Baseline migration is incomplete** (`20240101000000_baseline` only
  creates 38/62 tables) — the remaining ~24 were created over time by
  `prisma db push`. Current hybrid apply order: `prisma db push` then
  pipe `search_tsv/migration.sql` into `prisma db execute --stdin`.

## 7. Tests

- **Backend e2e:** 169 specs run by `backend/e2e/run-all.sh` (100 two-digit, 69
  three-digit; `dryrun-tier247-validate.sh` is manual). Seed driver
  `backend/e2e/ci-seed.sh` = 640 lines. `run-all.sh` has a per-spec
  `SPEC_TIMEOUT` watchdog and a `QUARANTINE` list (empty) — see §8, Tier 361.
- **Playwright:** 169 spec files in `frontend/e2e/`;
  config `frontend/playwright.config.ts` = 129 lines.
  **No root-level `playwright.config.ts`** — only the frontend copy.
- All bash scripts use `set -uo pipefail`. 46 historical scripts
  had a "ALL PASSED" bug that didn't propagate failure to exit code;
  Tier 207 fixed them with `summary` helper calls. **Future scripts
  must end with `summary`**, not `echo "ALL PASSED"`.
- **NEVER add `-e` to an e2e spec.** `_lib.sh` is a failure-*counting*
  harness: `fail()` increments `FAILS`, and the closing `summary` turns
  `FAILS` into the exit code. `set -e` aborts at the first failing command,
  so `summary` never runs, the remaining assertions never execute, and the
  per-spec failure count is lost. Convention is `set -uo pipefail`; the
  22 specs still carrying `set -euo pipefail` are a historical inconsistency
  — do not copy them.
- CI smoke-test pattern for backend: `bash backend/e2e/run-all.sh`
  with `SEGMENT_SIZE=20 SEGMENT_SLEEP=10` (Tier 312 default).
  For frontend: `bash frontend/scripts/run-all.sh` with
  `SEGMENT_SIZE=50 SEGMENT_SLEEP=15` (Tier 313 default).

## 8. TODO + known issues

### Code TODOs (intentional, do not "fix")
- `backend/src/modules/fints/fints.service.ts:446` — TODO to parse
  HIRMG/HIRMS. FinTS real-mode is a stub; mock mode is the only working
  path.
- `backend/src/modules/accounting/ebilanz.service.ts:402` — emits
  `TODO (manuell)` string for BMF positions. This is **intentional** —
  those positions must be supplied by the tax advisor in real life.

### Playwright silent-skip coverage hole (Tier 346 partial → closed in Tier 369)

**Closed in Tier 369; the counts below are historical and were never measured
with a pattern that matched the code.** The real figure was 24 single-line
`test.skip(true, …)` calls plus a multi-line form and a bare `test.skip()` that
the original sweep missed entirely; 28 call sites were changed and exactly three
intentional skips remain. See the Tier 369 section below.

As counted at the time, the suite had **62 runtime `test.skip(true, ...)` calls
across 29 spec files**. 35 of them fired on "element not found / not present /
may be loading" — i.e. a hydration race or a real UI regression is converted into
a **silent skip**, and CI still reports green. The skipped set is not
stable run to run (Tier 344 skipped 28, Tier 345 skipped 29, with 3 in and
2 out), so "884 passed" is not a fixed number.

Root anti-pattern — `.count()` does NOT wait, unlike a web-first assertion:

```ts
await page.waitForLoadState("networkidle")   // does NOT imply hydrated
const el = page.getByTestId("x")
if ((await el.count()) > 0) { await expect(el).toBeVisible() }
else { test.skip(true, "x testid not found") }   // silently green
```

Correct form (retries internally until the timeout):

```ts
await expect(page.getByTestId("x")).toBeVisible({ timeout: 15000 })
```

**Tier 346 converted 18 of the 35**, in the 8 page-smoke specs whose target
testids were verified to render unconditionally in `frontend/src`.

**Tier 348 took the "masking" skips to 0** (35 -> 18 -> 8 -> 0). The last 8
were races, not missing data, so each needed its own fix:

- `pdf-berater-stamp-tier246` (3) + `webhook-dead-letter-tier198` (2):
  same `.count()`-is-instantaneous race -> web-first assertion. The
  webhook comments blamed "requeue from test 2", which was wrong —
  `seedTag`/`deliveryId` are scoped inside each `describe`, so the two
  blocks never shared a row. The real cause was that `dead-letter-card`
  becomes visible while the row list is still being fetched.
- `admin-activity-log-tier202` (1): a fixed `setTimeout(1500)` then one
  GET, skipping if the delivery row had not landed -> poll 20x250ms then
  assert. Same budget, returns as soon as the row appears, fails if it
  never does.
- `aging-credit` (1): guard was unreachable (its `beforeAll` does
  `expect(res.status()).toBe(201)` and throws) -> kept as an assertion so
  a broken invariant fails loudly instead of skipping.
- `invoice-create-tier223` (1): **the worst one.** It looked for
  `invoice-item-description-0` / `-quantity-0` / `-unitPrice-0` and
  skipped when absent. Those testids have never existed in
  `create/page.tsx` — so "5-8. add item + submit creates invoice and
  redirects", the core create-invoice path of an invoicing app, silently
  skipped from Tier 223 onward and never tested item entry or submission
  even once. The row's real testids are `item-quantity` and
  `item-unit-price` (non-indexed, used with `.first()` by
  invoice-duplicate-check-tier150 and invoice-clone-as-draft-tier160);
  the description input had none, so Tier 348 added `item-description`
  to match its two siblings. **Do not rename those two** — the other two
  specs depend on the current names.

**`page.request` does NOT carry `contextWithAuth`'s auth** (Tier 351c).
`contextWithAuth()` sets **cookies** named `x-user-id` / `x-company-id`
plus localStorage. `HeaderAuthGuard` reads
`req.headers['x-user-id']` (`header-auth.guard.ts:29`) — cookies travel as
`Cookie:`, never as `x-user-id:`. Browser-driven steps still work because
`lib/api.ts` injects the headers from localStorage, but **`page.request.*`
bypasses the browser entirely**, so it gets 401 with a
`{statusCode, message}` body. `listBody.data || []` then yields `[]` and
the test skips itself on "no data" — the exact failure mode
`backend/AGENTS.md` describes for raw `fetch`.

That is why `installment-plan.spec.ts`'s two list-driven tests never ran,
even after Tier 351 seeded the plan they were looking for: the calls at
:222 and :290 omitted `ADMIN_HEADERS`, while the setup calls in the same
file always passed it. **Always pass the auth headers to `page.request.*`
explicitly** — a suite-wide scan says every other call site already does.

**Tier 351b found a real production bug behind the always-true skip.**
Removing `ratensplan-suggestion`'s guard made both tests FAIL, not pass:
the Ratenplan banner genuinely never rendered. Cause, in
`dashboard/invoices/[id]/page.tsx`: the `Promise.all` fetched
`[invoice, payments, plan, internal-notes, attachments, suggestion]` but
destructured `([inv, pmts, plan, sug, notes, atts])` — **the last three
rotated by one**. So `ratensplanSuggestion` held the internal-notes array
(`.eligible` forever `undefined`, banner never shown), `internalNotes` held
the attachments, and `invoiceAttachments` held the suggestion object, which
fails `Array.isArray()` and was coerced to `[]` so Belege always looked
empty. Three user-visible bugs from one line. Verified fixed in a real
browser: the banner renders with "1785.00 EUR liegt ueber dem Schwellenwert
von 500 EUR". That same check also confirmed `installment-plan-card` and
`installment-plan-create-button` are present *simultaneously* — the card
really is the unconditional container.

**Two seed traps this tier hit, both already documented above and both
worth re-reading before touching ci-seed.sh:**
1. Backticks in a comment inside a `<<SQL` heredoc get executed. I wrote
   `` `customerPlan` `` in a new comment and the seed printed
   "customerPlan: command not found" — the exact Tier 347 trap, made while
   writing a comment about something else. Local run caught it.
2. Do not hang shared fixtures on the shared customer. The plan was first
   attached to `b3f7b274` (BWA Test Kunde); `getSuggestion()` rejects an
   invoice when ANY active plan exists for its customer, so that would have
   made every invoice of the most-used test customer permanently ineligible
   for the banner. It now has its own customer
   (`9a7e11a5-...c1`, "Ratenplan Test Kunde GmbH") and its own invoice.

**Global-count assertions are landmines for anyone adding seed data.**
`78-tier51-installment-plan.sh` asserted the company-wide active-plan count
was exactly 1, which only held because ci-seed seeded no plans; section 5h
broke it instantly. Fixed to count only the plans that script creates,
keyed by its own invoice ids. Grep for similar
`assert_eq "... count"` before adding rows.

**Tier 351: skips 11 -> 5, and another wrong in-code diagnosis.**

`ratensplan-suggestion`'s two tests branched on
`page.locator('[data-testid="installment-plan-card"]').count() > 0` and
skipped with "invoice already has an installment plan from a prior run".
That could never be false: the card is the **unconditional container**
(`invoices/[id]/page.tsx:1970`) whose own comment says it "shows the
schedule when a Ratenplan is attached; otherwise offers a one-click
button". So both tests had skipped on every run since Tier 65. There was no
shared state to guard either — the `beforeAll` POSTs a fresh EUR 1500
invoice per run. Guards removed, assertions kept. **The real signals are
`installment-row` (`:2060`) for has-a-plan and
`installment-plan-create-button` (`:1987`) for no-plan** — never the card.

`ci-seed.sh` also seeded **zero Suppliers and zero InstallmentPlans**, so
four more tests skipped on "no suppliers in the DB to search against" /
"no 3-Raten plan in DB yet" / "no plan with open Rate" / "no installment
plans in DB". Section 5h now seeds 2 suppliers and one 3-Rate plan, all
three Raten `open`. Two details that matter there:
- `InstallmentPlan.invoiceId` is `@unique`, so the plan gets its own
  dedicated invoice (`INV-RATEN-001`) rather than sharing one another spec
  may need plan-free.
- the Tier 168a test **pays** a Rate, so the `ON CONFLICT` clauses reset
  `status`/`paidAmount`/`paidAt`; without that a re-seed against the same
  DB leaves every Rate paid and the open-Rate lookup finds nothing.

**The 5 remaining skips are deliberate, not gaps** — do not "fix" them by
seeding:
- `vies-batch-tier134:61` is a static `test.skip('...')` declaration, with
  a documented reason: VIES rate-limits back-to-back supplier+customer
  batch runs. Re-enabling needs a 60s gap or a fresh backend per batch.
- `recurring-email-tier129:52` and `recurring-generated-invoices-tier147:284`
  are unconditional skips that delegate coverage elsewhere (a manual Tier
  129 run; the backend response-shape test).
- ~~`recurring-invoices.spec.ts:191`~~ — **diagnosed and fixed in Tier 352.**
  It waited for `recurring-new-button` and then immediately `.count()`-ed
  the run-now buttons. Those are not on the same clock: the new-button is
  page-header furniture rendered unconditionally
  (`recurring-invoices/page.tsx:631`), while the cards holding
  `recurring-run-now` render only inside the loaded branch of
  `{loading ? ... : ...}` (`:669` / `:701`). The count therefore always ran
  during loading, always saw 0, and the test never executed its real
  assertion. Reproduced locally: API returning 1 active template, test
  still skipped.

  Untangling whether a template is even present at that point took a
  cross-spec chain, worth recording because it is not visible from any one
  file:
  `ci-seed.sh` creates `33333333-cccc-...-0001`;
  `recurring-email-preview-tier136` deletes it **by name**
  ('Tier 136 Wartungsvertrag') and installs its own `tier136-tpl-001`;
  `recurring-generated-invoices-tier147` deletes `tier136-tpl-001` and
  **re-creates** `33333333-cccc-...-0001`. All three sort before
  `recurring-invoices`, so the ci-seed template is back and active by then.

**Backend eslint: 0 errors, 0 warnings, enforced** (Tier 355 set it up at a
ratchet of 45; Tier 356 worked through all 45 and dropped the job to
`--max-warnings 0`, matching the frontend). `backend/eslint.config.mjs`
mirrors the frontend's minimal setup — no type-aware rules, tsc owns that.
Two config notes: `PDFKit` and `Express` are declared readonly globals
(TypeScript namespace types `no-undef` cannot see, like `React` on the
frontend), and `no-empty` uses `allowEmptyCatch`.

**Underscore-prefixed variables in the backend are deliberate, not noise.**
Where a write-only variable was the only surviving evidence that some
output was intended, Tier 356 kept it with `_` and a comment rather than
deleting it. Do not "tidy" these away:

| Where | What the variable shows |
|---|---|
| `reports/ustja.service.ts` | per-rate / igE / §13b Vorsteuer accumulated under a `// Vorsteuer (Kz 56-66)` comment (BMF Vordruck lines) but only the *total* is emitted |
| `accounting/anlage-kind.service.ts` | `Kindergeld` / `Freibetrag` per child computed, never reported |
| `recurring/recurring.service.ts` | a skip sentinel whose own comment describes "commit, then throw OUTSIDE" — the throw half was never wired up, so callers are not told a run was skipped |
| `vat-validation/vat-reverify.scheduler.ts` | a local `transitions` counter incremented but never read, while the scheduler separately reports a `stats.transitions` — looks like a missed wiring |
| `reports/bwa.service.ts` | `afaMonat`, commented "filled below", nothing reads it |
| `signing/signing.service.ts` | `digestMatches`, the byte-for-byte digest comparison, deliberately unused — see below |

**Two findings worth a decision from the operator / Steuerberater, not from
code:**
1. **PDF signature verification is structural, not cryptographic.**
   `signing.service.ts` confirms "a parseable PKCS#7 SignedData with a
   32-byte SHA-256 messageDigest attribute and a signer cert" — it does
   **not** check the digest against the content, and does not verify the
   signature against the cert's public key. The in-code comment states this
   is intentional (node-forge DER re-encoding quirks; "strict byte-for-byte
   verify can be a v2 improvement"). For a GoBD / §146 AO feature that is a
   real limitation.
2. **The Vorsteuer / Kindergeld breakdowns above** may be missing lines on
   the annual returns.

**Upload validation is by file EXTENSION, not MIME type.**
`storage.service.ts` had a MIME whitelist that was never used — the live
check is `allowedExtensions`, and the two lists had drifted (`.tif/.tiff`
existed only in the extension list). The dead MIME list was removed in Tier
356; the extension check is unchanged.

**A CI failure is not automatically your regression — check the clock.**
Tier 356's push went red on `79-tier52-skonto.sh` with
`403 Rechnung kann nur am Ausstellungstag bearbeitet werden`, right after a
tier that touched 30+ backend files. It was not the regression it looked
like. The spec derived "today" by adding a **hardcoded
`timedelta(hours=2)`** to the server's UTC timestamp, under an in-code
comment asserting "Backend runs in Europe/Berlin (CEST = UTC+2)". On a
GitHub runner the backend runs in **UTC**, and `isToday()`
(`invoice.service.ts`) uses `new Date()` — the machine's local zone. So the
+2 pushed the computed date a day ahead **only when CI ran between 22:00
and 24:00 UTC**. The failing run executed that spec at 22:02; the four
green runs before it ran at 19:07-21:13. A two-hour window per day.

Fixed with `utc.astimezone()` (no argument), which converts to the local
zone of the machine running the script — the same machine as the backend —
so the two agree in CI and locally, and it follows DST instead of assuming
summer. **Grep for `timedelta(hours=` before trusting any date-sensitive
spec**; this was the only remaining one.

**Deleting by variable NAME picks the wrong occurrence.** This bit twice —
Tier 349 (`created` in assets-afa.spec.ts) and again in Tier 356
(`where`, `stamp`, `year`). A name-based search finds the *first*
declaration, which is usually the one still in use, while eslint flagged a
later one. **Always delete by the line number eslint reports, iterating
from the bottom of the file up so earlier line numbers stay valid.** tsc
catches the damage, but only after the fact.

**Backend e2e can now run against a throwaway DB too** (Tiers 355 + 357).
Tier 353 did the Playwright side and missed the backend. **Tier 355 then
reported "570 call sites, 0 remaining" — that was wrong.** It replaced only
the exact string `docker exec de-invoice-postgres`, and its "0 remaining"
check grepped for that same string, so the verification was circular. It
missed **254 more** call sites where a flag sits between `exec` and the
name — `docker exec -i de-invoice-postgres` (252) and
`docker exec -e PGPASSWORD=... de-invoice-postgres` (2) — across 61 files.
Locally those still hit the dead dev container, returned nothing, and left
IDs like `CUST_ID` empty, which cascaded into 27 `500 Related resource not
found` responses. Tier 357 fixed them with a flag-agnostic pattern and
verified by grepping for the **container name itself** (excluding comments
and the `PG_CONTAINER="${PG_CONTAINER:-de-invoice-postgres}"` defaults):
zero left. Also fixed in Tier 357: `frontend/scripts/run-all.sh`'s
pre-flight check, and `scripts/backup.sh`, which picked its `pg_dump`
target by the hardcoded name — so under a throwaway DB it either fell back
to a host dump on :5432 or, if the dev container was up, dumped the *dev*
database instead of the one under test. (`scripts/backup.sh` is dev-only;
production uses `infra/prod/backup.sh` and `de-invoice-postgres-prod`.)
`scripts/start-backend.sh` re-exports `DATABASE_URL` (Tier 355), because
e2e spec 20 restarts the backend through it mid-run.

**Lesson: verify a replacement by searching for what should be gone, not
for the pattern you replaced.**

**Use `backend/scripts/local-ci-stack.sh` for any local backend e2e run.**
It mirrors the CI `e2e` job step by step — fresh `postgres:16`,
`prisma db push` **plus the `search_tsv` raw-SQL migration** (hand-typed
local runs kept skipping this), the >= 62 table check, the backend started
with CI's exact env (`NODE_ENV=test`, `SMTP_HOST=`, `STORAGE_PATH`,
`VIES_MOCK`, `EXCHANGE_RATES_MOCK`, `THROTTLE_DISABLED`, CI's fixture
`FINTS_PIN_ENC_KEY`), then `ci-seed.sh`. It also points `ATTACHMENT_PATH`
at the test storage so the backup fire-drill does not copy the developer's
real `~/data/invoice-system` into `/tmp`. It refuses to run with
`PG_CONTAINER=de-invoice-postgres`, since `up` recreates the container.

```bash
PG_CONTAINER=tmp-ci-pg bash backend/scripts/local-ci-stack.sh run   # up + run-all.sh
PG_CONTAINER=tmp-ci-pg bash backend/scripts/local-ci-stack.sh down
```

Reference result on a fresh stack (Tier 357): **99 passed / 0 failed**, matching CI.

**The same script now covers the Playwright job** (Tier 358):

```bash
PG_CONTAINER=tmp-ci-pg bash backend/scripts/local-ci-stack.sh run-playwright
```

It runs the shared `up`, then the CI `playwright` job's own steps: backend
with `FRONTEND_URL=http://localhost:3100`, `NEXT_PUBLIC_API_URL=http://localhost:3001
npx next dev -p 3100` under `NODE_ENV=test`, `npx playwright install chromium`,
and one `CI=true npx playwright test` — not the segmented
`frontend/scripts/run-all.sh`, which CI does not use. `down` also stops the
frontend, scoped to port 3100.

Two details that are easy to get wrong:
- **`PORT` must not be exported globally.** `scripts/start-backend.sh`
  takes the backend port from `PORT`; the CI job's `PORT: 3100` only ever
  reaches `next dev`. The script passes it inline.
- **The gitignored `frontend/.env.local` does not leak into the run.**
  Verified in the installed `@next/env` 15.5.7: its file list is
  `[.env.${mode}.local, mode !== "test" && ".env.local", .env.${mode}, .env]`,
  so under `NODE_ENV=test` — which CI uses — `.env.local` is never loaded.

Reference result on a fresh stack (Tier 358): **906 passed / 1 flaky / 5
skipped / 0 failed** (912 total) — CI's latest was 907 / 0 / 5. The flaky
(`webhook-last-success-tier199`) passed on retry.

**Three things the Playwright job needs that the backend job does not**
(found in Tier 358's first local run: 893 passed / 6 failed / 9 did not run):
- **The backend log must be `/tmp/backend.log`.** `customer-portal-tier131`,
  `portal-invoice-detail-tier133` and `portal-profile-tier155` read portal
  magic-link tokens back out of that exact file. A different log path fails
  them with "expected to find a portal session token in /tmp/backend.log" and
  their serial siblings never run.
- **`BACKUP_ROOT` must not default.** `backup.service.ts` uses
  `process.env.BACKUP_ROOT || $HOME/data/backups/de-invoice` — on a
  developer machine that is the **real** backup directory. `backups.spec.ts`
  listed its 13 real entries (CI's runner has none) and its trigger wrote a
  backup *of the throwaway test database* into it. The stack now exports
  `BACKUP_ROOT=/tmp/local-ci-backups` (wiped by `up`) and
  `BACKUP_DOCKER_CONTAINER=$PG_CONTAINER`.
- With those, the four failing files re-ran 22/22 and the real backup
  directory stayed at 13 entries.

**`cost-center-monthly` "clicking a month-cell" intermittently skipped**
(fixed Tier 358c). It registered `waitForResponse(cost-center-yearly)` after
`goto`, then did an instantaneous `monthLinks.count()` and
`test.skip("no seeded data for current year")` on 0 — the Tier 346 race
wearing a "missing data" label, which is why that sweep (keyed on
"not found / not present / may be loading") missed it. CI run 34572785139
skipped it; the run before did not. Now the waiter is registered before
navigating and the count is a web-first `toBeVisible` on the first link.
Local, CI-equivalent stack: this spec plus report / transactions / trend,
`--repeat-each=3 --retries=0`, 45/45 (warm dev server, so supporting
evidence rather than proof).

**There is no 2027-01-01 date bomb in the cost-center specs** — recorded
because it looks like one. `ci-seed.sh` hardcodes 2026 dates (e.g. voucher
`BK-HIST-001` 2026-01-15) and the Playwright cost-center specs query
`new Date().getFullYear()`. But the yearly report aggregates only `Invoice`
and `Expense`, not voucher lines, and `cost-center-monthly`'s `beforeAll`
creates a VERTRIEB invoice dated July 15 of the *current* year on every run
(`cost-center-crud` creates one at today's date); both sort before report /
transactions / trend. Backend e2e 72-75 seed their own 2026 rows and query
`year=2026` explicitly, so they are self-consistent too. Do **not** make
`V-185-001`'s date relative: `96-tier69-datev-preview.sh` queries
2026-01-01..2026-12-31 and depends on it.

**Product bug (fixed Tier 359): the per-webhook "Test" button fired every
webhook in the company.** The endpoint now calls `WebhookService.sendTest(wh,
event)`, which creates one delivery for the target only, still returning
`delivered=0` when the target is inactive or not subscribed to
`webhook.test`. `emit()` keeps its company-wide fan-out; both share the new
private `subscribesTo` / `createAndDispatch` helpers. `50-webhooks.sh` 43b/44b
guard it with a sibling webhook subscribed to `webhook.test` that must receive
no rows. What it used to do, for the record: `settings/webhooks/page.tsx` renders
a Test button per row (`data-testid="webhook-test"`) that calls
`POST /webhooks/:id/test`. The handler looks up that one webhook, but only to
validate it and put its name in the payload; it then calls
`webhooks.emit({ type: 'webhook.test', companyId, ... })`, and `emit()` fans
out to **every active webhook in the company subscribed to `webhook.test` or
`*`**. So testing webhook A also delivers a test event — carrying A's name —
to B, C and any `*` subscriber, which may be a production receiver. The
fan-out is correct for the 17 real `emit()` callers (vouchers, suppliers,
customers); the fix belongs in the test endpoint alone, e.g. creating a
single delivery for the target webhook, not in `emit()`.

This is also the cause of the suite's intermittent
`webhook-last-success-tier199` "2. lastSuccessAt === lastDeliveryAt"
failure (seen as the one flaky in Tier 358's local run: 28 ms apart). The
spec presses Test once per webhook, so each fan-out gives both webhooks a
delivery — two rows each. `lastSuccessAt` and `lastDeliveryAt` are
`_max(attemptedAt)` over successful rows and over all rows, and
`attemptedAt` defaults to `now()` at creation, so a second delivery still
pending when the spec reads (after a fixed 2 s sleep) makes them differ.
Fixing the endpoint removes the second row; leaving it means the spec
should wait for all deliveries to reach a terminal status instead.

**Backups: three operational findings that are not test problems** (Tier 358,
from inspecting `~/data/backups/de-invoice` by file name and size only):
1. **The nightly backups have contained no database since 2026-09-06.**
   Every entry from 2026-08-01 to 2026-09-05 has `db.sql.gz`. From 09-06 on
   they hold only `attachments.tar.gz`. **The last backup that includes the
   database is `backup-2026-09-05-224235`.** The schedule is the backend's own
   `@Cron('0 4 * * *')` in `backup.scheduler.ts` — no crontab or LaunchAgent —
   so it runs only while a dev backend happens to be up at 04:00.
2. **The backup health indicator could not see this** (fixed Tier 359).
   `BackupService.healthColor` looked only at the age of the newest entry
   (<24h green, <48h amber, else red) and never checked that `db.sql.gz`
   exists, so `/admin/backups` showed green every day the database was
   missing. It now returns red for a newest entry without `db.sql.gz`, and
   the chip appends `backup.noDatabase` ("no database dump") so a red
   "3 h ago" explains itself. `restoreDrill()` used to take the newest entry
   regardless; it now drills the newest entry that has `db.sql.gz`. The
   underlying problem — `scripts/backup.sh` still producing directories
   without a dump — is **not** fixed; this only makes it visible.
3. **Probable root cause of the recurring dev-PG corruption:** the dev
   container's data directory is bind-mounted from `/tmp/pgdata`. The
   09-06 04:00 dump log reads `FATAL: could not open file
   "global/pg_filenode.map": No such file or directory` — Postgres system
   files already gone from the data directory. macOS periodically purges old
   files under `/tmp`, which fits. Note where that mount comes from:
   `docker-compose.yml` uses a **named volume** (`postgres_data`), so the
   dead `de-invoice-postgres` container was not created by compose but by
   some manual `docker run -v /tmp/pgdata:...`. `scripts/fix-dev-pg.sh` does
   not recreate the container either — it assumes `/tmp/pgdata` exists,
   `mkdir -p`s any missing subdirectories, `sudo chown`s, and `docker start`s
   the same container. That keeps the data in `/tmp`, and recreating empty
   directories cannot bring back files Postgres has lost, so it repairs the
   symptom while preserving the cause. Recreating the dev database through
   `docker-compose.yml`'s named volume would take it out of `/tmp`.

Also: Tier 358's first local run (before the `BACKUP_ROOT` fix) left
`backup-2026-09-11-082614` in that real directory — a dump of the throwaway
**test** database, which sorted as the newest entry and so drove both the
health colour and the restore drill. Tier 359 moved it to the macOS Trash
(not permanently deleted), with the operator's approval.

**Backups: rotation deleted real backups while dumps were failing** (fixed
Tier 360). `scripts/backup.sh` rotation handed out its 7 daily / 4 weekly /
monthly slots by the date of *any* stage dir, and a failed `pg_dump` still
leaves one (attachments only). Replaying the real directory layout in a
scratch dir showed the pre-360 script deleting `backup-2026-09-05-224235` —
the last backup containing the database — after two more failed runs; a
month of failures would have left only the current year's day-01 anchors,
and those go at the year change. Now only dirs with `db.sql.gz` earn slots;
dump-less dirs are kept only while newer than the newest complete backup,
capped at `KEEP_DAILY`. `backend/e2e/42-backup-rotation.sh` covers it with a
stub `pg_dump` and 2020 fixture dates (no backend or DB needed); run against
the pre-360 script it fails 3 assertions. Rotation policy itself is unchanged
and still worth an operator look: monthly anchors exist only for runs that
happen on the 1st, and are kept for the current calendar year only.

**The 70 three-digit backend e2e specs now run** (found Tier 360, fixed
Tier 361). `backend/e2e/run-all.sh` — which CI calls — looped over
`[0-9][0-9]-*.sh`, two digits then a hyphen, so specs `100-*`..`169-*` never
ran anywhere and "Backend e2e 99/99" meant the two-digit specs only. Tier 361:
- the loop is `[0-9][0-9]-*.sh [0-9][0-9][0-9]-*.sh` (two-digit first, as before);
- every spec runs under a watchdog, `SPEC_TIMEOUT` (default 600 s), because no
  spec has its own timeout, macOS has no `timeout(1)` and CI's job limit is
  GitHub's 6-hour default;
- a `QUARANTINE` list in `run-all.sh`: a listed spec still runs and is reported,
  but does not fail the suite, and the summary says when one starts passing.
  Each entry carries the observed symptom. Do not add a spec to get a red build
  green without writing down why;
- `169-tier247-dryrun-validate.sh` → `dryrun-tier247-validate.sh`: it targets
  the prod-image dryrun stack (:3002, `de-invoice-dryrun-postgres`), not CI.

First full run on a CI-equivalent stack: 152 passed / 17 failed, all 17 in
the three-digit range. 15 were fixed in Tier 361:

| Spec | Cause | Fix |
|---|---|---|
| 113, 115 | expected AfA as a negative BWA 3100 line (true at Tier 87); `bwa.service.ts` now sums `.abs()` and subtracts AfA like every other cost (112/119 expect positive costs) | expectations |
| 114 | Personalaufwand > 0 needs a Personal-category expense; the CI seed has none | own fixture |
| 117 | `Company.settings` is NULL on the CI seed → empty backup → `json.loads('')` in both the opt-out and the re-enable step → neither applied; cron check grepped only the `@Cron(` line of a multi-line decorator and `exit 1`'d | NULL handling in every settings edit; check the decorator block |
| 134 | sent `zip` / `kontoinhaber` / expense `status`, rejected since the Tier 210/211 DTOs (`postalCode`, `accountHolder`, no status; default `booked` is what pain.001 selects); batch creation also needs a debtor IBAN in `Company.bankInfo` | payloads; merge IBAN for the run, restore on exit |
| 136 | § 8b assertions need a KapG; see open question below | explicit `settings.rechtsform`, restored on exit |
| 137 | pain.008 takes the creditor IBAN from `Company.bankInfo`; CI seed has none | merge IBAN for the run, restore on exit |
| 140 | XRechnung BR-DE-6 / BR-DE-7 need seller phone + email (`Company.phone` / `.email`) | seed both, restore |
| 148 | `[ cond ] \|\| fail "..."; exit 1` exits unconditionally (`;` binds looser than `\|\|`); ended with an unconditional "ALL PASSED"; `assert_eq` arguments swapped; `COMPANY_ID` unset (no `login`) | all four |
| 154, 155, 168 | hardcoded invoice ids from one developer database | seeded INV-TEST-001; 155 reads its number |
| 161 | hardcoded user `tier221-1787169195-90017@example.com` left by one old run | creates and deletes its own user |
| 162 | assumed overdue + sent invoices exist | own fixture |
| 164 | "real VIES latency ≥ 100 ms" under `VIES_MOCK=1` | skip that heuristic when mocked |

**Lesson: a spec that passes on a stack other specs have already run on is
not verified.** 117 and 134 both passed when re-run one by one on the triage
stack, then failed in the first full fresh run: earlier ad-hoc runs of
137/140/154 had left `Company.bankInfo` and `Company.settings` populated,
which masked the missing preconditions. Only a fresh stack in `run-all.sh`
order (what CI does) counts.

**And a fresh local run is still not CI** (Tier 361b). The Tier 361 push went
red on two specs that passed in both fresh local runs, both macOS-only
assumptions: `111-tier85-berater-packager.sh` counted ZIP entries by grepping
`unzip -l` for `MM-DD-YYYY` dates (the macOS listing format; on the runner
nothing matched, "0 entries", while the ZIP itself was valid) → now Python
`zipfile`; `140-tier116-kosIT.sh` looked for Java only in the bundled macOS JDK
under `infra/java` (not in git) → now bundled JDK, `$JAVA_HOME`, `java` on
PATH, the same order as `kosIT-validator.service.ts`. In CI the backend itself
had validated every invoice ACCEPTABLE with the runner's JDK. When a spec
parses tool output or probes a local path, assume the runner differs.

Specs that could not fail, found on the way: `09-vouchers-list.sh` (14
`assert_eq` calls, but `_lib.sh`'s `fail` only counts, and the spec ended with
`echo "ALL PASSED"` → now `summary`); 148 above; 136's step 2 passed in both
branches; 161's invalid-status check was a `note`.

Product bugs fixed in Tier 361, both surfaced by these specs:
- `PATCH /users/:id/status` accepted any string (`"lolwut"` → 200, stored).
  The controller now allows only `active` / `inactive`.
- `GET /invoices/:id/pdf` for an unknown or foreign id answered
  500 "PDF generation failed": the catch-all swallowed `findOne`'s
  `NotFoundException`. HTTP exceptions now pass through (404).

Left open by Tier 361 (each bullet updated as a later tier closed it;
`QUARANTINE` in `run-all.sh` is empty since Tier 363):
- **124 and the frontend production image — fixed in Tier 363.** A frontend
  image built from a clean HEAD had `http://localhost:3001` in 48 client chunks
  and 14 server files: `next build` inlines `NEXT_PUBLIC_*`, the Dockerfile had
  no `ARG`, and both prod compose files passed the URL only as runtime
  `environment:`. The build arg alone would not have been enough — 27 fetches
  in 12 pages, including **login, register, forgot/reset password and 2FA**,
  plus user management, reminders, UStVA, invoice create, voucher detail and
  mail settings, used a literal `http://localhost:3001`, and the cashbook
  sign-off read `NEXT_PUBLIC_API_BASE`, which nothing sets. A production
  deploy could not have logged anyone in. Now:
  - every call uses `API_BASE` from `src/lib/api.ts`;
  - `frontend/Dockerfile` takes `ARG NEXT_PUBLIC_API_URL` and **refuses to
    build without it** (verified: the build stops with a clear error);
  - `docker-compose.prod.yml` passes `NEXT_PUBLIC_API_URL` and
    `infra/prod/docker-compose.yml` passes `FRONTEND_URL` as build args, both
    required. The value is the public origin — nginx / Caddy route `/api/` on
    the same origin. **Changing it needs an image rebuild**;
  - `frontend/.dockerignore` and `backend/.dockerignore`: the root
    `.dockerignore` says it covers both build contexts, but Docker reads it from
    the context root and both images build from their subdirectory, so it never
    applied — a developer's `frontend/.env.local` went into `next build`, and
    `backend/.env` into the backend build cache (not the final image);
  - `DEPLOY.md` step 3 creates the compose `.env` (`POSTGRES_PASSWORD`,
    `NEXT_PUBLIC_API_URL`) that step 5 needs;
  - **`release.yml` (tag `v*` → GHCR) now needs the repository variable
    `NEXT_PUBLIC_API_URL`** — set it before pushing a tag, or the frontend
    image build fails on purpose. (No tag has ever been pushed.)
  - spec 124 checks the ARG, both compose build args, both `.dockerignore`
    files, and that `frontend/src` has no `localhost:3001` outside
    `src/lib/api.ts` except in `NEXT_PUBLIC_API_URL` fallback lines.
  Verification: an image built from the working tree with `--build-arg NEXT_PUBLIC_API_URL=https://probe.example.invalid`
  has 0 `localhost:3001` in client and server bundles, the probe URL in 50 client
  chunks, and no `.env` file; without the arg the build stops at the guard. The
  backend image still builds, its dev stage holds only `.env.example`. Full Playwright
  suite on a fresh CI-equivalent stack: 908 passed / 4 skipped.
- **142 — fixed in Tier 362.** `pnl.service.ts` aggregated `_sum` per month and
  used the `eurSubtotal` sum whenever any row in that month had one, dropping
  rows whose `eurSubtotal` was NULL. It now reads the year's invoices and sums
  `eurSubtotal ?? subtotal` per row (as `Prisma.Decimal`), like BWA, GuV and
  EÜR. The NULLs were not only legacy data: `recurring.service.ts` created
  invoices without `exchangeRate` / `eurSubtotal` / `eurTotalVat` / `eurTotal`.
  It now sets them by `InvoiceService.create`'s rule (EUR mirrors at rate 1;
  other currencies divide by the company's cached ECB rate, 1.0000 when none is
  cached). `153-tier222-recurring-run.sh` asserts both an EUR and a USD run.
  **Existing data is not migrated.** EUR recurring invoices created before
  Tier 362 are already reported correctly through the per-row fallbacks; a
  non-EUR one is still counted in its original currency and exported to DATEV
  without a rate, and its issue-day rate cannot be reconstructed automatically.
  Find them with:
  `SELECT id, "invoiceNumber", currency, "issueDate", total FROM "Invoice"
  WHERE "recurringInvoiceId" IS NOT NULL AND "eurSubtotal" IS NULL AND currency <> 'EUR';`
- **Playwright: five more "instantaneous `.count()` → `test.skip`" guards**
  (fixed Tier 362b). The Tier 362 CI run skipped `list-pages.spec.ts` "search
  filters the list" — counted invoice rows once right after `networkidle`, got
  0 before the list rendered, and skipped as "no invoices in the DB" (the run
  before passed it in 2.5 s; Playwright went 907/5 → 906/6). Same pattern, now
  web-first waits on the first row / card: the products search in the same
  file, `list-pages-2.spec.ts` supplier search, `products-page-tier233` 3-4 and
  `recurring-page-tier232` 4. The CI seed has all four kinds of data, and none
  of these skipped in earlier CI runs, so an empty list now fails instead of
  hiding. Against a developer database without that data they fail too — by
  design. A sixth, `aging-credit.spec.ts` "credit column rows link to
  /customers/<id>/credit", had the same guard and lost the race in **every** CI
  run (it was one of the "5 skipped"): it counted the per-row credit cell right
  after the h1 appeared, before the aging fetch filled the table. Also fixed.
  The skips left after 362b: three deliberate unconditional `test.skip`
  (`recurring-email-tier129`, `recurring-generated-invoices-tier147`,
  `vies-batch-tier134`) and `admin-ops-tier195` 4, which needs a backup with
  `db.sql.gz` — none of them this pattern.
- **Anlage AUS KapG detection** (product question, not changed):
  `anlage-aus.service.ts` tests `/^(GmbH|AG|KGaA|UG)/i` against
  `settings.rechtsform || legalName`. Nothing in the frontend writes
  `settings.rechtsform`, and a legal name carries the form as a suffix
  ("SH Leder GmbH"), so the fallback never matches. KSt 1 and the Berater
  packager instead default `rechtsform` to "GmbH". A word-match would also hit
  "GmbH & Co. KG", which is not a KapG for § 8b — decide the rule first.

Tier 361 local full run on a fresh CI-equivalent stack: 167 passed / 0 failed, plus the 2 quarantined specs (124, 142) still failing as recorded; no spec hit the timeout (7 min).

**`frontend/AGENTS.md` points at `node_modules/next/dist/docs/`, which does
not exist** in this install. When you need Next.js behaviour confirmed, read
the installed package source (e.g. `node_modules/@next/env/dist/index.js`)
rather than trusting that pointer. The block is tool-managed
(`BEGIN:nextjs-agent-rules`), so it was left unedited.

**A local full-suite run IS comparable to CI — when it is set up like CI**
(Tier 357). Tiers 355-356 recorded the backend suite as "65 passed / 34
failed locally vs 99/99 in CI, and the gap is environmental". **That
diagnosis was wrong.** Using `backend/scripts/local-ci-stack.sh` on a fresh
throwaway database the suite now scores **99 passed / 0 failed, same as
CI**. The 34 broke down as:

| Cause | Specs |
|---|---|
| 254 container-name hardcodes Tier 355 missed (`docker exec -i ...`), leaving IDs empty — 27 cascading `500 Related resource not found` | most of 24-99, incl. the 69-86 block |
| `search_tsv` raw-SQL migration never applied by hand-typed local stacks | 41-migrate (1a), 60-tier28-search, 95-tier68-global-search |
| `scripts/backup.sh` choosing its `pg_dump` target by hardcoded name | 42-backup-fire-drill |
| hardcoded `localhost:5432` in `prisma migrate deploy` on a fresh DB | 41-migrate (11a-11d) |

In other words, mostly a bug in *my* Tier 355 change plus hand-typed setup
drift — not the environment. The earlier A/B comparisons still stand (both
sides were equally handicapped), but their local signal was far weaker than
reported: a spec already failing locally cannot show a regression, which is
exactly how the Tier 356 skonto timezone failure slipped past a local "zero
regression" check. **With the stack script there is no longer a local blind
spot; a local run that differs from 99/99 is a real signal.**

**Never `await` two `page.waitForResponse` calls in sequence** (Tier 354).
When a page fires both requests from one `Promise.all`, the second waiter
is only registered after the first has resolved — by which point the second
response may already have gone by, and the wait then hangs for its full
timeout. Register both promises synchronously and `await Promise.all([...])`.

This was the suite's last flaky (`cost-center-budgets.spec.ts:195`,
recurring in Tiers 345, 349, 352 with
`TimeoutError: page.waitForResponse: Timeout 60000ms exceeded`). The
striking part: the test directly **above** it in the same file already
carries a comment diagnosing this exact failure from run #308 and using the
`Promise.all` form. The fix was applied to one test and missed the other —
the same "fixed here, missed there" shape as Tier 347's `sortOrder` (fixed
in the spec, missed in `ci-seed.sh`). A suite-wide scan now finds zero
remaining sequential-await pairs.

Caveat on verifying this class locally: 18/18 passes with `--repeat-each=6
--retries=0`, but a local dev server is already warm, so the race window is
far narrower than the cold-compile CI conditions where it actually fired.
Local green here is supporting evidence, not proof.

**Local Playwright runs no longer need the dev container** (Tier 353).
28 spec files hardcoded `de-invoice-postgres` across 54 `docker exec` call
sites, so any spec touching psql could only run against that one container
— and it has been dead since 2026-09-06, which blocked local verification
three times in Tiers 350-352. They now all read
`PG_CONTAINER` from `e2e/fixtures/test-env.ts`
(`process.env.PG_CONTAINER || 'de-invoice-postgres'`), matching what
`ci-seed.sh` already did. **The default is unchanged, so CI behaves
identically.**

To run psql-dependent specs locally against a throwaway DB:

```bash
docker run -d --name tmp-pg -e POSTGRES_USER=de_invoice \
  -e POSTGRES_PASSWORD=de_invoice_pass -e POSTGRES_DB=de_invoice \
  -p 55440:5432 postgres:16
# backend with DATABASE_URL pointing at :55440, frontend on :3100, then
PG_CONTAINER=tmp-pg bash backend/e2e/ci-seed.sh
cd frontend && PG_CONTAINER=tmp-pg npx playwright test e2e/<spec>
```

Verified both directions: with `PG_CONTAINER=tmp-pg`, the previously
unrunnable recurring-clone / recurring-pause / ratensplan-suggestion specs
pass 17/17 locally; with it unset they still shell into
`de-invoice-postgres`, exactly as CI does.

**Gotcha when editing these call sites:** most are inside template
literals, but a few `docker exec` strings were single- or double-quoted
(array elements for `execFileSync`, and one `execSync('docker inspect
... ${PG_CONTAINER}')`). A blind find-and-replace turns `${PG_CONTAINER}`
into a literal inside a quoted string and neither tsc nor eslint will
complain. Check that every `${PG_CONTAINER}` sits inside backticks.

### local-ci-stack.sh no longer kills processes it did not start (Tier 364)

`stop_backend` used to `pkill -f "ts-node src/main.ts"` and `stop_frontend`
killed whatever listened on :3100, so every local CI run silently killed a
developer's own backend — the process that also runs the 04:00 backup cron —
or frontend. Ownership is now a **random token**: the script exports
`LOCAL_CI_STACK_TOKEN` to everything it starts (backend, spec 20's restarted
backend, `next dev`) and keeps it in `/tmp/local-ci-stack-<PG_CONTAINER>.token`
so a later `up` / `down` recognises the same processes; `down` deletes the
file. A process counts as its own only if `ps eww` shows that exact token.
`up` and `run-playwright` refuse (exit 2) when :3001 / :3100 belong to anything
else; `down` reports the foreign process, leaves it alone, and still removes
what the script owns. Spec 20's own `lsof -ti:3001 | xargs kill -9` is
unchanged: it only runs inside the stack.

**Two simpler markers failed in testing — don't go back to them:**
- `NODE_ENV=test` / the backend's `DATABASE_URL` on the listener. The :3100
  listener is `next-server (v15.5.7)`, a child of `next dev` that renames its
  process title, which also hides its environment. The script's own frontend
  counted as foreign and survived `down`.
- The same marker looked up on parent processes. `ps eww` prints argv and
  environment as one string, so an ancestor whose **command line** merely
  contained the text — the shell running a test script that mentions
  `next dev -p 3100` and `NODE_ENV=test` — matched, and a foreign server on
  :3100 was killed. A random token appears in no command line.

`stop_frontend` kills the whole own tree (`npm exec` → `next dev` →
`next-server`), not just the listener. Verified: the guard was exercised on a throwaway stack. Foreign listener on :3100 → `run-playwright`
exits 2 and the listener survives `down`; foreign :3001 → `up` exits 2, no container;
a developer `next dev -p 3100` without the token → refused and left running; own
frontend started twice, then `down` → no listener, no `next dev`/`next-server`, no
container, no token file; `up` twice replaces its own backend; a full `run` (169 passed /
0 failed, spec 20 restarts the backend) followed by `down` leaves nothing behind.

### Recurring "send e-mail" was never saved; the last four Playwright skips (Tier 365)

**Product bug.** The recurring-template form has sent `sendEmail` since Tier
129, but `RecurringInput` had no such field and `recurring.service.ts`
`create()` / `update()` never wrote it. The column defaults to `true`, so
**unchecking "Rechnung an Kunden senden" did nothing — every generated invoice
was still e-mailed to the customer.** (Clone copies the flag, so clones were
`true` too.) Now persisted on create (default `true`) and update; the form's
`openCreate` also resets the checkbox, which only became necessary once a
template could actually store `false`. Covered by `35-recurring-wizard.sh`
(default + update), `153-tier222-recurring-run.sh` (create body) and the
Playwright test below. **Existing templates cannot be repaired automatically**
— see §9.

The test that would have caught it was one of the four remaining Playwright
skips. All four hid coverage:
- `recurring-email-tier129` "unchecking the checkbox persists sendEmail=false":
  an empty body with `test.skip(true, …)` since Tier 129. Now creates a
  template through the form, unchecks, saves, reads it back via the API and
  deletes it.
- `recurring-generated-invoices-tier147` empty state: skipped as "fragile".
  Creates a 2099 template via the API, opens its Verlauf modal, expects
  `recurring-generated-empty`, deletes it.
- `vies-batch-tier134` "start button runs the batch": `test.skip` for the real
  VIES per-member-state rate limit. Under `VIES_MOCK=1` (CI, local-ci-stack)
  `checkVatId()` answers from the mock before the token bucket, so it runs
  there and asserts result rows; it still skips against real VIES.
- `admin-ops-tier195` 4 restore drill: skipped whenever no backup with
  `db.sql.gz` existed — i.e. always on a CI runner, so the drill never ran in
  CI. It now creates a backup first **only when the root is clearly
  throwaway** (`CI` set, or under `/tmp/`), expects a fresh backup to restore
  (`ok: true`), and deletes it; elsewhere it still skips to keep test dumps out
  of a real backup directory.

Verified: fresh CI-equivalent local stack — backend e2e 169 passed / 0 failed (incl.
`1c` / `5c` / `5d` in spec 35 and the create-body check in 153); Playwright on the
four fixed specs plus all `recurring*` specs 50 passed / 0 skipped, the drill
test's backup deleted again, the real backup directory untouched.

**Tier 365b — the one flaky test in the Tier 365 CI run.**
`bwa-quarterly-tier163` "switching quarter triggers a new fetch + re-render"
timed out on its first attempt (passed on retry). Two bugs in the spec, not the
page: the `/bwa-quarterly` response listener was registered *after* the BWA tab
click, although `BwaTab` mounts on that click and fetches at once — a fast run
missed the response and waited out 90 s; and it always switched to `Q2`, while
the select defaults to the **current** quarter, so from April to June the
change was a no-op and the test would have failed every time. Listener now
registered before the click; the target quarter is whichever differs from the
current value. Verified: the spec run 5× on a fresh CI-equivalent stack (`--repeat-each=5`): 60 passed, "switching quarter" 5/5, no retries.

### The audit hash chain never verified what it claimed (Tier 366)

GoBD tamper-evidence rested on a chain that was broken by construction. Two
independent bugs, both confirmed on a throwaway stack before fixing:

1. **Prisma.Decimal was hashed as decimal.js internals.** On the write path a
   Decimal is a live object whose own keys are `["constructor","s","e","d"]`
   (and `constructor` serialised to the literal `undefined`); on the verify
   path the same field comes back from jsonb as `"119"`. Every audited model
   with a Decimal column — Invoice, InvoiceItem, Expense, Voucher, Product,
   CashBookEntry, Account, JournalEntry, BankTransaction — wrote rows that
   reported `verified=false` although nothing had been touched. Measured: a
   `product.updated` row written by the extension came back
   `signed=true, verified=false`.
2. **`previousHash` chained to the newest row, signed or not.** Auth, assets
   and company write audit rows with no hash, and `ci-seed.sh` inserts 13
   directly; `verifyChain` carries the last *signed* hash forward, so any
   unsigned row in between guaranteed `previous_hash_mismatch`. A freshly
   seeded database verified as **ok=false, 28 rows, 14 signed / 14 unsigned**
   before any test touched it.

`audit-hash-chain-tier196` passed all along only because its `beforeAll` runs
`scripts/audit-rehash.ts`, which rewrites every hash and pointer.

**Bug 1 is fixed in Tier 366; bug 2 was a different defect than it first looked
and is fixed in Tier 367 (next section).**

Fixed (bug 1):
- `stableStringifyV2` canonicalises each value to what jsonb actually stores: a
  Decimal via `toNumber()` (**not** `toJSON()` — `JSON.stringify` on a Decimal
  yields the string `"19"`, but Prisma stores the JSON *number* `19`;
  `jsonb_typeof` confirms it), a Date as its ISO string, BigInt as a decimal
  string (`JSON.stringify` throws on BigInt and would have crashed the write).
  My first attempt used `toJSON()` and still failed — the spec caught it.
- V1 is kept and **each row is verified under its own `hashAlgorithm`**, so
  history is not rewritten. New rows are `SHA-256-V2`; `verifyChain` reports
  the newest signed row's algorithm instead of a hardcoded string.
- All three copies of the hash function changed together — the extension, the
  service, and `scripts/audit-rehash.ts`.
- `170-tier366-audit-hash-chain.sh` asserts a product update writes a
  `SHA-256-V2` row whose payload really contains a Decimal, that the untampered
  row verifies, and that tampering still flips it to `verified=false`.

**Bug 2 (diagnosed here, fixed in Tier 367): the chain pointer is broken by
ordering and concurrency, not by unsigned rows.** Measured on a fresh stack: 15 audit
rows share one second, a mid-chain row carries an empty `previousHash`, and a
dozen rows all point at the same predecessor. `createdAt` is rounded to whole
seconds (`Math.floor(Date.now()/1000)*1000`) and the tie-break is a random
UUID, so the writer's `max(createdAt, id)` and `verifyChain`'s ascending walk
disagree; concurrent writers also read the same "newest" row and all chain to
it. A correct fix needs a monotonic sequence column on `AuditLog` (migration)
and per-company serialisation of the audit write, then chaining and verifying
by that column — its own tier. Tier 366 did change both writers to chain to
the newest **signed** row (strictly better, and needed either way), but that
alone does not make the chain verify.

**Also open:** rows written before Tier 366 that contain a Decimal stay
unverifiable under V1 rules; `npx ts-node scripts/audit-rehash.ts` re-hashes a
chain (it also signs previously unsigned rows). That rewrites stored hashes, so
it is the operator's call — see §9. **Nine** call sites wrote unsigned audit
rows (auth ×5, assets ×3, company ×1 — "seven" was a miscount here; the
breakdown itself always summed to nine). Tier 368 routed all nine through
`audit.service.writeActivity`, which signs and chains them — see the Tier 368
section below.

Verified: fresh CI-equivalent local stack — backend e2e **170 passed / 0 failed** with the new
spec green: the product update writes a `SHA-256-V2` row whose payload stores
`basePrice` as a JSON number, the untampered row verifies
(`storedHash == recomputedHash`), and tampering still flips it to `verified=false`.
The two audit Playwright specs pass (11 passed). backend + frontend `tsc` and
`eslint --max-warnings 0` clean. The first attempt (Decimal via `toJSON()`) failed
this spec — that is how the number-vs-string difference was found.

### The audit chain now verifies as written (Tier 367)

The chain verifies on a freshly seeded database **without** running
`audit-rehash.ts` — the assertion that had been missing since Tier 196, and the
only one that proves the application writes a valid chain.

1. **Order.** The writer chained to `max(createdAt, id)` while `verifyChain`
   walked ascending `(createdAt, id)`. `createdAt` is rounded to whole seconds
   and `id` is a random UUID, so within one second the two disagreed about which
   row came last (a seeded DB had 15 rows in one second). `AuditLog.seq`
   (`BigInt @default(autoincrement()) @unique`) is now the only order the
   writer, `verifyChain` and `audit-rehash.ts` use.
2. **Concurrency.** Nothing serialised read-previous → hash → insert, so
   parallel writers all read the same predecessor — measured: a dozen rows
   sharing one `previousHash`, and a mid-chain row with none. Both writers now
   hold `pg_advisory_xact_lock(hashtext(companyId))` for that critical section
   inside a `$transaction` (20s timeout). The lock is transaction-scoped, so it
   releases on commit *and* on rollback; the audit insert already used its own
   connection whenever the caller was mid-transaction, so this adds none at
   `connection_limit=8`.
3. **A third defect, visible only once the order was right.** With the walk
   fixed, `recurringinvoice.created` failed as `hash_mismatch`. Cause: Tier 304
   does `data.invoiceNumber = result.invoiceNumber` for `Invoice` **and
   `RecurringInvoice`**, which has no such column — so the assignment created an
   own key holding `undefined`. The write path hashed it as `"invoiceNumber":`
   while Prisma drops undefined keys from the jsonb payload, so the verify path
   re-read an object without it (write 933 chars, read 916, first difference at
   offset 429). Fixed at both ends: `stableStringifyV2` skips `undefined`-valued
   keys (never `null` — jsonb stores those faithfully), and the Tier 304
   assignment only fires when the value is defined. **No algorithm bump:** the
   filter changes the outcome only for payloads that carried an undefined key,
   and those never verified, so nothing that passed before can start failing.

The migration `20260912000001_audit_log_seq` adds the column nullable, backfills
in `(createdAt, id)` order — the order existing pointers were computed against —
then attaches the sequence and sets NOT NULL. Neither CI nor
`local-ci-stack.sh` runs `migrate deploy` (both `db push` from schema.prisma),
but `e2e/41-migrate.sh` does, against a throwaway DB, so the file is exercised.

`computeAuditHash` / `stableStringifyV2` are now exported from the extension so
a diagnostic can canonicalise with the **real** function — hand-reasoning a
duplicate is how Tier 366 lost a cycle, and reasoning about this canonicalisation
was wrong twice more in Tier 367 before the probe settled it by measurement.

Two of my own errors, recorded because both are easy to repeat: spec 170 first
asserted chain integrity at step 4 while its own tampered row from step 3 was
still in the table (the tamper now runs last, before cleanup); and
`audit-hash-chain-tier196`'s `beforeAll` re-hashes the entire chain, which is
*why* this hid for ten tiers — a green run of that spec never proved anything
about what the application wrote.

Verified on a fresh CI-equivalent stack, twice end to end: backend e2e
**170 passed / 0 failed**, spec 170 green including `chain ok` with no re-hash
and 7 concurrent updates chaining to 7 distinct predecessors; the seven
Playwright audit/activity specs **39 passed / 0 failed**; backend + frontend
`tsc` and `eslint --max-warnings 0` clean. The migration was applied both to a
fresh `migrate deploy` (`seq` NOT NULL DEFAULT nextval, both indexes) and to a
populated DB (backfill `d,a,b,c`, sequence continues, NOT NULL and UNIQUE both
enforced). A probe canonicalising the live create result against the stored
jsonb with the real function reports `canonical strings equal: YES`, 0 field
differences.

### The chain is append-only, and the auth rows are in it (Tier 368)

Tier 367 made the chain verify. This tier put the rows that were still *outside*
it into it — which immediately exposed two structural defects that had been
invisible precisely because those rows were unsigned.

**1. Nine unsigned call sites are signed now.** auth ×5 (controller ×4, service
×1), assets ×3 (service ×1, AfA scheduler ×2), company ×1 all wrote via
`prisma.auditLog.create`, which bypasses the audit extension: no hash, no chain.
They now go through `audit.service.writeActivity`, which signs and chains them
under the per-company advisory lock. `writeActivity` gained optional
`ipAddress` / `userAgent` / `oldData` — without them the migration would have
silently dropped the login trail's IP and user-agent and the storno /
feature-flag before-images. ipAddress/userAgent are stored but NOT hashed (same
as the extension); `oldData` IS hashed.

**2. A failed login for an unknown e-mail was never audited at all.** That call
site wrote `companyId: 'unknown'` and `userId: 'unknown'`; both were foreign
keys, so every such insert violated them and died inside an empty
`catch { /* ignore */ }` — not even a log line. Measured before the fix: an
unknown-e-mail login returned HTTP 400 and produced **zero** AuditLog rows,
while a real user with a wrong password (real ids) wrote its row fine. The
un-audited case was the interesting one — user enumeration, credential
stuffing. Nothing in the suite had ever asserted on an auth audit row, which is
why it survived; `e2e/171-tier368-auth-audit-signed.sh` now does.

**3. The foreign keys were rewriting signed rows.** `AuditLog_userId_fkey` and
`AuditLog_companyId_fkey` were **ON DELETE SET NULL**, so deleting a user made
PostgreSQL silently null `userId` on rows that user had already produced —
signed ones included. The hash covers userId, so the stored hash then described
a row that no longer existed and verifyChain reported `hash_mismatch` with
nobody tampering. Measured: 4 such rows, e.g. a `login_success` whose
`entityId` still held `user-2fa-test-…` (entityId has no FK, so it survived)
while `userId` was gone. **Not** specific to this tier's rows — an
`invoice.updated` row from the extension was in the same state; those were
unsigned before, so verifyChain skipped them.

Fixed by dropping both FKs (migration `20260912000002_audit_log_drop_actor_fks`;
the operator chose this over an actor-snapshot column). `companyId`/`userId` are
plain snapshots now and may name ids that no longer resolve — which is what an
audit trail should do. The six Prisma relation queries were replaced by
`AuditService.attachUserEmails()`: one batched lookup that shapes the result
exactly like the old relation, so every `r.user?.email` consumer is unchanged.
The two raw-SQL paths already used a manual `LEFT JOIN` and never needed the FK.
`ON DELETE NO ACTION` was not an option: seven e2e specs delete users via raw
SQL, and `161-tier231-users-crud.sh` asserts on the delete succeeding.

**4. Deleting an audit row in test cleanup breaks the chain.** Once these rows
are signed, a `DELETE FROM "AuditLog"` in a spec's cleanup removes a link: the
next row's `previousHash` points at a hash that exists nowhere and verifyChain
reports `previous_hash_mismatch`. Measured: seq 334/335 simply gone, specs 170
and 171 both failing on it. The offenders were `117` (two DELETEs of
`assets.afa.auto_booked`) and `170` itself (two DELETEs I wrote in Tier 367).
Audit rows are append-only:
- `170` **restores** the tampered payload instead of deleting it, and asserts
  the row verifies again and the chain is intact on exit.
- `117` records `BASELINE_SEQ = MAX(seq)` up front and scopes its assertions to
  `seq > $BASELINE_SEQ` instead of deleting leftovers.
- `116` / `120` took audit rows with `ORDER BY "createdAt" DESC LIMIT 1`. Since
  `writeActivity` rounds createdAt to whole seconds that is ambiguous (120 does
  four PATCHes inside one second) — both order by `seq` now.

**5. The Tier 196 Playwright spec no longer launders the chain.** Its
`beforeAll` ran `audit-rehash.ts` before every test, rewriting every hash and
pointer — which is why the Tier 367 defect hid there for ten tiers. Removed.
Test 3 saves the payload it tampers with and restores it, so the spec leaves no
broken chain behind. Its two `test.skip()` escapes ("chain was already broken",
"row's stored hash doesn't match recompute") are hard assertions now — both were
silent-green traps. Tests 2 and 3 also picked their target row with
`ORDER BY "createdAt" DESC`, which among same-second rows could return a MIDDLE
row — exactly what the spec's own comment said it had to avoid. Both use `seq`.

A methodology note worth keeping: my first grep for specs mutating AuditLog used
`DELETE FROM \"AuditLog\"`, which the shell turned into `DELETE FROM "AuditLog"`
— but specs write that SQL inside bash double quotes, as `\"AuditLog\"`. Every
hit was missed and I concluded "only ci-seed touches AuditLog" while spec 170
itself had two DELETEs. Grep the table name alone and filter, rather than
guessing the quoting.

Verified on a fresh CI-equivalent stack: backend e2e **171 passed / 0 failed**
(including the new spec 171), full Playwright **912 passed / 0 failed / 0
skipped**, backend + frontend `tsc` and `eslint --max-warnings 0` clean.
`e2e/41-migrate.sh` runs `prisma migrate deploy` on a throwaway DB, so both new
migrations are exercised. One caveat found on the way: `gobd-archive.spec.ts:87`
fails when Playwright runs on a **subset**, because it assumes Expense rows that
an earlier spec creates (ci-seed inserts none); it passes in the full run.

### Silent skips removed; three intentional ones documented (Tier 369)

28 call sites changed across 12 spec files. Three `test.skip()` calls remain,
each with its reason written into the code.

**Dead branches (10, deleted).** `customer-detail-page-tier232` ×5 and
`customer-detail-tabs-tier238` ×5 all guarded on
`if (!TEST_CUSTOMER_ID) test.skip(…)`. Neither guard could ever fire: tier232's
`beforeAll` already throws on a failed create, and tier238 assigns a **hard-coded
constant**. They only made the specs look like they had a fallback. Both
`beforeAll`s gained a real check instead — tier232 asserts the create returned an
id; tier238 now GETs its hard-coded seed customer (`f84ebd20-…`, created by the
Tier 50 e2e) and throws naming the id if it is gone. That row is a genuine hidden
dependency — the anti-pattern `fixtures/test-env.ts` opens by warning about — and
if it vanished the page would simply render empty while the "tab is visible"
assertions kept passing.

**Data-precondition skips (15, now assertions).** Each was checked against what
ci-seed actually creates before being converted:
- `audit-fulltext-search` ×2 — ci-seed seeds invoices for this company.
- `cost-center-suggest-prefix` ×4 — ci-seed creates the SKR03 defaults and stamps
  a VoucherLine with `costCenter='VERTRIEB'` on account 4960 (ci-seed.sh:320/341),
  so both "no accounts seeded" and "no account has cc stamps" are real failures.
- `installment-plan` ×3 — the first test in the describe creates the plan, and
  `playwright.config` pins `workers: 1` + `fullyParallel: false`, so it always
  runs first. The skip only ever fired when that create FAILED, turning one real
  failure into three green runs.
- `portal` ×3 — bare `test.skip()` on a missing auth cache, invoice, or payment
  token; the token is what the endpoint under test exists to return.
- `customer-detail` ×1 — "test customer unexpectedly has invoices", on a customer
  created fresh in `beforeAll`; the skip text said "unexpectedly" itself.
- `assets-afa` ×1 — `isVisible()` + skip. `isVisible()` does not wait, so slow
  hydration passed silently; the preceding test already asserts the same button
  web-first.
- `supplier-vies-batch` ×1 — "VIES batch didn't complete in 60s (rate limit)",
  but CI and local-ci-stack both export `VIES_MOCK=1`, so there is no token
  bucket to exhaust and a timeout would be a real regression.

**Kept, with reasons in the code (3; the `webhooks` one removed in Tier 381 — its cron explanation was wrong).** `webhooks` (the delivery row comes from
the cron, so a 30s miss can be tick timing; its wait is already a web-first
`waitFor`, not a `.count()` probe), `admin-ops-tier195` (safety guard: outside CI
`backupRoot` may be a developer's real backup directory), `vies-batch-tier134`
(environment precondition on `VIES_MOCK`).

The older §8 note claimed "62 runtime skips across 29 files". That was never
measured with a pattern that matches the code: `test.skip(true` misses both the
multi-line `test.skip(\n  true,` form (webhooks, admin-ops) and the bare
`test.skip()` (portal ×3) — the same class of mistake as Tier 368's grep for
`DELETE FROM \"AuditLog\"`. Count the bare symbol and filter comments from the
*content* field: grep output is `file:line:content`, so `grep -v "^\s*//"`
filters nothing at all.

Verified: full Playwright **912 passed / 0 failed / 0 skipped** on a fresh
CI-equivalent stack; frontend `tsc` + `eslint --max-warnings 0` clean; backend
untouched this tier. Every converted assertion held — which is the point: those
15 sites had never once been exercised without their escape hatch.

**Tier 369b — CI then surfaced a flaky, which is the same disease.** The Tier
369 run (34696678293) was green but reported `911 passed, 1 flaky`:
`admin-activity-log-tier202.spec.ts:165` ("webhook.requeue writes an activity
row") failed its first attempt in 196ms and passed on retry. Not caused by this
work — Tier 368 never touched the webhook module, Tier 369 only added a comment
to `webhooks.spec.ts`, and the two previous CI runs were clean 912s. A
low-frequency pre-existing race.

Root cause: `POST /webhooks/:id/test` dispatches asynchronously, and the spec's
polling loop waited only for the delivery ROW to appear — not for it to reach a
terminal status. It then forced `status='exhausted'` via psql while the HTTP
attempt was still in flight; that attempt landed a moment later and overwrote
the status with success/failed, so `requeueDelivery` — which accepts only
`exhausted` (webhook.service.ts:713) — returned 400 and the test died on
`expect(rq.status()).toBe(200)`. The loop now waits for
`success|failed|exhausted` (the deliveries list already selects `status`) and
asserts the terminal status before forcing it. That closes the window instead of
widening a timeout.

Worth stating plainly, because it is the same lesson as the skips: a flaky test
hides a real failure exactly as a silent skip does — behind a retry rather than
behind a green skip. It belongs in this tier, not in a TODO.

### Backend specs that could not fail (Tier 370)

`run-all.sh` judges a spec by its **exit code and nothing else**
(`if run_spec "$t"; then PASS++`). Tier 370 audited the bash harness for specs
whose exit code could not become non-zero.

**Two real defects, both fixed:**
- `55-fints-real-integration.sh` sources `_lib.sh` and calls its
  `fail` / `assert_eq` / `assert_status`, which bump the **lib** counter
  `FAILS` — but it also declared its own `PASS=0` / `FAIL=0` and ended with
  `exit $FAIL`, a variable nothing incremented. Every failed assertion was
  printed and then discarded. Its summary line even printed `lib FAILS=`: the
  divergence had been noticed, the exit code was never changed. Now
  `exit $(( FAIL + ${FAILS:-0} ))`.
- `22-mahnung-cron.sh` did `summary; exit 0` in its throttled branch, after two
  `assert_eq` calls had already run. `summary` returns 1 after a failure; the
  `exit 0` threw it away. Now `exit $?`.

The full suite stayed green with `lib=0` in both, so the defects were real but
**latent** — no red build was hiding. A green suite only proves no regression,
not that a fix works, so the fix was proven separately with synthetic scripts:
old shapes exit 0 after a lib `fail`, new shapes exit 1, and a passing run still
exits 0.

**Guard:** `e2e/172-tier370-harness-exit-codes.sh` (no backend needed, <1s)
statically rejects both shapes across every spec and checks the `_lib.sh`
semantics the fix relies on. It was verified in both directions on a copy of
the tree: re-injecting either old shape makes it fail; the current tree passes;
a spec that only *mentions* `_lib.sh` in a comment is not flagged.

**Checked and clean:** no spec has `summary` anywhere but last (155 specs call
it); no spec calls a helper it neither defines nor loads — which would make
bash print `command not found` and silently skip the assertion. The other 14
specs that skip `summary` are legitimate: they fail fast with `exit 1`, or keep
their own counter and helpers consistently.

**A correction worth keeping.** The first pass also "fixed" `44-rbac.sh` and
`47-journal-cap.sh`. Both were fine: neither loads `_lib.sh` — each defines its
own `assert_eq` that bumps its own `FAIL`, so `exit $FAIL` was correct. The
survey had used `grep -c "source.*_lib"`, which matched a **comment** ("this
script does not source _lib.sh"). It was caught only because the guard was
tested by injection: an injected 44 was ignored — correctly — which exposed the
diagnosis, not the guard, as wrong. Both were reverted to HEAD, and the guard's
rule now requires a real non-comment `source`/`.` line. That is the fourth
pattern mistake in Tiers 368–370 (`DELETE FROM \"AuditLog\"`, `test.skip(true`,
the `grep -vE "^\s*//"` that could not match `file:line:` output, and this one):
**before trusting a survey, inject the thing you are looking for and confirm the
survey sees it.**

**Skips (done in Tier 371, see below):** `skip_if` in `_lib.sh`,
`16-dark-mode.sh` and `163-tier238-customer-detail-tabs.sh` used to exit 0 and
count as passed; they now exit 77 and `run-all.sh` counts and lists them.

Verified: backend e2e **171 passed / 0 failed** on a fresh CI-equivalent stack
with the 55/22 fixes; guard 172 verified standalone in both directions; then CI
run 34842448618 ran the whole thing — **172 passed / 0 failed**, the guard
checking 154 lib-assertion specs inside a full `run-all.sh`, Playwright 912
passed with no flaky.

### Checks that had never run in CI; skips made visible (Tier 371)

Started as "give skipped specs their own exit code". The CI log of run
34842448618 — the ground truth, not a static search — showed which skips
actually fire, and three of them were hiding checks that had **never executed
in CI**:

- **`49-elster-xml.sh` — the whole spec.** On CI's fresh database there is no
  UStVA filing, so it creates one. The payload still sent `outputVat`,
  `inputVat`, `payableVat`, `intraEUSales`, `intraEUPurchase`, which
  `SaveUstvaFilingDto` (= `UstvaDataDto` + `taxNumber`/`notes`/`status`, with
  `forbidNonWhitelisted`) rejects → HTTP 400 → `SKIP … 0 passed, 0 failed` →
  `exit 0` → counted as a pass in every run. Locally it "worked" because the dev
  DB already had a filing. Fixed payload (compute output + taxNumber + status,
  verified 201 and a 200 XML), and a failed create now `exit 1`.
- **`59-tier27-ust-behandlung.sh` — the §13b PDF footnote.** Three faults at
  once: the URL omitted `?companyId=`, so the endpoint answered **HTTP 500**
  `{"error":"PDF generation failed"}`; the body went into a bash variable, which
  drops NUL bytes; and CI has no `pdftotext`, while a raw grep cannot see text in
  a FlateDecode stream — so it printed SKIP. Now saved to a file, asserted as
  HTTP 200 + `%PDF-`, and read with `_lib.sh`'s `pdf_contains`, verified to find
  "§13b" and "Steuerschuldnerschaft" and NOT find unrelated words.
- **`60-tier28-search.sh` — invoice search.** Skipped whenever the search was
  empty, and in CI it always was: ci-seed inserts no invoice for Müller, and its
  raw-SQL invoices have an empty `customerName` (the service fills that snapshot
  on create; a raw INSERT does not). The spec now creates a Müller invoice via
  the API and requires the hit. (Checked first whether this was a product bug —
  it is not: `invoice.service.ts:761` writes `customerName`.)

**Skips are now visible.** Exit code **77** means skipped (automake/TAP
convention). `skip_if` in `_lib.sh`, `16-dark-mode.sh` and
`163-tier238-customer-detail-tabs.sh` exit 77; `run-all.sh` counts it separately
and prints `Total: N passed, M failed, K skipped` plus the list. Skips do not
fail the run; the run's exit code still reflects failures only. Guard 172 gained
rule 2b: a spec that prints SKIP and then `exit 0` fails the guard (verified by
re-injecting `exit 0` into 16-dark-mode — flagged at line 30).

**Left as is, on purpose:** the in-spec mode branches in `61-tier29-ocr.sh`
(mock vs tesseract blocks are mutually exclusive), and the nginx note in
`51-cloudflare-real-ip.sh` (documents an untestable case; no assertion is
skipped).

**Still skipping inside 49 — and why it matters.** Four checks
(`<Umsatzsteuervoranmeldung>`, `<DatenLieferant>`, B-prefix, `<Kz81>`) still
print SKIP. Their old reason, "no Kz values in this draft", was false: they look
for elements `elster.service.ts` **never emits** — it writes amounts as
`B-Kz081=…` lines in `<Kennzahlen>`/`<Feld>`. Changing the period does not help
either (every quarter computes `umsatzsteuer=0` on seed data, whose invoices
have no items). The messages now state the real reason. Whether the generator
or the spec matches the official ELSTER schema is **§9 item 9** — a possible
compliance issue for a tax filing format, not something to change inside a test
tier.

**Minor backend robustness issues noticed here** — a missing `companyId` on
`GET /invoices/:id/pdf` and an out-of-range `vatRate` on invoice create, both
500s — were fixed in Tier 372 (below).

Lesson, again: the Tier 370 static search for "SKIP then exit 0" found 3; the CI
log showed the rest, including skips that don't exit at all but step over one
assertion. **For "what never runs", read the CI log, not the code.**

Verified on a fresh CI-equivalent stack: the three specs standalone on an empty
DB (49 took the create path), guard 172 both ways, and the full suite:
**171 passed / 0 failed / 1 skipped** (`16-dark-mode.sh`).

### Client errors answered as 500s, or silently as 200s (Tier 372)

**Fixed:**
- **Invoice create/update bounds.** `InvoiceItemDto` had bare `@IsNumber()` on
  `quantity`, `unitPrice`, `vatRate`; `CreateInvoiceDto`/`UpdateInvoiceDto` the
  same on `discountPercent`, `discountAmount`. Values beyond the Decimal column
  failed in Postgres with "numeric field overflow" → 500 (measured: `vatRate: 19`,
  `quantity: 1e9`). Values that fit the column but are meaningless (`vatRate: 5`,
  `discountPercent: 150`) had no check at all — not measured before the fix, so
  not claimed. Now: `vatRate` 0..1 (a fraction, like the expense / cashbook /
  product DTOs and like the frontend sends it), `discountPercent` 0..100 (like
  `skontoPercent`, and like the UI input's `min="0" max="100"`), and `quantity` /
  `unitPrice` / `discountAmount` bounded to their `Decimal(12,4)` range **in both
  signs** — that only turns the 500 into a 400; whether negative lines are
  allowed was not decided here. No frontend or e2e payload exceeds the new bounds.
- **`GET /invoices/:id/pdf` without `?companyId=`** → 500 "PDF generation failed".
  The auth guard reads the `x-company-id` header, so the request passed auth and
  then Prisma threw on `companyId: undefined`. Now 400 up front (the handler's
  catch rethrows HttpExceptions).
- **`GET /reports/vat`**: a missing or non-numeric `year` → `parseInt` → NaN →
  Invalid Date → 500; and `quarter=9` / `month=13` were answered 200 with a report
  for a period that does not exist. A missing year now defaults to the current
  year (like `/sales` and `/customers` in the same controller); an invalid year,
  quarter or month is 400.

**How the scope was found, not guessed:** a sweep called all **182**
parameter-less GET routes without `companyId` (153 of them read it). Only
`/reports/vat` answered 500 — so the PDF route was an isolated case, not a
pattern. Regression spec: `e2e/173-tier372-client-errors-are-400.sh` asserts
every 400 above **and** that the valid requests (vatRate 0.19 and 0, discount
10 %, the PDF, `/reports/vat` defaults) still succeed.

**Done in Tier 373 (below):** the recurring-invoice routes had **no DTO
validation at all**. `recurring.controller.ts` types its
bodies as TypeScript intersections (`{ createdById?: string } & RecurringInput`,
`Partial<RecurringInput> & { isActive?: boolean }`); Nest's ValidationPipe can
only validate classes, so these bodies pass through unchecked — `vatRate: 19`
there would hit the same overflow. Converting them to DTO classes is the right
direction, but with the global `whitelist + forbidNonWhitelisted` any field the
recurring UI sends that the new DTO does not declare would start failing with
400. Do it with the frontend payloads enumerated first and a Playwright run of
the recurring specs, not as a side edit.

Verified on a fresh CI-equivalent stack: probes for every case (400s and the
still-valid 201/200s), the route sweep, and the full suite **172 passed /
0 failed / 1 skipped**; spec 159's valid `/reports/vat` calls still pass.

### Recurring-invoice bodies validated, callers enumerated first (Tier 373)

`recurring.controller.ts` typed its bodies as TypeScript intersections, which
ValidationPipe cannot validate, so create / update / clone bodies were not
checked at all. New `src/modules/recurring/dto/recurring.dto.ts`:
`CreateRecurringInvoiceDto`, `UpdateRecurringInvoiceDto`,
`CloneRecurringInvoiceDto`, `RecurringItemDto`.

**The risk was the global `forbidNonWhitelisted`**: any field a caller sends that
the DTO does not declare becomes a 400. So every caller was enumerated before a
single decorator was written:
- frontend `recurring-invoices/page.tsx`: create/update (`createdById`, `name`,
  `customerId`, `interval`, `intervalCount`, `dayOfMonth`, `startDate`, `endDate`
  or `null`, `invoiceStatus`, `sendEmail`, `items`), pause
  (`isActive` + ISO `pausedUntil`), un-pause (`pausedUntil: null`), clone.
  Items come from `openEdit` or the `from-invoice` prefill — both already
  normalised to `{description, productNumber, quantity, unit, unitPrice,
  vatRate}` with numbers, so no stray `id`/`recurringInvoiceId` reaches the API.
- e2e 35 and 90 send **`companyId` in the body** → declared optional and ignored
  (the controller drops it; the company always comes from the query string).
  153 sends `currency: "USD"` and an item without `unit`.
- Playwright: recurring-stats (create), -pause (PUT), -clone.
The first caller search missed the Playwright files entirely — they write
`request.post(` with the URL on the next line. The per-file count found them.

Bounds only guard columns or restate existing rules: item `vatRate` 0..1,
`quantity`/`unitPrice` to their `Decimal(12,4)` range in both signs,
`intervalCount` ≥ 1 (0 would never advance `nextRunAt`), `dayOfMonth` 1..31,
`invoiceStatus` draft|sent and `interval` as in `VALID_INTERVALS`, `currency`
3 letters. `startDate`/`endDate` must be `YYYY-MM-DD`: `normalizeDates()` appends
`T00:00:00.000Z`, so a full timestamp would have become an Invalid Date — every
caller already sends date-only (the prefill uses `.toISOString().slice(0,10)`).
The service reads patch fields one by one and never spreads the body into
Prisma, so whitelist-stripping undeclared keys changes nothing it uses.

Spec `e2e/174-tier373-recurring-dto.sh` replays every caller shape above (must
succeed) and asserts 400 for item `vatRate: 19`, an undeclared field, a
full-timestamp `startDate`, `intervalCount: 0` and `dayOfMonth: 40`.

Verified on a fresh CI-equivalent stack: all 12 Playwright specs that touch
`recurring-invoices` — **64 passed / 0 failed**, including the UI save, edit,
pause, clone and convert flows; then the full backend suite **174 passed /
0 failed**. (It reported 0 skipped, not 1: the Playwright run had left the
frontend dev server on :3100, so `16-dark-mode.sh` found one and ran. In CI's
e2e job there is no frontend, so it skips there.)

### Money routes validated: payments, credit notes, Kassenbuch (Tier 374)

**Survey first.** A script listed every `@Body()` in a controller and classified
its declared type: **135** bodies, only **27** class DTOs; the rest are inline
object literals, interfaces/type aliases, `@Body('field')`, a `Partial<>`, an
`any` — none of which ValidationPipe checks. Calibrated against raw grep (135)
and known cases. It had one **false positive**: `POST /accounting/vouchers`
looked unvalidated because `voucher.service.ts` declares an
`interface CreateVoucherDto` with the same name as the class the controller
actually imports from `./dto/voucher.dto`. Matching type names across the tree
is wrong; the survey now resolves the name through the controller's own
imports. The reverse trap is real too: `AssetCreateDto` / `AssetUpdateDto` /
`AssetDisposeDto` are **interfaces** in `assets.service.ts` — named like DTOs,
not validated. After this tier: 135 bodies, 34 validated, **101 not** (6 fixed
here + the voucher false positive). Highest-risk remaining: accounting voucher
status/reversal/correct, `voucher-templates/:id/apply`, the Anlage settings
PUTs, `payments/batches`, `payments/mandates`, `direct-debit/batches`, assets.

**Measured before the change** (fresh stack, not inferred):
| Route | Body | Before |
|---|---|---|
| `POST /invoices/:id/payments` | `{}`, `paymentDate:"abc"`, `amount:1e12` | 500 |
| `POST /invoices/:id/credit-note` | `amount:1e12`, line `vatRate:19` | 500 |
| `POST /invoices/:id/credit-note` | `amount:"zehn"`, `-50`, `0` | **201 — full refund** (-119 on a 119 invoice) |
| `POST /cashbook/entries` | `businessDate:"abc"`, `vatRate:19`, `amount:1e12` | 500 |
| `POST /cashbook/close-day` | `date:"abc"` | 500 |

The credit-note one is the real finding: a non-number or non-positive `amount`
failed the service's `amount > 0` test and fell through to the mirror-every-line
branch, so a typo produced a credit note for the whole invoice.

**Callers enumerated before any decorator** (multi-line aware; `$INV1_ID`-style
variables with digits defeated the first regex): invoice detail page
(payment form, credit-note modal), cashbook page (save, storno, Z-Bericht,
reopen), backend e2e 01–07, 50, 52, 80, 81, 83, 85, 149, Playwright
credit-note, sequence-tier174, cashbook-signature-tier194. Shapes that shaped
the DTOs: `vatRate`/`counterparty`/`belegNumber`/`notes` sent as `null`
(cashbook page), `paymentDate` as both `YYYY-MM-DD` and a full ISO timestamp
(e2e 52/83), a storno with no `reason` (e2e 03 expects the service's
"Begründung" message).

**e2e 07's fixture branch was broken twice over, silently.** It only runs
when the company has no paid invoice — never in CI, whose seed has one (the
full local run confirmed the branch was skipped). Forced on a fresh stack: the
invoice create sent `status: "paid"`, which `CreateInvoiceDto` does not
declare → 400 into `/dev/null`, so `INV_ID` picked whatever invoice was newest;
then the payment said `method`, not `paymentMethod` → 500 (measured on the old
code), also into `/dev/null`. Both bodies are fixed, both steps assert 201, and
`INV_ID` comes from the create response. Verified with the branch forced and
unforced. (The Tier 334 SQL status patch stays; whether the create path also
overwrites `status` was not measured.) **Lesson: a spec's fallback branch that
CI never enters is untested code — force it once.**

New DTOs: `invoice/dto/payment-credit-note.dto.ts` (`CreatePaymentDto`,
`CreateCreditNoteDto`, `CreditNoteLineDto`) and in `cashbook/dto/cashbook.dto.ts`
`CreateCashBookEntryDto`, `ReverseCashBookEntryDto`, `CloseCashBookDayDto`,
`ReopenCashBookDayDto`. Bounds follow the `Decimal(12,4)` / `Decimal(5,4)`
columns; dates are `IsDateString({ strict: true })` (rejects 30 February).
Checks the services already make with a German message the specs assert
(payment amount > 0, blank description, missing storno reason, Z-Bericht
differenz note) were deliberately **left in the services**. The controller's
plain `throw new Error(...)` for missing payment fields is gone.

Spec `e2e/175-tier374-money-routes-dto.sh`: section 1 replays every caller
shape (must succeed, service messages unchanged); section 2 asserts 400 for
each measured case above and that no payment, credit note, entry or close was
written by the invalid requests.

Verified on fresh CI-equivalent stacks: the 8 Playwright specs that touch
these routes or pages (cashbook-signature-tier194, cashbook-tier223,
credit-note incl. the modal submit, customer-detail-tabs-tier238, direct-debit,
payments, sequence-tier174, ustva-history-tier161) — **52 passed / 0 failed**;
the full backend suite **174 passed / 0 failed / 1 skipped** of 175 specs
(`16-dark-mode.sh`, no frontend); `tsc` and `eslint` clean.

### Authentication default-deny + tenant binding (Tier 375)

Started as the next DTO batch; stopped when `AccountingController` showed 57
routes, **zero `@Require`** and guards on only some methods. Measured, not
inferred, on a fresh stack:

**1. 49 of 449 routes had no guard at all.** A no-credentials sweep of every
route (only a `companyId` in the query) got: `GET /accounting/accounts` and
`GET /accounting/vouchers` → 200 with the chart of accounts and every
Buchungsbeleg; `POST /accounting/accounts` → 201 (account created);
`POST /ocr/match-supplier` → 201 (supplier created); `GET /mail/config` → 200
with the SMTP host and user (**correction, Tier 376:** this said the response
included `smtpPassword` — the field is there but the controller always sends
`''`; I saw the key and did not check the value); `PUT /mail/config` (redirect a
tenant's outgoing mail — it keeps the stored password when the field is empty,
so the new host receives it), voucher reversal/status/generate and `PUT /inventory/:id/adjust`
reached their handlers (404 only for the dummy id). Unguarded modules:
accounting (13 routes), inventory, mail, ocr, vat-rates — plus the routes that
are public by design.

**2. Cross-tenant reads for any registered user.** Registration is public.
Tenant B, with its own valid headers and `?companyId=<A>`, got **200 with A's
invoices and customers**. The guard verified `x-company-id`; handlers read the
query string; nothing compared them. The ~20 existing "cross-tenant → 401"
assertions all send a wrong **header**, never a wrong query string — which is
why it was never caught.

**Fix** (`src/auth/public.decorator.ts`, `header-auth.guard.ts`, `app.module.ts`):
- `HeaderAuthGuard` is an **`APP_GUARD`**: every route needs the headers unless
  marked **`@Public()`**. 23 routes are public: auth login/register/forgot/
  reset, 2fa verify, the token-based customer-portal and `/portal/:token`
  routes, invitations verify/accept, health/system-health/metrics,
  `POST /system/errors`. Existing `@Auth()`/`@UseGuards(HeaderAuthGuard)` stay;
  the second run returns early (`req.headerAuthDone`), no extra DB lookups.
- The guard **binds `companyId`** in path, query and JSON body to the
  authenticated company → **403** "Kein Zugriff auf diese Firma". A repeated
  `?companyId=` (array) is refused too. `@AllowOtherCompanyId()` exempts
  `POST /users/me/switch-company`, which checks the grant itself.
- Frontend: three raw `fetch()` calls sent no auth headers and only worked
  *because* their routes were unguarded — voucher detail
  (`accounting/[id]/page.tsx`), mail config save and mail test
  (`settings/page.tsx`). Now `apiGet` / `apiFetch`.

**Specs.** New `e2e/176-tier375-auth-default-deny.sh`: (1) static — the guard
is `APP_GUARD` and the `@Public()` set equals a reviewed list, so a new public
route is a deliberate spec edit; (2) runtime — every other route (386 fired,
host/bank/mail mutations excluded, they are covered by 1) answers 401 with no
credentials; (3) the measured routes above are 401; (4) public routes still
work; (5) tenant B naming A in query or body → 403, own tenant 200, and
record-level scoping with the tenant's *own* companyId still 404; (6)
switch-company → 403 without a grant, 201 with one. Its first run failed on
its own parser (`@Throttle({ default: {…} })` braces hid an `@Public()` above
them) — the runtime sweep flagged the same five routes independently.
Changed: 156/160/163 asserted 404 for a foreign `?companyId=`; the guard now
answers 403 before any lookup, **also for ids that do not exist** (asserted),
so there is still no existence oracle. 165 used `companyId:"X"` as its
"unknown field" and now uses the tenant's own id. Playwright
`kontoauszug-email-tier154` sent a foreign body `companyId` expecting 400/404;
now 403.

Verified on fresh CI-equivalent stacks: full backend suite **171 passed /
4 failed / 1 skipped** — the four were exactly 156/160/163/165 above; after the
edits each passed when re-run (with 176 re-run after its extension). Full
Playwright **911 passed / 1 failed** — the tier154 case above; re-run of that
spec 7/7. The voucher detail page was checked in a browser against the new
guard. `tsc` + `eslint` clean on both sides.

**Still open after Tier 375:** the header auth itself is forgeable — §9
item 10. The role, `/health/summary` and `VatRate` items listed here were
fixed in Tier 376 (below). `SECURITY-AUDIT-2026-09-06.md` rated auth ✅ and
missed all of this — treat its verdicts as unverified.

### Roles enforced everywhere, `/companies/:id` bound to the tenant (Tier 376)

Started as the Tier 375 leftovers; measuring them found a worse hole. On a
fresh stack, before the change:

- **Any registered user could overwrite another tenant's company.** Tier 375
  bound parameters *named* `companyId`; `CompanyController` calls it `:id`.
  Tenant B (admin of its own new company, so `company.update` passes) sent
  `PUT /companies/<A>` `{"name":…}` → **200 and A's name changed in the DB**;
  `GET /companies/<A>`, `/datev-config`, `/feature-flags` → 200 with A's data.
- **A `viewer` could write.** 96 non-public routes had no `@Require` (55 in
  `accounting.controller.ts`). A viewer granted on A: `POST /accounting/accounts`
  → 201, `POST /assets` → 201, `POST /ocr/match-supplier` → 201,
  `PUT /mail/config` → 200.
- **`@Require` that never ran.** `RolesGuard` only runs where a controller
  applies `@Auth()` or `@UseGuards(…, RolesGuard)`. The nine installment-plan
  routes had `@Require('invoice.*')` under `@UseGuards(HeaderAuthGuard)` alone.
- **VAT rates leaked between tenants.** `POST /vat-rates` stored
  `companyId NULL`; tenant B's DE 99 % rate was what tenant A's
  `GET /vat-rates/current` returned.
- `GET /health/summary` was public and counted the whole installation.

**Fix:**
- `RolesGuard` is a second `APP_GUARD` (after `HeaderAuthGuard`).
- `@Require` added to all 96 routes: GETs → `accounting.read` / `company.read` /
  `product.read` / `expense.read` / `reports.read` / `customer.read` /
  `invoice.read` / `admin.read`; writes → `accounting.create|update`,
  `company.update` (mail config + test, logo, VAT rate create),
  `product.update`, `expense.write`; `GET /accounting/accounts/seed` (it
  writes) → `accounting.create`; `POST /assets/_test/auto-booker-trigger` →
  `admin.update`.
- Read-only mode's allowlist lacked `company.read`, `expense.read`,
  `payment.read`, `admin.read`, `berater.note.read` — reads that would have been
  refused once guarded. Added.
- `@CompanyIdParam('id')` on `CompanyController`: the guard binds that param
  like `companyId`.
- VAT rates: create always sets the caller's company; reads return global rows
  plus the caller's own.
- `/health/summary`: `@Require('company.read')`, counts scoped to the company
  (companies = the user's grants). `/health`, `/health/deep`, `/metrics` stay
  public. (`/metrics` still exposes platform-wide business gauges; nginx
  restricts it per `infra/prod/nginx.conf`.)

**Specs.** New `e2e/177-tier376-roles-and-company-scope.sh`: static — RolesGuard
is global, `CompanyController` binds `:id`, and the routes without any role
check equal an 11-entry reviewed list (auth/me, 2fa, users/me/*, search — search
filters per entity in its service); runtime — each measured viewer write → 403
with no row written, viewer reads 200, read-only reads 200 / writes 403, tenant B
on `/companies/<A>` → 403 with A's name unchanged, VAT rates invisible across
tenants. Updated: 167 and Playwright `metrics-observability-tier193` (summary
now authenticated and scoped; 167 asserts the counts equal the company's), 165
(created rate belongs to the caller), 176 (22 public routes).

Only self-service routes and search now lack a role check. What remains is the
forgeable header auth (§9 item 10) — and with it, read-only mode is still a
client choice (`x-readonly`), not a server-side property of the user.

**Found on the way, fixed:** a second storno of the same Kassenbuch entry
answered **500** (`CashBookEntry.reversesId` is `@unique`, P2002). e2e 03 sent
exactly that request and never asserted its status; only the backend log showed
it. Now 400 "Diese Buchung wurde bereits storniert.", asserted in 03. 120
expected 400 for `/companies/<nonexistent>/feature-flags`; the guard answers
403 first. **Lesson: grep the backend log for `] 500` after a suite run — a
green suite can hide server errors in unasserted requests.**

**Seen once, not explained:** in the first full run `15-dashboard-kpis.sh` got
a 500 from `GET /reports/dashboard`. Its backend log was lost — spec 20 restarts
the backend and `start-backend.sh` truncates `/tmp/backend.log`. Not reproduced
in three attempts (spec alone; specs 01–19 in order on a fresh stack; a full run
with `tail -F /tmp/backend.log` capturing across the restart — that run's only
500 was the one below). If it recurs, capture the log the same way.

**Noted, not changed:** a CORS preflight from a disallowed origin answers 500
(`enableCors` callback error) and is logged as ERROR + a system-error
notification per request; e2e 125 accepts 500. Returning 403 quietly would stop
anyone from filling the error inbox with preflights.

Verified on fresh CI-equivalent stacks: first full backend run **174 passed /
2 failed / 1 skipped** (15 above, and 120); after the fixes **176 passed /
0 failed / 1 skipped** of 177 specs. Full Playwright **912 passed / 0 failed**.
`tsc` + `eslint` clean.

### CORS 403, voucher/asset bodies, own accounts only, relative API URLs (Tier 377)

All measured on a fresh stack before changing anything.

**CORS.** A request from a disallowed Origin — preflight or not, no credentials
needed — answered 500 and wrote one `ErrorEvent` row plus a notification per
request; the fingerprint includes the URL, so varying the query string created
new rows without limit (6 requests → 6 rows). The `cors` origin callback can
only reject by raising an Error. A middleware registered before `enableCors`
now answers 403 without touching the exception filter. e2e 125 asserted
"500 or 403 or 401"; it now requires 403, no `Access-Control-Allow-Origin`, and
no new `ErrorEvent` row (it failed 3 assertions against the old code).

**Bodies** (callers enumerated first: voucher detail page, accounting page,
assets page, e2e 10/11/14/50/58/69/70/71/76/77/109/160/177, Playwright
voucher-correct, voucher-correct-cost-center, voucher-template-autopersist,
assets-afa):
| Route | Before | Now |
|---|---|---|
| `POST /accounting/vouchers` (had a DTO) | line debit 1e12 → 500 | 400 (`@Max` on debit/credit/vatAmount) |
| `POST /accounting/vouchers/:id/correct` | date "abc", 1e12, "zehn", vatRate 19 → 500; **negative debit/credit → 201** | `CorrectVoucherDto` (same line DTO as create) → 400 |
| `PUT /accounting/vouchers/:id/status` | "bogus"/missing → 200, nothing done | only `"voided"`; no caller exists |
| `POST /voucher-templates/:id/apply` | amount "zehn", date "abc", 1e12 → 201 | `ApplyVoucherTemplateDto` → 400 |
| `POST/PATCH /assets`, `/dispose` | invalid date, 1e14 (Decimal 14,4), "hundert" → 500; ND 12.5 → 201 | `dto/asset.dto.ts` → 400 |

The asset bodies were typed `AssetCreateDto` etc. — **interfaces** in
`assets.service.ts`, named like DTOs and invisible to ValidationPipe. PATCH with
`verkauftAm` did **not** bypass dispose (the service ignores the field; measured).

**Voucher lines on another tenant's account.** `VoucherService.create` and
`correct` never checked that `accountId` belongs to the company: company A's
voucher with tenant B's account id → **201, the line stored on B's account**;
an id that exists nowhere → FK error → 500. Both now 400 via
`assertAccountsBelongTo`. The same check runs for the internal callers
(bank-import, credit balance). The general question — which other body ids
(customerId, supplierId, expenseId…) are not checked against the tenant — is
**open**: invoice create with B's customer was already 404 (measured), so it is
per-route, and needs its own survey.

**Relative `/api/v1` URLs.** Six raw `fetch()` calls used a relative URL
(voucher reversal + correction, berater note create + acknowledge, attachment
upload, invoice-template preview). Next has no rewrites, so outside nginx they hit
the Next server: the Playwright test for the correction modal only captured the
request payload — tightened to assert the response, it failed against the old
code with `http://localhost:3100/…/correct`. Now `apiFetch` (API_BASE + auth
headers). **Regression from Tier 375 fixed:** the voucher PDF button did
`window.location.assign('/api/v1/accounting/vouchers/:id/pdf')` — it only worked
because that route had no guard; a navigation cannot send the auth headers, so
since Tier 375 it was a 401. Now `apiGetBlob` + a new Playwright test that clicks
it (not run against the old code).

**Still open — backend URLs not passed straight to an `api*` helper.** A
multi-line scan (a quoted `/api/v1/…` not directly inside an `api*` call) still
flags **28** places. Not all are bugs: some store the path in a variable that a
helper uses later (`import/page.tsx`, `VatCheckPanel.tsx` — spot-checked).
Six are `window.open` navigations — the four DATEV exports in
`reports/page.tsx` and two customer-portal PDFs (token in the URL, so those
can work). A navigation sends no `x-user-id`, and the DATEV export routes have
been `@Auth()` since long before Tier 375, so those four downloads cannot work
from the browser. The rest (cashbook export / Kassenabschluss PDF, attachment
files, SEPA XML, activity/webhook CSV, invoice PDF after create, …) each need a
look. Converting to `apiGetBlob` works per call; a session cookie (§9 item 10)
would make navigations authenticate — another reason to decide that first.

Specs: new `e2e/178-tier377-voucher-asset-bodies.sh` (44 assertions: caller
shapes still succeed incl. service messages; each measured bad body 400 with no
row written; B's account refused on create and correct). Verified: backend
**177 passed / 0 failed / 1 skipped** of 178 specs with **zero 500s** in the
captured backend log; related Playwright 41 + 33 passed.

### Cross-tenant record ids (Tier 378)

Tiers 375/376 bound the `companyId` a request names; the **record id** in the
path was still looked up by id alone in several services. Method: register a
fresh tenant B and call every route that takes a record id with company A's ids
(one per table, taken from the DB after a full suite run, plus fixtures for
tables that run leaves empty), B's own `companyId`, and look for 2xx with A's
data; then valid bodies for the routes whose first answer was a validation 400;
plus a static pass (id routes whose handler never passes a company). Measured:

| Route | Tenant B got |
|---|---|
| `GET /berater/notes/:id` | 200 — A's note incl. who acknowledged it |
| `GET /inventory/:productId` (+ `/history`) | 200 — A's product, stock, history |
| `PUT /inventory/:productId/adjust` | 200 — **A's stock set to 42** |
| `GET /payments/batches/:id` (+ `/xml`) | 200 — A's SEPA credit-transfer batch and pain.001 |
| `GET /payments/direct-debit/batches/:id` (+ `/xml`) | 200 — **debtors' IBANs**, pain.008 |
| `PUT /invoices/:id/status` | 200 — A's invoice changed; **the audit row was written under B's company** |
| `DELETE /reports/cost-center-budgets/:id` | 200 — A's budget deleted |
| `POST /system/errors/:id/resolve` \| `/mute` | 201 — A's error event changed |
| `POST /customers/:id/credit-adjust` | 201 — credit transaction on A's customer |

Everything else answered 403/404 or a not-found 400 (the services use
`findFirst({ id, companyId })`). Two tables stayed without a fixture — `Mahnung`,
`BankStatement`/`BankReconciliation` — and FinTS was not fired (bank calls);
their routes were covered only by the static pass, which found nothing there.

**Fix:** each lookup is scoped to the company — `getBatch(companyId, id)` in both
payment services, `InventoryService` methods take the company (history filters
`product.companyId`), `updateStatus` uses `findFirst({ id, companyId })`, budget
delete / error resolve+mute / berater note check ownership first,
`manualAdjustment` checks the customer. Routes whose callers send no
`?companyId=` (inventory page, batch detail) take the company from the
authenticated `x-company-id` header. The inventory body was an interface → new
`dto/adjust-stock.dto.ts`. A foreign id answers exactly like an unknown one.

**500 for a foreign/unknown id → 404:** voucher PDF, XRechnung ×2, ZUGFeRD
(the catch swallowed the NotFoundException, as the invoice PDF did before Tier
361), reminder email-data (plain `Error`), and Prisma **P2025** globally in
`GlobalExceptionFilter` (PATCH/DELETE `/webhooks/:id` of another tenant were 500
"Resource not found" and stored as ErrorEvents). P2002/P2003 stay 500 on purpose —
they also come from server races.

**Found here, fixed in Tier 379 — invoice status was free text.** `PUT /invoices/:id/status`
stores any string: company A's own `{"status":"lolwut"}` → 200, persisted
(measured, reverted). The status vocabulary is not one list in the code (specs
and code use draft/sent/paid/overdue/cancelled, and also `void`/`voided`), so an
allowlist needs the callers enumerated first.

**Platform-level routes** (backups, cron runs, notification config) are open to
any tenant admin — §9 item 11, a decision.

Specs: new `e2e/179-tier378-cross-tenant-ids.sh` — (1) generic sweep: every GET
route with a record id called by a fresh tenant with company A's ids must not
return A's data (50 fired in the full run, 12 skipped for lack of a fixture; it flagged 7 routes on the old code); (2) the
measured reads; (3) the measured writes, each asserting A's row is unchanged;
(4) the former 500s are 404; (5) company A still works on its own records.
Against the old code it failed 26 assertions. 158 turned a tolerated `note`
("fake product 500") into an assertion (404).

Verified on a fresh stack: full backend **178 passed / 0 failed / 1 skipped** of
179 specs, zero 500s in the captured backend log. Related Playwright (admin-ops,
berater, cost-center budgets, credit balance, direct-debit, payments, kontoauszug
e-mail, system-errors timeline, webhooks, XRechnung, aging credit) 68 passed; no
Playwright spec covers the inventory page, so its three request bodies were
replayed against the new DTO (200 each).

### Invoice status values (Tier 379)

`PUT /invoices/:id/status` stored any string (`"lolwut"` → 200, persisted;
`{}` → 200, no-op — measured). Before choosing an allowlist the vocabulary was
enumerated, not guessed:
- **The only UI caller** is the status dropdown on the invoice detail page:
  `draft`, `sent`, `paid`, `overdue`, `cancelled`. The first caller search
  missed it — the value is a variable (`{ status: newStatus }`) and the literal
  scan only found spec calls (137, 52, 179: `sent`, `paid`).
- **Backend writes:** `draft` (create), `sent` (credit note, payment removed),
  `paid` (payments, portal, customer portal, credit balance). `partial`,
  `voided` and `open` appear only in comparisons / filters (fints, installment
  plan, customer statement) — nothing writes them.
- `PUT /invoices/:id` cannot set a status (not in `UpdateInvoiceDto`).
- After a full suite run the database held only `draft`, `paid`, `sent`.

`UpdateInvoiceStatusDto` allows exactly the five dropdown values. Transitions
are **not** restricted (e.g. `paid` → `draft` is still allowed); whether a sent
or paid invoice may go back to draft is a GoBD/business question, not decided
here.

Spec `e2e/180-tier379-invoice-status-values.sh`: every dropdown value → 200 and
stored; unknown, missing, numeric, wrong-case and undeclared-field bodies → 400
with the status unchanged. Verified: full backend **179 passed / 0 failed /
1 skipped** of 180 specs, zero 500s; the dropdown was changed in a browser
(draft → sent: PUT 200, stored `sent`) — no Playwright spec covers it.

### SEPA mandate and batch bodies (Tier 380)

`POST /payments/mandates`, `/payments/direct-debit/batches` and
`/payments/batches` had inline body types; the services checked IBANs with
`/^[A-Z]{2}\d{2}/` and dates with a shape regex. Measured before the change:

| Route | Before |
|---|---|
| mandates | `dateOfSignature` "2026-02-30" → 201, **stored 2026-03-02**; IBAN "DE00", "DE12!!!@@@", wrong check digit → 201; `mandateReference` 80 chars (SEPA max 35), `debitorName` 300 (max 70), BIC "not a bic!!", undeclared field → 201 |
| mandates | the reverse: a valid IBAN typed lower case with spaces → **400** (prefix regex ran before normalising) |
| direct-debit batches | `collections` `["x"]` / numeric / null ids → 500; `executionDate` "2026-13-45" → 500; `creditorIban` "DE00" → 201 **and written into the pain.008 XML** |
| credit-transfer batches | `expenseIds` `[123]` / `[null]` → 500 |

The XML generators escape their values (checked), so this was bank-file
validity, not injection. A bank rejects a pain.001/pain.008 file with an invalid
IBAN, so `dto/sepa.dto.ts` checks the ISO 13616 check digits (`@IsIBAN`, which
also accepts spaces / lower case), `@IsBIC`, strict `YYYY-MM-DD` dates, SEPA
field lengths (MndtId / CI 35 with the SEPA character set, names 70, remittance
140) and typed id arrays. The services now upper-case IBANs before their own
check and before writing XML. Service checks stay (customer / invoices /
mandates of this company, active mandate, no CORE+B2B mix).

**Fixtures that were invalid:** e2e 137 derived four extra mandate IBANs from
`DE89370400440532013000` by changing the account number but keeping `89` — all
four failed mod-97; the Playwright direct-debit spec did the same with a
timestamp suffix (invalid for all but one value). Both now compute check digits
(137: precomputed `DE82…013999`, `DE72…013888`, `DE62…013777`, `DE52…013666`;
Playwright: a `germanIban()` helper).

Spec `e2e/181-tier380-sepa-bodies.sh`: caller shapes (137 full body, page body
without BIC, lower-case IBAN with spaces stored normalised, batch body) → 201;
each measured bad body → 400 with no mandate / batch stored. It failed 20
assertions against the old code.

Verified on a fresh stack: full backend **180 passed / 0 failed / 1 skipped** of
181 specs, zero 500s in the captured backend log; Playwright direct-debit +
payments 15 passed.

### Webhook replay test: a skip CI took, replaced by a wait (Tier 381)

Tier 380's CI run 34963691074 was green but reported **912 passed, 1 skipped**
where the previous run had 913 passed. The skipped test was
`webhooks.spec.ts › replay button in deliveries drawer`, one of Tier 369's kept
skips ("delivery row not visible within 30s — cron race"). That explanation does
not hold: delivery rows are inserted when the event is emitted (Tier 350), not
by a cron. Read in the code instead: `InvoiceService.create` does **not await**
`webhooks.emit()`, and the deliveries drawer loads its list **only when opened**
(no polling) — a drawer opened before the emit lands stays empty however long
the test waits. That is the likeliest cause; it did not reproduce locally
(3/3 passed). Also, the test's customer and invoice `fetch` calls never checked
their status, so a failed setup would have ended in the same skip.

Fix (test only): both setup calls must answer 201; the test polls
`GET /webhooks/:id/deliveries` until the delivery exists, then opens the drawer;
the skip is gone, so the next miss is a failure with a message. Verified:
`webhooks.spec.ts` with `--repeat-each=3` → 12 passed. **Lesson: compare the
test count, not only the pass/fail verdict — a green run with one test fewer
is a skip hiding.**

### Tax-form settings bodies (Tier 382)

The six `PUT /accounting/{anlage-n,anlage-r,anlage-kind,anlage-so,anlage-aus,gewst}/settings`
routes took inline types and "sanitised" by coercion (`Number(x) || 0`,
`Math.max(0, …)`, `.slice(0, 2)`). Measured before the change — every request
answered **200**:

| Form | Input | Stored |
|---|---|---|
| N | `lohnsteuer: "zehn"` | 0 |
| N | `lohnsteuer: -500` | -500 |
| N | `werbungskosten` with a string value, a nested object, an HTML key | verbatim |
| N | `werbungskosten` with 20000 keys | yes — `Company.settings` 298 KB |
| R | `drv: "zehn"`, `bav: -5` | 0, 0 |
| Kind | 5000-char name, `birthDate: "2026-02-30"` | both |
| SO | `acquisitionCost: "zehn"`, `salePrice: -100`, `saleDate: "2031-13-01"` | 0, -100, the date |
| AUS | `country: "XXXX"`, `incomeType: "bogus"`, `grossAmount: "abc"`, `foreignTaxPaid: -3` | "XX", "other", 0, -3 |
| GewSt | `q1: -100`, `q2: "zehn"` | 0, 0 |

These figures go onto Vordrucke; a typo becoming 0 (or a negative Lohnsteuer)
is worse than a 400. `dto/tax-settings.dto.ts`: amounts must be numbers
0…999,999,999.99 (`null` too is refused — the sections only produce it from
NaN); Kennziffer maps (`{"140": 1500}`) allow 1–4 digit keys, ≤ 30 entries,
amounts ≥ 0; dates are `""` (empty date input) or a real `YYYY-MM-DD`; country
`""` or two letters (e2e 136 uses "UK", so not an ISO list); income types from
the handler's own list; arrays capped (Kind 20, SO 500, AUS 200). One lenient
change: `year: "2031"` (a string) is now converted and accepted — it was 400.

Callers enumerated first: the six `*Section.tsx` components (number inputs,
`"" → 0` on the client, date inputs `""`, country upper-cased with
`maxLength={2}`) and e2e 127/129/130/132/135/136/138 — all passed unchanged.
The handlers' coercion is left in place; it can no longer change a value.

Spec `e2e/182-tier382-tax-settings-bodies.sh` (year 2033, removed afterwards):
section shapes incl. empty dates → 200; each measured bad value → 400 with the
stored year unchanged.

Verified on a fresh stack: full backend **181 passed / 0 failed / 1 skipped** of
182 specs, zero 500s in the captured log; Playwright anlage-n/r/kind/so/aus and
gewst 30 passed. CI run 34970262961 failed on its first attempt before any
test ran — "Start sidecar postgres" got `502 Bad Gateway` from Docker Hub while
pulling `postgres:16-alpine`; the re-run of that job passed (913/913).

### Credit / installment bodies, actor ids, multipart uploads (Tier 383)

**Bodies.** Customer credit and payment allocation and
`installment-plans/from-invoice` took inline types. Measured before the change:

| Route | Input | Result |
|---|---|---|
| `credit-adjust` | amount 1e12 | 500 |
| `credit-adjust` | 5000-char description, undeclared field | 201, stored |
| `credit-payout` | paymentDate `"abc"` / amount 1e12 | 500 / 500 |
| `credit-payout` | paymentDate `"2026-02-30"` | 201 |
| `apply-credit` | `invoiceId: 123` | 500 (now converted to `"123"` → 404) |
| `allocate-payment` | paymentDate `"2026-02-30"` | 201, Payment dated 2026-03-02 |
| `allocate-payment` | amount 1e12 | 201 |
| `from-invoice` | installmentCount 2.5 | 201: plan "2 Raten" with **3** rows of 476 € = 1428 € for a 1190 € invoice |
| `from-invoice` | installmentCount 5000 | 201, 5000 rows |
| `from-invoice` | intervalDays -30 / 0 | 201 |
| `from-invoice` | `"drei"`, firstDueDate `"abc"`, `"3"` (a string) | 500 |

`customer/dto/credit.dto.ts` and `CreateInstallmentPlanFromInvoiceDto`
(integer count 2…120, intervalDays 1…365, strict dates). Callers: customer
detail and credit pages, the invoice page's Ratenplan modal (sends
`Number(...)`), e2e 85/86/88/92/149/179, Playwright aging-credit,
customer-payment-allocation-tier146, ratensplan-suggestion, installment-plan.
String numbers from API clients are now converted (were 500).

**Actor ids.** Company A's `credit-adjust` with another tenant's user id as
`createdById` answered 201 and stored that user as the GoBD author.
`HeaderAuthGuard` now answers 403 when `createdById` / `closedById` /
`uploadedById` / `sentById` / `grantedById` in a body is not the caller (the UI
and the specs always send their own id). Shared helper:
`src/auth/caller-bound-upload.ts` `assertBodyBoundToCaller`.

**Multipart uploads bypassed the guard's body binding.** Guards run before
multer parses a multipart body, so the guard saw no `companyId` and every upload
handler trusted the form. Measured:

- `POST /attachments` as tenant B with the form field `companyId=<A>` and one
  of A's invoices → **201, file stored under company A** (the service's
  `entityId`-in-company check passed, because the company was A);
- company A's upload with `uploadedById=<B>` → 201, stored as the uploader;
- `POST /storage/upload` as tenant B with `companyId=<A>` → 201 into A's
  directory; without `companyId` → the shared `default` directory;
- `POST /storage/upload` with `type=../../../t383-escape` → **201, file written
  outside the storage root** (`saveFile` joined `type` into the path unchecked).

`upload-logo` was already refused (its own 400 re-check); berater notes by the
berater-role check. Fix: `@CallerBoundUpload(field, options)` =
`FileInterceptor` + `CallerBoundBodyInterceptor`, which runs after multer and
applies the same binding (plus `userId`, the bank-import form's importer). All
six upload routes use it (attachments, bank-statements import + preview,
company logo, storage, berater notes, OCR scan). `storage/upload` now stores
under the authenticated company; `UploadFileDto.type` is one of
`attachments | pdf | images`, and `saveFile` refuses any `type` / `companyId`
that is not `[A-Za-z0-9_-]{1,64}` (all callers).

Spec `e2e/183-tier383-credit-installments-actor.sh` (53 assertions): caller
shapes; bad bodies → 400 with no ledger / payment / plan rows; spoofed actor ids
→ 403; each multipart case above → 403 / 400 with no attachment or statement
stored; a static check that no controller uses `FileInterceptor` directly and
that every `@UploadedFile` controller uses `CallerBoundUpload`. e2e 86 compared
`grandNetTotal` with float equality (`28403.51` vs `28403.510000000002`) and
failed once other specs' credit balances were in the totals — now to the cent.

Verified on a fresh stack: full backend **182 passed / 0 failed / 1 skipped** of
183 specs, zero 500s in the captured backend log; Playwright aging-credit,
berater, customer-payment-allocation-tier146, installment-plan,
invoice-attachments-tier140, ocr-upload, ratensplan-suggestion, credit-balance,
skonto: 42 passed, none skipped.

**Found, not fixed (next tiers):**

- ~~**Audit context is a process global.**~~ Measured and fixed in Tier 384.
- ~~**Storage module**~~ (file routes unscoped, storage root settable) — measured
  and fixed in Tier 385.

### Audit rows written under another tenant (Tier 384)

The audit-log extension read who / which company / IP from
`globalThis.__deInvoiceRequestContext`, set by a `main.ts` middleware and
cleared on response `finish`. The Tier 13 comment reasoned that audit writes
run "in the same call stack as an HTTP request" — but Node serves requests
concurrently: every request arriving while another awaited the database
replaced the global, and every finished response cleared it for the rest.

Measured on a fresh stack, two new tenants each sending 40 concurrent
`PUT /customers/:id`:

| Company A's customer, 42 audit rows | |
|---|---|
| `companyId` = A | 15 |
| `companyId` = **B**, `userId` = B's user | 8 |
| `companyId` = null | 19 |

B's `GET /audit-logs` returned 18 rows, **8 of them A's customer** with A's
customer data in `newData`, attributed to B's user. The same applies to the
GoBD hash chain: the row joined the wrong company's chain (the chain lock key is
the context company). Of 10 attachment uploads interleaved with the other tenant's
updates, 2 audit rows did not name A and A's user.

Fix: `src/prisma/request-context.ts` — an `AsyncLocalStorage`; the middleware
runs the rest of the request inside `runWithRequestContext`, the extension reads
`getRequestContext()`. The global and `setRequestContext` /
`clearRequestContext` are gone. Cron jobs and scripts still have no context (no
user on their rows, as before).

**Existing data:** in any database that served concurrent requests before this
fix, audit rows may carry the wrong or no company / user. They are signed into hash chains, so they cannot be corrected
in place; nothing was changed. Whether and how to annotate them is a user
decision (§9).

Spec `e2e/184-tier384-audit-context-concurrency.sh`: 40 concurrent updates
per tenant → every audit row carries its own request's user and company, B's
audit log lists none of A's rows; 10 multipart uploads interleaved with the
other tenant's updates → 10 audit rows naming A and A's user. It failed 6
assertions against the old code.

Verified on a fresh stack: full backend **184 passed / 0 failed / 0 skipped** of
184 specs (16-dark-mode ran instead of skipping: the frontend was still up),
zero 500s in the captured log; Playwright audit-trail, audit-hash-chain-tier196,
audit-filter, audit-fulltext-search, audit-timeline, admin-activity-log / -csv,
invoice-attachments-tier140: 43 passed.

### Storage files readable across tenants, storage root settable (Tier 385)

Measured as a freshly registered tenant B, before the change:

| Request | Result |
|---|---|
| `GET /storage/files/<A's file>` | **200 with A's file** |
| `DELETE /storage/files/<A's file>` | **200, A's file deleted** |
| `GET /storage/files/..,<root>-sibling,x.txt` | 200 — `isPathSafe` was `normalize(p).startsWith(root)` |
| `POST /storage/config {"localPath":"/"}` | 201 — for every tenant (in-memory, until restart) |
| then `GET /storage/files/etc,hosts` | **200 with the server's `/etc/hosts`** |

Neither file route had `@Require` or a company check; any registered user
could read or delete any tenant's stored PDFs and, via the config route, read
any file the backend process can read. The probe read only its own files and
`/etc/hosts` and restored the root afterwards.

Fix:
- `StorageService.companyFilePath(path, companyId)`: a client path must be
  `{yyyy}/{mm}/{attachments|pdf|images|image}/{own companyId}/{file}` with a
  plain file name, else 404. `GET` needs `company.read` (and is
  `Cache-Control: private` instead of `public, max-age=31536000`), `DELETE`
  `company.update`.
- `isPathSafe` uses `path.relative` (used by the attachment service's own
  `getFile` / `deleteFile` on stored paths).
- `updateConfig` refuses a `localPath` different from the current one (403);
  the root is `STORAGE_PATH`. The settings form posts the whole form, so the
  unchanged value is accepted; the input is now `readOnly` (its comment already
  said "read-only — server config") and the hint names `STORAGE_PATH`. It never
  persisted anyway — the in-memory value was lost on restart, and existing
  files stayed in the old root. `cloudEnabled` / `cloudProvider` are still
  settable by any company admin and still process-wide; nothing reads them yet
  ("coming soon") — part of §9 item 11.

Still open: the settings page's file **Download** button is a plain navigation
to `${API_BASE}${f.url}` without auth headers — the same class as Tier 377's
"backend URLs not passed to an `api*` helper", though built from response data
so that scan does not count it. It answers 401, as before this change.

Spec `e2e/185-tier385-storage-files-scope.sh`: own upload / read / list url /
delete work; B's read and delete of A's file → 404 and the file survives;
`..,<sibling>` (commas, encoded slashes, via the own directory) → 404;
`localPath "/"` → 403, `etc,hosts` → 404, root unchanged; the settings form's
save → 201. It failed 10 assertions against the old code.

Verified on a fresh stack: full backend **185 passed / 0 failed / 0 skipped** of
185 specs, zero 500s in the captured log; Playwright settings-vat-mode-tier176,
invoice-attachments-tier140, berater-packager: 12 passed. No Playwright spec
covers the storage settings section.

CI, one run per tier, all six jobs green: Tier 383 run 34977321738 (backend
182/0/1, Playwright 913), Tier 384 run 34979145232 (183/0/1, 913), Tier 385 run
34981686035 (184/0/1, 913).

### Personal signing keys usable across tenants, private keys in responses (Tier 386)

Tier 246 added a per-user certificate (the Berater stamp, a second PDF
signature carrying the user's name). Its three routes took `userId` from the
client and checked nothing but `company.update` in the caller's own company.
Measured as a freshly registered tenant B against tenant A's user:

| Request | Result |
|---|---|
| `GET /signing/user-cert-info?userId=<A's user>` | 200, A's user's cert info |
| `POST /signing/user-sign {"userId":<A's user>, pdf}` | **201 — an arbitrary PDF signed with A's user's certificate** (same fingerprint) |
| `POST /signing/user-regenerate?userId=<A's user>` | **201 — A's user's key rotated, and the response contained the new `-----BEGIN RSA PRIVATE KEY-----`** |

`POST /signing/regenerate` also returned the **company** private key (own
company only) — its own doc comment lists `{ commonName, fingerprint,
validUntil, generatedAt }`; nothing in the frontend or the specs reads `key`.
Bodies: `pdf` not base64 → 500, `pdf: 123` → 500, undeclared fields → 201.

Fix (`signing.controller.ts`, `dto/signing.dto.ts`):
- both regenerate responses drop `key`;
- `user-sign` signs with the **caller's** certificate only — `userId` is still
  required (e2e 168) and must be the caller, else 403;
- `user-cert-info` / `user-regenerate` accept the caller or a member of the
  active company (`UserCompany`), else 404 — the Tier 246 comment says an admin
  may force a colleague's rotation;
- the `signing.user_regenerate` audit row takes the active company
  (`x-company-id`), not `User.companyId`;
- `SignPdfDto` / `VerifyPdfDto` / `UserSignPdfDto` (base64, ≤ 10 MB).

Callers: `PdfSignaturePanel.tsx` (sends its own `userId`, `{pdf}` to verify),
e2e 98 / 168, Playwright pdf-signing, pdf-signed-tier165,
pdf-berater-stamp-tier246.

**Not done:** keys rotated or obtained through these routes before the fix stay
as they are; a tenant whose user key may have been exposed can rotate it
(`user-regenerate`), which is now scoped. The self-signed certificates are not
QES anyway: they are self-signed (`generateSelfSignedCert`).

Spec `e2e/186-tier386-signing-keys-scope.sh`: own cert info / rotate / sign /
company rotate work and return no private key; B's cert-info and rotate of A's
user → 404 with A's fingerprint unchanged and no audit row; B's sign as A's
user → 403; the three bad bodies → 400. It failed 11 assertions against the
old code.

Verified on a fresh stack: full backend **186 passed / 0 failed / 0 skipped** of
186 specs, zero 500s in the captured log; Playwright pdf-signing,
pdf-signed-tier165, pdf-berater-stamp-tier246: 15 passed.

### Invited users locked out; role changes without effect (Tier 387)

Since Tier 66 `HeaderAuthGuard` grants access through `UserCompany` and takes
the role from `UserCompany.role`. Only registration (`auth.service.ts`) ever
created such a row. Measured on a fresh company:

- **Invitations:** `POST /users/invitations` → resend → `POST /invitations/accept`
  → 201, `/auth/login` → 200 — and then **every request 401 "Kein Zugriff auf
  diese Firma"**; the accepted user had no `UserCompany` row. e2e 152 checked the
  `User` row only and never made a request as the invited user. So no invited
  team member has ever been able to use the app.
- **Role changes:** `PATCH /users/:id/role` updated `User.role` only. With a
  membership row inserted by hand (role accountant), demoting to viewer answered
  200, the user list showed viewer — and **`POST /customers` as that user still
  answered 201**. An admin could not take rights away.

Fix (`users.service.ts`):
- `acceptInvitation` creates `User`, `UserCompany` (invited role) and marks the
  invitation accepted in one transaction;
- `changeRole` updates `UserCompany.role` (upsert) and `User.role` for the
  user's home company (what the list shows); the last-admin check counts active
  admin memberships. A user whose home company this is but who has no
  membership — every user invited before this fix, and e2e 161's SQL fixture —
  gets the row created when an admin sets their role: that is the repair path
  for existing installations. Another company's user → 404, no row.

Not changed: `setStatus` still looks the user up by `User.companyId` and sets
the global `User.status` (switching to membership lookup would let a Mandant's
admin deactivate a Berater for all their Mandanten); `listCompanyUsers` still
lists by `User.companyId`, so a Berater granted access to a company does not
appear in its user list; inviting an e-mail that already has an account is
refused ("Benutzer existiert bereits"), so an existing user cannot be added to a
second company through the UI.

Spec `e2e/187-tier387-invited-members-roles.sh`: invite → accept → login → the
member reads customers (was 401) and as viewer cannot create one; promote →
201, demote → 403 with the membership role and the list both viewer; the only
admin cannot demote themselves; a pre-fix member without membership gets access
once an admin sets the role; another company's user → 404. It failed 6
assertions against the old code (the demotion case only shows with a membership
row, so it was measured with the hand-inserted one).

Verified on a fresh stack: full backend **187 passed / 0 failed / 0 skipped** of
187 specs, zero 500s in the captured log; Playwright mandant-switcher,
readonly-mode, two-factor: 10 passed.

### Manual Mahnung never sent; paid and draft invoices dunned; reminder bodies (Tier 388)

**The invoice page's "Mahnung senden" sent nothing.** The modal ("Diese
Rechnung sofort per E-Mail mahnen", then "Mahnung wurde versendet") posts to
`POST /reminders/send`, which only wrote an `EmailSend` row with status `sent`
and a Mahnung with fees — measured: no mail attempt in the backend log (no
`[NO-SMTP]` / `Email sent` line), while the bulk send produced one per invoice
(the cron calls `mail.send` too — code, not measured). The Mahnhistorie therefore recorded letters, fees and Verzugszins that no
customer received. It now runs `BulkReminderService.sendSingle` — the
bulk / cron pipeline for one invoice: company template, Mahnung PDF, the
customer's stored address, one Mahnung per level per day (a second send → 409).
The modal's recipient / subject / body are accepted but not used (they are the
same preview).

**Paid and draft invoices were dunned.** The cron selects `status 'sent'`, type
INV; manual and bulk checked nothing. Measured: manual send on a paid and on a
draft invoice → Mahnung with fees; bulk send on both → "succeeded 2" and a mail
to the customer. `sendOne` now refuses anything but `sent` / `overdue` and credit
notes (bulk: `failed`, manual: 400).

**Bodies** (`dto/reminder.dto.ts`): measured before — level `"bogus"` → 201 and
a Mahnung with level "bogus"; missing invoiceId → 500; fees-config `null` /
`"abc"` / `-5` → stored 0, `5000` → 1000, `99` → 50, `"mahngebuehr":"x"` → 200;
templates stored a 5000-char subject and a 200 000-char body; cancel stored a
20 000-char reason; Mahnungspause `pausedUntil "abc"` → 500, `"2026-02-30"`
stored, `customerId: 123` → 500, PATCH `"abc"` → 500. Fee fields refuse `null`
(`@IsOptional` would skip it and the service turns null into 0); bulk refuses
more than 100 invoices instead of cutting the list.

**Specs that only passed because drafts could be dunned:** e2e 65 "flipped" its
invoice with `PATCH /invoices/:id {"status":"sent"}` into `/dev/null` — it never
changed the status; e2e 68 had no flip at all. Both now use
`PUT /invoices/:id/status`. **e2e 65's final cleanup deleted every Mahnung,
EmailSend, Invoice and Customer of the company** (`WHERE "companyId" = …` only)
— now scoped to its Tier37 customer like its setup block. Specs default
`PG_CONTAINER` to `de-invoice-postgres`, so run standalone that cleanup would
have hit the dev database.

**Not changed:**
- A Mahnungspause stops only the cron (Tier 64 use case 5); manual and bulk
  sends still go out for a paused customer / invoice, and ignore the Skonto
  window. Whether an explicit send may override a pause → §9 item 13.
- `dashboard/reminders/page.tsx` (older page) opens `mailto:` and then posts
  `/reminders/send` with a raw `fetch` without auth headers (401), and
  `dashboard/reminders/templates/page.tsx` calls `/reminders/templates` without
  `/api/v1`. The `mahnungen/*` pages replaced them; neither was changed.
- **`@IsString` does not refuse numbers or objects.** The global
  `ValidationPipe` has `enableImplicitConversion`, so class-transformer turns
  `123` into `"123"` and `{"a":1}` into `"[object Object]"` before validation —
  measured: template subject `{"a":1}` → 200, stored `[object Object]`. This
  applies to every DTO string field. Next tier.

Spec `e2e/188-tier388-reminder-send-bodies.sh`: manual send (page shape) → 201,
a mail to the customer's address in the backend log, the company's subject; a
second send → 409; paid / draft → 400 (manual) and `failed` (bulk) with no
Mahnung; each measured bad body → 400 with the fee config and the pauses
unchanged; the page shapes (fees, template, cancel, pause with `toISOString`,
PATCH `null`) succeed. It failed 30 assertions against the old code.

Verified on a fresh stack: full backend **188 passed / 0 failed / 0 skipped** of
188 specs, zero 500s in the captured log; Playwright bulk-mahnung-tier157,
manual-mahnung-send-tier152, mahnung-templates-tier151,
mahnung-fees-preview-tier164, mahnungspause, mahnung, mahnungen-page-tier232,
mahnung-cost-center, dunning-config-tier123: 52 passed.

### Download links answered 401 in the browser (Tier 389)

Tier 377 listed the frontend's backend URLs that are not passed to an `api*`
helper and deferred the navigation downloads to the session-cookie decision
(§9 item 10). Measured now, as the browser sends them (no auth headers) and
with the headers:

| Route | no headers | with headers |
|---|---|---|
| `accounting/anlage-n.pdf`, `euer.pdf`, `gobd-archive` | 401 | 200 |
| `reports/bwa.pdf`, `reports/datev-export` | 401 | 200 |
| `audit-logs/activity.csv`, `ustva/ustja.pdf` | 401 | 200 |

Those were measured; every other download built as a link or `window.open`
targets a route behind the same global guard (none is `@Public`), so the same
applies — code, not each one measured: the
Anlage N/R/S/V/G/KAP/Kind/SO/AUS, EÜR, GuV, Bilanz, GewSt, KSt1, Anhang,
E-Bilanz (XML + PDF) and UStJA (PDF, ELSTER XML) buttons, GoBD archive and
Berater-Packager ZIPs, BWA PDF, OSS CSV, the four DATEV exports, activity and
webhook-delivery CSVs, attachment view/download links (invoice, customer,
ReceiptsPanel, Berater notes), Kassenabschluss PDF, cashbook CSV export,
Mahnung PDF (whose URL even began with `undefined` without
`NEXT_PUBLIC_API_URL`), the storage-settings file download. Relative
`/api/v1/…` links (activity CSV) hit the Next server instead and got 404. The
Playwright tests only asserted the `href`; the DATEV month test asserted the
popup's URL.

Fix, independent of how auth is decided later:
- `downloadApiFile(path, { filename?, newTab? })` in `lib/api.ts`: `apiFetch`
  with the auth headers → blob → saved (`a.download`, file name from
  `Content-Disposition`) or, for PDFs/images with `newTab`, shown in a tab
  opened synchronously in the click (popup blockers).
- `AuthenticatedDownloads` (root layout): one document click listener takes over
  primary clicks on links whose `href` is a backend `/api/v1/…` URL
  (`API_BASE`-absolute or relative) and runs `downloadApiFile` — the ~30 link
  sites keep their markup, `href`, `target` and `download`. Customer-portal /
  pay routes (token in the URL) and `/portal` pages are left alone.
- The `window.open` buttons (four DATEV exports, cashbook CSV, Mahnung PDF) call
  `downloadApiFile` directly.
- Backend CORS `exposedHeaders: ['Content-Disposition']` so the cross-origin
  fetch can read the file name.

Spec `frontend/e2e/authenticated-downloads-tier389.spec.ts` clicks the Anlage N
PDF link, the GoBD ZIP link, the activity CSV link and the DATEV CSV button and
asserts the file request carried `x-user-id` and answered 200 (and a download
with the right extension). Against the old frontend all four failed (401, 401,
404, no download). `datev-month-button-tier185` test 3 now waits for the
download and the authenticated request instead of a popup URL.

**Steuerberater-Modus blocked every page request.** With the read-only toggle
on (Tier 71), `apiFetch` adds `x-readonly: 1`. The backend's CORS
`allowedHeaders` did not list it, so the browser's preflight (frontend :3100 →
API :3001) failed — measured in Chromium: `/dashboard/customers` → the customers
request `net::ERR_FAILED`, "blocked by CORS policy", no response. The existing
readonly Playwright tests only toggled the banner and called the backend
directly. `x-readonly` is now allowed; a new test in `readonly-mode.spec.ts`
loads the customers page with the mode on and asserts a 200 carrying
`x-readonly` and no blocked request — it failed against the old CORS config.
Same-origin deployments (frontend and API behind one host, no preflight) were
not affected; which one production uses depends on `NEXT_PUBLIC_API_URL` (§9).

Verified locally: full Playwright **917 passed** (913 + the 4 new download
tests; the readonly test was added after that run and passed with its spec),
none flaky or skipped; `authenticated-downloads-tier389` with
`--repeat-each=3` 12 passed; full backend **188 / 0 / 0**, zero 500s.

CI, all six jobs green: Tier 386 run 35007112386 (backend 185/0/1, Playwright
913), Tier 387 run 35009369478 (186/0/1, 913), Tier 388 run 35011694318
(187/0/1, 913; e2e 188's mail check ran against the CI backend log), Tier 389
run 35016230066 (187/0/1, 918).

### Pages still calling the API without auth; UStVA expense supplier (Tier 390)

After Tier 389 a rescan of `/api/v1/` URLs not passed to an `api*` helper
left raw `fetch` calls without headers on three dashboard pages (the remaining
raw fetches are the public login / register / reset / 2FA / invitation pages,
which need none). Measured in Chromium:

| Page | Request | Before |
|---|---|---|
| `/dashboard/reminders` (linked from the dashboard and the Mahnhistorie) "Erinnerung per E-Mail senden" | `email-data`, `POST /reminders/send`, refresh | 401 ×3; no Mahnung (the `mailto:` was built from the 401 body — code, not observed) |
| `/dashboard/reminders/templates` | `GET :3001/reminders/templates` (no `/api/v1`) | 404; no templates listed |
| `/dashboard/accounting/ustva` | `POST /ustva/expenses`, `DELETE /ustva/expenses/:id`, `POST /ustva/filings` | 401 (curl without headers) |
| `/dashboard/import` "Vorlage herunterladen" | relative `fetch('/api/v1/…/template.csv')` → Next server | 404 (API: 200) |

Fixes: the reminders page uses `apiGet` / `apiPost`; "senden" posts
`/reminders/send` (which since Tier 388 sends the letter itself) instead of
opening `mailto:` and recording — a `mailto:` on top would now double the mail;
success and the backend's message (e.g. 409 "bereits heute versendet") are
shown; the bulk loop counted every attempt as sent because the single send
swallowed its errors — it now counts failures. The templates page's four calls
get `/api/v1`. UStVA uses `apiPost` / `apiDelete` (the delete had no error
handling at all). Import uses `apiFetch`.

**Behind the 401: two backend bugs in `POST /ustva/expenses`.** The form's
empty supplier select sends `supplierId: ""` → foreign-key 500. And the
supplier was not checked against the company: company B's expense with company
A's `supplierId` → 201, with A's supplier record in the response (and in B's
expense list). `UstvaService.createExpense` now treats `""` as no supplier and
refuses a supplier of another company (400) — the check `ExpenseService.create`
already had; Tier 378's IDOR survey did not cover this path.

Specs: Playwright `pages-api-auth-tier390.spec.ts` (reminders send → 201 and a
Mahnung; templates → 200 from the API URL; UStVA expense save → 201; import
template → download from the API) — against the old frontend all four failed
(401, wrong URL, missing test ids — the UStVA 401 was measured with curl — and
the Next URL). Backend `e2e/189-tier390-foreign-ids.sh`: empty
supplier → 201 without supplier, own supplier linked, another company's → 400
with nothing stored; failed 6 assertions against the old code. The UStVA form
got `data-testid`s for the spec.

A heuristic scan for other service writes of a request-supplied foreign id
without a same-company lookup found `KassenbuchService.createEntry`
(`invoiceId` / `expenseId`, both foreign keys): measured, company B's cash book
entry with another company's invoiceId → 201. Nothing reads the reverse
relation, so no data leaked, but a GoBD cash record pointed into another
tenant. Both ids are now looked up in the company (400 otherwise); no page
sends them. (FinTS `mandateId` is the mandate reference string for the XML.)
Spec 189 is `e2e/189-tier390-foreign-ids.sh` and covers both.

Verified locally: full backend **188 passed / 0 failed / 1 skipped** of 189
specs, zero 500s (a first run had two failures caused by this session — spec 189
renamed mid-run, and a probe run in parallel while e2e 64 hit "Can't reach
database server"; rerun clean); full Playwright **922 passed** (918 + the 4 new
tests), none flaky or skipped. **Lesson: never probe the throwaway stack while
a suite runs on it.**

CI run 35025847641, all six jobs green: backend 188/0/1, Playwright 922.
Tier 391 run 35032619006, all six jobs green: backend 188/0/1, Playwright 922.
Tier 392 run 35065207044, all six jobs green: backend 188/0/1, Playwright 922.
Tier 393 run 35071721340, all six jobs green: backend 188/0/1, Playwright 922.
Tier 394 run 35075859822, all six jobs green: backend 188/0/1, Playwright 922.
Tier 395 run 35079629677: green but **187/0/2** — the hidden skip Tier 396 fixed.
Tier 396 run 35082666894, all six jobs green: backend 188/0/1 (only
16-dark-mode), Playwright 922.
Tier 397 run 35090119146, all six jobs green: backend 188/0/1, Playwright 922.
Tier 398 run 35094143231 **failed** (Playwright 921 — portal-profile-tier155,
see below); Tier 398a run 35099184553 green: backend 188/0/1, Playwright 922.
Tier 400 run 35112477951, all six jobs green: backend 189/0/1 (the new spec
is the +1; the skip is still 16-dark-mode), Playwright 922.
Tier 402 run 35140985920, all six jobs green: backend 190/0/1, Playwright 926.
Tier 421 run 35658942460, all six jobs green: backend 209/0/1, Playwright 930 passed, 0 flaky.
Tier 420 run 35655102546, all six jobs green: backend 208/0/1, Playwright 930 passed, 0 flaky.
Tier 419 run 35651151007, all six jobs green: backend 207/0/1, Playwright 930 passed, 0 flaky.
Tier 418 run 35647495312, all six jobs green: backend 206/0/1, Playwright 930 passed, 0 flaky.
Tier 417 run 35634107905, all six jobs green: backend 205/0/1, Playwright 930 passed, 0 flaky.
Tier 416 run 35628280500, all six jobs green: backend 204/0/1, Playwright 930 passed, 0 flaky.
Tier 415 run 35621206517, all six jobs green: backend 203/0/1, Playwright 930 passed (+2), 0 flaky.
Tier 414 run 35613762360, all six jobs green: backend 202/0/1, Playwright 928 passed, 0 flaky.
Tier 413 run 35263817448, all six jobs green: backend 201/0/1, Playwright 928 passed (+2 from invoice-discount-row-tier413), 0 flaky.
Tier 412 run 35256287464, all six jobs green: backend 200/0/1, Playwright 926 passed, 0 flaky.
Tier 411 run 35250944012, all six jobs green: backend 199/0/1, Playwright 926 passed, 0 flaky.
Tier 410 run 35234704698, all six jobs green: backend 198/0/1, Playwright 926 passed, 0 flaky.
Tier 409 run 35227068422, all six jobs green: backend 197/0/1, Playwright 926 passed, 0 flaky.
Tier 408 run 35220078060, all six jobs green: backend 196/0/1, Playwright 926 passed, 0 flaky.
Tier 407 run 35208090438, all six jobs green: backend 195/0/1, Playwright 926 passed, 0 flaky.
Tier 406 run 35199915513, all six jobs green: backend 194/0/1, Playwright 926 passed, 0 flaky.
Tier 405 run 35193118556, all six jobs green: backend 193/0/1, Playwright 926 passed, 0 flaky — the keep-alive fix held.
Tier 404 run 35157628517, all six jobs green: backend 192/0/1, but Playwright
**925 passed + 1 flaky** — `gobd-month-button-tier183` #4 failed once with
`read ECONNRESET` and passed on retry. The job verdict hid it; the count did
not. Root cause and fix: Tier 405 (keep-alive race).
Tier 403 run 35147946203 **failed** on Playwright (925 — the third hard-coded
cron count, see below); Tier 403a run 35151805726 green: backend 191/0/1,
Playwright 926.
Tier 401 run 35123354210 **failed** on backend lint — a warning
(`SESSION_TTL_DAYS` unused after the cookie code moved into `issue()`), and CI
runs lint with zero tolerance. I had run lint *before* that move and only `tsc`
after. Tier 401a run 35123583394 green: backend 189/0/1, Playwright **926**
(+4 from session-cookie-tier401).

### A SEPA batch the bank did not execute can be cancelled (Tier 433)

Measured before: there was no way to. Once generated, a batch's expenses
stayed "paid" (`paidAt`, `paidBySepaBatchId`) — in the balance sheet (4000 at
0), on the payments page (gone from the unpaid list) and, since Tier 432, in
DATEV — whatever the bank did with the file.

`POST /payments/batches/:id/cancel` (optional `reason`, permission
`expense.write`): the batch becomes `cancelled`, its expenses unpaid again
(back in the unpaid list, owed in 4000, no payment in DATEV). Refused (400)
when the bank import has already matched one of its expenses to a debit —
then that payment did happen — and for a batch already cancelled. The
payments page has a "Stornieren" button per batch (de/en/zh).

Spec `e2e/222-tier433-sepa-storno.sh` (9 assertions, 7 failing against the
previous code). No existing spec needed a change. Local runs: backend
**221 / 0 / 1**, 0 × 500; Playwright **930**, no flaky.

**The flaky cookie-banner test** (`legal-pages-tier170`, test 4; Tier 423 and
432 runs) had a bug of its own: its `addInitScript` wiped the stored consent
on every navigation — the `page.reload()` included — so the "banner must not
reappear" check passed only when it ran before the banner's mount effect. It
now clears the consent on the tab's first load only (a sessionStorage flag),
waits for the reloaded page to settle and checks the consent is still stored.
Repeated 15 times without retries: the old version failed 2, the new one 0.

### A SEPA-paid expense stayed owed in DATEV (Tier 432)

Measured: an expense of 119 € paid through the SEPA credit-transfer run
(`paidAt` set; the app's balance sheet had 4000 at 0) exported to DATEV as
"Kreditor 70001 an 4900 119,00 H" and nothing else. The export booked an
expense's payment only from a bank-import voucher (Tier 423) or a cash-book
entry (Tier 425), so the supplier stayed owed 119 € in the Berater's books.

`buildBuchungenFromDb` now books "Bank an Kreditor" from `paidAt` for every
expense paid in the period that has neither a cash-book entry nor a
bank-import voucher (those book the payment already — no second row).
Buchungstext "Zahlung SEPA …" when the SEPA run paid it.

Spec `e2e/221-tier432-sepa-datev.sh` (5 assertions, 2 failing against the
previous code). No existing spec needed a change. Local runs: backend
**220 / 0 / 1**, 0 × 500; Playwright **929 + 1 flaky** — the cookie-banner
test of `legal-pages-tier170` again (as in Tier 423), passing on the third
attempt; nothing here touches it.

Found on the way, not changed: a SEPA batch cannot be cancelled. If the bank
rejects the file, its expenses stay "paid" (`paidAt`, `paidBySepaBatchId`) —
in the balance sheet, the payments page and now DATEV — until someone clears
them in the database.

### Money that went missing between the payment paths (Tier 431)

Tier 430 found two ways of writing payments that bypassed PaymentService.
Measured:

| | Before | Now |
|---|---|---|
| Sammelzahlung 2 000 € over two open invoices (1 190 + 595) | 1 785 € applied, **215 € on no account** — the customer's credit stayed 0, the payments summed to 1 785 | every share through PaymentService (status, Skonto, Ratenplan, webhook); the remainder rides on the last share and becomes the customer's credit — payments sum to the 2 000 received |
| customer credit of 110 € applied to an invoice | written directly; the customer statement deducted it twice: closing balance 279,80 instead of 389,80, printed as `279.79999999999995` | through PaymentService; the statement counts it once, to the cent |
| that credit in DATEV | a bank receipt of its own whenever it fell inside the period — the money came in once, as the overpayment | not a receipt |
| a payment recorded at 14:30 on the last day of a DATEV period (`endDate=2026-09-30` → 00:00) | in **no** export: cut off by that one, before the start of the next | the end date covers the whole day |

- `NON_CASH_PAYMENT_METHODS` (`document-scope.ts`): 'Gutschrift' (the
  synthetic payment a credit note books) and 'Guthaben' (a credit applied)
  reduce what is open but are no receipt of money. DATEV and the customer
  statement use it.
- `CustomerService.allocatePayment` and `CreditBalanceService.applyToInvoice`
  get PaymentService through `ModuleRef` (InvoiceModule imports
  CustomerModule, so it cannot be injected). A failure takes back what was
  booked: the earlier shares, or the credit usage.
- `buildBuchungenFromDb` treats a date-only end date as the whole day.

Spec `e2e/220-tier431-zahlungen-ohne-umweg.sh` (8 assertions, 4 failing
against the previous code — the others pin the parts that were right). No
existing spec needed a change. Local runs: backend **219 / 0 / 1**, 0 × 500;
Playwright **930**, no flaky.

### A customer could mark their own invoice paid — for 1 € (Tier 430)

Measured on a sent 1 190 € invoice:

| | Before | Now |
|---|---|---|
| customer portal "als bezahlt markieren" with amount 1 | a 1,00 € Payment, invoice **paid** — dunning stopped; UStVA, DATEV, balance sheet counted money that never arrived | a **payment report** (`PaymentNotice`, open); the invoice stays open, nothing booked |
| payment link "bezahlt" on a part-paid invoice (190 € paid) | a second Payment of the full 1 190 on top, invoice paid | a report of the open 1 000 |
| a report above the open amount | booked | 400 |
| a second click | — | returns the open report (`alreadyReported` on the link) |
| the company | never asked | sees the report on the invoice ("Zahlungsmeldung des Kunden — erst buchen, wenn das Geld eingegangen ist") and books it (a real payment through PaymentService: status, Skonto, Raten, overpayment credit) or dismisses it |

A customer's click is a Zahlungsavis, not a receipt of money.
`src/modules/invoice/payment-notice.ts` records it (amount defaults to the
open balance, may not exceed it, one open report per invoice);
`GET /invoices/:id/payment-notices`, `POST …/:noticeId/book` (optional
amount, paymentDate, paymentMethod) and `POST …/:noticeId/dismiss`. The
model is new (migration `20260923000001_payment_notices`) and audited. The
portal list shows "Zahlung gemeldet", its button and the payment-link page
say "Zahlung melden".

Spec `e2e/219-tier430-zahlungsmeldung.sh` (14 assertions, 12 failing against
the previous code). `e2e/63` asserted a booked `portal-mock` payment; it now
asserts no payment, one open report, and `alreadyReported` on the second
click. Local runs: backend **218 / 0 / 1**, 0 × 500; Playwright **930**, no
flaky.

Not changed, found on the way: the customer detail's "Sammelzahlung" (one
amount over several invoices, `customer.service`) and the credit-balance
"Guthaben verrechnen" write payments directly instead of through
PaymentService, so they skip the Skonto check, the Ratenplan sync and the
payment webhook.

### A Ratenplan was paid past its invoice (Tier 429)

Measured on a 1 190 € invoice with 190 € already paid:

| | Before | Now |
|---|---|---|
| the plan | split over the full 1 190 (2 × 595) — the paid 190 asked for again | the open 1 000 (2 × 500); a plan above the open amount is refused |
| paying both Raten | the plan "completed", the invoice stayed **sent** with only the 190 on it — the money paid through the plan reached no payment, so UStVA, DATEV, balance sheet, ageing and dunning never saw it | each Rate is a payment of the invoice (PaymentService: status, Skonto, overpayment credit); plan completed, invoice paid |
| a payment booked on the invoice (bank import, manual) | the Raten stayed open, then overdue | settles the Raten in order |
| removing a payment | — | reopens the Rate; the plan goes back to active |
| a Rate paid above its amount | cut off silently at the Rate | covers the next Rate |
| the plan's dunning pause | on the whole customer, open-ended until someone deleted it | on this invoice only; ends when the plan completes or is cancelled |
| an overdue invoice | refused ("Status overdue, nicht sent") — the usual case for a plan | eligible |

The invoice's payments are the truth and the Raten a view of them:
`installment-plan/installment-sync.ts` spreads every payment recorded since
the plan was created over the Raten (paid / partial / overdue / open) and
completes or reactivates the plan; `PaymentService.create` and `.delete` call
it, and "Rate bezahlt" records a payment (optional `paymentMethod`, default
bank transfer) instead of writing the Rate.

Spec `e2e/218-tier429-ratenplan.sh` (13 assertions, 10 failing against the
previous code). Updated: `e2e/78` seeded a 1 190 € invoice and put a
1 200 € plan on it — 10 € more than was owed, now refused; its invoice is
1 200 €. `e2e/92` expected the pause on the customer and open-ended; it now
expects it on the invoice while the plan runs.

Local runs: backend **217 / 0 / 1**, 0 × 500 (second run); Playwright
**930**, no flaky. The first backend run had one 500 in
`64-tier36-dashboard.sh` (`GET /reports/dashboard-v2`) — it did not recur
in the second full run nor when replaying specs 01–64 in order on a fresh
stack, and its stack trace was gone: `run-playwright` had restarted the stack
and truncated `/tmp/backend.log`. `local-ci-stack.sh run` now copies the
log to `/tmp/backend-e2e-run.log` at the end, so the next one can be traced.
Nothing in this tier touches the dashboard; watch for it.

### The Zahlungsziel decided nothing, and a monthly contract skipped February (Tier 428)

Measured with a company default of 30 days:

| | Before | Now |
|---|---|---|
| invoice for a customer on 14 days, issued 01.09. | due 01.10. — the company default | 15.09. |
| customer on 0 days ("sofort fällig") | 01.10. | 01.09. |
| the invoice form's own "Zahlungsziel" select | changed nothing: the DTO accepted `paymentTerms`, the service dropped it (there is no such column), and the form never touched the due-date field either | the invoice's own term wins, and the form recomputes the due date when the term, the issue date or the customer changes |
| recurring invoice | due = issue + 30, hard-coded | the customer's term, else the company default (preview included) |
| monthly template from 31.01., billed on the 31st | first run **28.03.**: `setMonth(+1)` on 31 January is 3 March, so February was skipped, and the day was then clamped to 28 forever (the cap was 28, not the month's length) | 28.02., 31.03., 30.04., 31.05. |
| the stored run date | the server's local midnight — in Berlin the date in the database was the day before the one the user picked, and it moved with the server's time zone | UTC dates |

`src/modules/invoice/due-date.ts` resolves the term once (invoice → customer
→ company; 0 is a term, not a missing value, and with nothing set an invoice
still gets no due date). `InvoiceService.create`, the recurring run and its
preview use it. The recurring date arithmetic adds whole months in UTC and
clamps to the target month's last day.

`Customer.paymentTerms` is nullable now (migration
`20260922000003_customer_payment_terms_nullable`): it was NOT NULL with a
default of 30, so every customer silently overrode the company's setting and
a company default of 21 days could never apply. Rows still carrying the old
default of 30 were set to NULL — nothing could tell them apart from a
deliberate 30, and they land on the company default anyway.

A new customer's Zahlungsziel starts at the company's default payment days
instead of 0 — with the term driving the due date, 0 would mean every invoice
of theirs is due on the day it is issued and dunned the day after.

Spec `e2e/217-tier428-zahlungsziel.sh` (9 assertions, 7 failing against the
previous code). `ci-seed.sh` gives its BWA customer no own term, so
`company-defaults-tier176` keeps testing the company default.

Local runs: backend **215 / 1 / 1**, 0 × 500 (`50-webhooks.sh` again, whose
SSRF check needs to resolve nip.io — this machine's DNS cannot); Playwright
**930**, no flaky.

### AfA was counted by day of the month, in two implementations (Tier 427)

§ 7 Abs. 1 EStG: AfA runs pro rata temporis by month — the month of
acquisition counts in full, and so does the month of a disposal. The day of
the month does not matter. The month count did: "the months between the two
dates, plus one if the later date's day-of-month is at least the earlier
one's". Measured, with two assets of 100 €/month:

| | Before | Now |
|---|---|---|
| A: 6 000 € / 60 months, bought 10.01.2025, sold 05.06.2026 — book value at the sale | 4 300 € (17 months of AfA) | 4 200 € (18: Jan 2025 – Jun 2026) |
| B: 3 600 € / 36 months, bought 31.03.2026 — AfA 2029 | 300 €, although only January and February were left of its life | 200 € |
| B in Anlage V's own copy of the calculation | 200 € — the two implementations disagreed on the same asset | 200 €, from the same code |
| the year's Anlagenverzeichnis (Berater package) | an asset sold during the year vanished from it: no Abgang, no book value, no AfA | listed, with its book value at the sale |

`src/modules/assets/afa.ts` holds the calculation now (`afaMonths`,
`computeAfaSummary`); `AssetsService.computeAfA` and Anlage V's
`computeAfaForYear` both call it. Everything that depends on it follows: the
Bilanz book values, GuV 7a, BWA 3100, EÜR / Anlage S 4600 via the booked AfA
rows, the e-Bilanz and the Berater package.

Spec `e2e/216-tier427-afa-monate.sh` (13 assertions, 3 failing against the
previous code — the others pin the cases that were already right). No
existing spec needed a change. Local runs: backend **214 / 1 / 1**, 0 × 500
(the one failure is `50-webhooks.sh`, whose SSRF check needs to resolve
nip.io — this machine's DNS still cannot; CI passes it); Playwright **930**,
no flaky.

Not changed: a disposal books nothing (no Anlagenabgang: proceeds against
book value, gain or loss to 4855 / 2315); GWG (§ 6 Abs. 2 EStG, ≤ 800 € net)
is a label on the asset, not a rule — the user sets a one-month useful life
by hand; degressive AfA does not exist.

### The balance sheet ignored payments, and no customer could have a credit limit (Tier 426)

Measured on a 1 190 € invoice with 500 € paid, a second invoice paid only
*after* the snapshot, one paid and one unpaid 119 € expense, a 200 € cash
receipt, an imported statement with a 1 700 € closing balance and a customer
credit of 150 € that had been used up:

| | Before | Now |
|---|---|---|
| 1500 Forderungen | 1 190 — the totals of the invoices that are "sent" *today*: the part payment ignored, the invoice paid later missing | 809 = (1 190 − 500) + 119 |
| liquide Mittel | one line "Kassenbestand, Guthaben bei Kreditinstituten" = 200, the cash book alone — a bank balance never appeared in it | 1600 Kassenbestand 200 and 1700 Guthaben bei Kreditinstituten: the last imported statement's closing balance per account, "nicht ausgewiesen" when none was imported |
| 4000 Verbindlichkeiten | 238 — every booked expense, paid or not | 119 |
| 4500 Kundenguthaben | 150 — only the positive ledger rows were summed, so a credit that had been used stayed forever | 0 (the ledger's balance per customer up to the snapshot) |
| dashboard "offene Forderungen" | 1 190 | 690 |
| credit utilisation | 1 190 of a 1 000 limit → 119 %, "over" | 690 → 69 %, "ok" |

The balance sheet is taken *at* a snapshot now: invoices issued up to it that
are not drafts or cancelled, less the payments received up to it (an
overpayment is a liability on 4500, not a negative receivable); expenses
booked up to it whose `paidAt` is empty or later.

**No customer could have a credit limit.** `Customer.creditLimit` feeds the
credit-utilisation report (Tier 159) and the customer detail card, but
neither `POST` nor `PUT /customers` accepted it — the whitelist answered
`400 "property creditLimit should not exist"` — and the form had no field.
Both DTOs take it now and the customer form has "Kreditlimit (€)"
(`data-testid="customer-credit-limit"`, labelled in de/en/zh).

Spec `e2e/215-tier426-bilanz-open-amounts.sh` (11 assertions, 10 failing
against the previous code). `e2e/107` asserted the old line ("1600+1700")
and marked its "paid" expense with a status `paid` that the Expense model
does not have — it only fell outside the old filter by accident; it now sets
`paidAt`.

An invoice whose status was flipped to "paid" by hand, without a payment ever
being recorded, counts as settled (spec 107 has such rows): there is no date
to place it at, and the alternative is a receivable that never goes away.

Local runs: backend **213 / 1 / 1**, 0 × 500; Playwright **930**, no flaky.
The one failure is `50-webhooks.sh`: its SSRF check registers
`http://127.0.0.1.nip.io/`, and this machine's DNS could not resolve nip.io
at the time (it passed in the Tier 425 run a few hours earlier). Nothing in
this tier touches webhooks; CI resolved it: `50-webhooks: all assertions passed`.

### The Kassenbuch never reached the books; uncategorised expenses were dropped (Tier 425)

Measured in one month with a 119 € cash sale at 19 %, a 59,50 € cash
purchase at 19 %, a 50 € Privateinlage (no VAT rate), an invoice of 119 €
paid in cash at the counter (entered in the Kassenbuch, invoice linked) and
a 119 € expense without a category, paid in cash (linked):

| | Before | Now |
|---|---|---|
| invoice paid at the counter | still "sent", no payment — dunned | paid, a `cash` payment; a Storno of the entry takes it back |
| expense paid in cash | no payment date | `paidAt` = the entry's date |
| UStVA 19 % | 100 / 19 (cash sale's 19 € undeclared) | 200 / 38 |
| Vorsteuer 19 % | 19 (9,50 € not claimed) | 28,50 |
| EÜR Einnahmen / Ausgaben | 100 / **0** | 200 / 150 |
| GuV, BWA revenue / sonstige Aufwendungen | 100 / **0** | 200 / 150 |
| P&L revenue / other expenses | 100 / 100 | 200 / 150 |
| Anlage S 4100 | 100 | 200 |
| DATEV | nothing from the Kassenbuch; every payment on Bank | Kasse 1000: an 8400 119,00 S key 3; an 4900 59,50 H key 9; the invoice's payment Kasse an Debitor; the expense's Kasse an Kreditor |

- **Kassenbuch rule** (`src/modules/cashbook/cash-bookings.ts`): an entry
  linked to an invoice records a Payment (method `cash`,
  `CashBookEntry.paymentId`, migration `20260922000002_cashbook_payment`);
  linked to an expense it sets the expense's `paidAt` (the field existed for
  SEPA payments; a bank-import match to an expense now sets it too); an unlinked einnahme / ausgabe **with a VAT rate** (0
  included) is a cash sale / purchase and counts in UStVA, EÜR, Anlage S,
  GuV, BWA, P&L and DATEV; one **without** a rate is money moving without
  being income (Privateinlage / -entnahme, Geldtransit) and counts nowhere.
  A Storno copies the links, deletes the payment / clears `paidAt`; deleting
  an entry on an open day does the same; the amount of a linked receipt can
  no longer be edited. Only an einnahme can be linked to an invoice, only an
  ausgabe to an expense (400).
- **NULL categories** (found writing the spec): EÜR, GuV, BWA, Anlage S and
  V filtered expenses with `category: { not: 'AfA' }`, which is
  `category <> 'AfA'` in SQL — false for NULL — so **every expense without
  a category was missing** from those five reports. Now
  `OR: [{ category: null }, { category: { not: 'AfA' } }]`.
- The **EÜR and Anlage S** took expenses net also for a Kleinunternehmer
  (Tier 419 fixed GuV / BWA only); now `expenseCost` (gross for them).
- The **P&L** summed `eurSubtotal ?? subtotal` — before the invoice discount
  (Tier 411 fixed the other reports); now `invoiceNetRevenue`.
- DATEV: new account `cash` (SKR03 1000), labelled in the settings.

Spec `e2e/214-tier425-kassenbuch.sh` (18 assertions, 14 failing against the
previous code). No existing spec needed a change. Local runs: backend
**213 / 0 / 1**, 0 × 500; Playwright **930**, no flaky; the bank-import
change (paidAt on a match) came after the full run and was re-checked with
08, 32, 36, 79, 212, 214.

Not done (§ 9): the EÜR still counts invoices and expenses at their
document date, not when paid (§ 11 EStG); the payment dates are now there
for invoices (Payment), cash and SEPA-paid expenses, but not for expenses
paid by plain bank transfer without a bank-import match. Kassenbuch
`umbuchung` (Bank ↔ Kasse) is not exported to DATEV.

### Proformas counted as revenue, Quittungen did not reach the UStVA (Tier 424)

The invoice table holds four document types — INV Rechnung, RCV Quittung (a
sale with its own lines and VAT), CN Gutschrift, PI Proforma-Rechnung (a
request for advance payment; no invoice under § 14 UStG: no revenue, no tax,
nothing owed) — and each report picked its own subset. Measured on one sent
PI (1 000 net, 19 %), one sent RCV (100 net, 7 %), one sent INV (500 net,
19 %) and one draft:

| | Before | Now |
|---|---|---|
| UStVA | 19 %: 1 500 / 285 (the PI declared), 7 %: nothing (the RCV missed) | 19 %: 500 / 95, 7 %: 100 / 7 |
| GuV, BWA, Anlage S | revenue 1 600 | 600 |
| P&L (`/reports/pnl`) | 1 900 — the draft as well | 600 |
| ageing | 1 785 open (the PI, not the RCV) | 702 |
| dashboard, this month | gross 2 249, VAT 359.08403361344534 (drafts, cancelled, PI; VAT = total × 19/119) | 702 / 102 (the documents' VAT), 2 documents |
| DATEV | the RCV missing | Debitor an 8300 107,00 key 2 |
| customer statement, 1 190 € invoice + 190 € credit note | **810** owed — the credit note counted twice (its own line and the synthetic "Gutschrift" payment it books on the invoice) | 1 000 |

`src/modules/invoice/document-scope.ts` defines it once: `ISSUED_STATUSES`
(sent, paid, overdue), `SALES_TYPES` (INV, RCV, CN — revenue and VAT, a
credit note negatively), `CLAIM_TYPES` (INV, RCV — what a customer can owe).
Applied to UStVA, OSS, DATEV, GuV, BWA, EÜR, Anlage S / G / V, P&L, the
sales / VAT reports (`reports.service`), the GoBD archive totals, ageing,
cash-flow forecast, Bilanz receivables, customer open balances (the list's
open sum also counted drafts), the customer statement, the dashboard and the
cost-centre reports (which counted drafts and cancelled documents and left
credit notes out). The GoBD archive still archives every issued document,
Proformas included — they are business letters.

Spec `e2e/213-tier424-document-scope.sh` (12 assertions, 10 failing against
the previous code). `e2e/72` computed its baseline with the old query (any
status, no credit notes) and now uses the new scope. Local runs: backend
**212 / 0 / 1**, 0 × 500; Playwright **930**, no flaky.

On Tier 423's `203` mystery: this run had no leftover frontend on :3100
(`16-dark-mode.sh` skipped) and 203 passed, as in CI — both failing runs had
one. Likely load (a Next dev server compiling next to KoSIT's JVM), not a
product fault; the spec's new diagnostics will say if it recurs.

Open (§ 9): whether a Quittung may also be issued for the payment of an
existing invoice — then it would be counted twice; the app has no link from
an RCV to an invoice, and this tier treats it as a sale of its own.

### The DATEV export could not be imported, and booked the wrong things (Tier 423)

User decisions for this tier: **Soll-Versteuerung** (invoices booked at their
issue date) and **one Personenkonto per customer / supplier**.

Measured on one month with an unpaid 19 % + 7 % invoice, an igL invoice, a
part payment, a credit note, two expenses and a manual voucher:

| | Before | Now |
|---|---|---|
| header | 25 fields of its own design, `"EXTF";"Buchungsstapel";"15";…` | DATEV-Format: `"EXTF";700;21;"Buchungsstapel";13;…`, 31 fields, Berater / Mandant / WJ-Beginn / Sachkontenlänge / period in their places |
| column headings | none | DATEV's 125 headings on line 2 |
| data rows | began with `EXTF`, amount in column 9, decimal point | amount in column 1 with a decimal comma, S/H, Konto, Gegenkonto, BU-Schlüssel, Belegdatum TTMM, … — DATEV reads by position |
| encoding | Buffer `latin1` (the controller) or UTF-8 (Buchungsliste, GoBD archive) | Windows-1252 everywhere (`encodeDatevCsv`; "–" of the headings and "€" are in 0x80–0x9F) |
| unpaid invoice | not exported (only status `paid`) | Debitor 10000 an 8400 1 190,00 S key 3, an 8300 107,00 S key 2 |
| paid invoice | on the payment date, 1406 an 8400 net + a second row for the tax, + a row for the payment of the *invoice total* | at the issue date; each payment on its own date and amount, Bank an Debitor |
| igL | 8125 key "0" | 8125 without key, customer's VAT id in "EU-Land u. USt-IdNr." (ZM) |
| credit note | missing | Debitor an 8400 / 8300, H, split over the rates |
| expense | "Bank an Aufwand" at the invoice date (paid or not) + a Vorsteuer row, key "1" | Kreditor 70001 an Aufwand, gross, key 9; § 13b net key 94, igE key 19 |
| manual voucher 4900 + VSt 1576 an Bank | 3 rows (every line against the first opposite line) | 1 row: Bank an 4900 119,00 H key 9 |

The tax keys were invented (19 % USt "1" — DATEV's key 1 is *steuerfrei mit
Vorsteuerabzug*; Vorsteuer "20"/"21"; igE "14"/"15"; § 13b "12"/"13", which
are intra-EU supplies to buyers *without* a VAT id). Now DATEV's: 2/3 USt,
8/9 Vorsteuer, 5/7 the 16 % of 2020, 18/19 igE, 91/94 § 13b; tax-free
bookings carry no key (the account says what they are). Rows carry the gross
amount; 8400/8300 are Automatikkonten and DATEV splits the tax itself.

- **Personenkonten** (`datev-personenkonten.ts`, migration
  `20260922000001_datev_personenkonten`): `Customer.datevAccount` /
  `Supplier.datevAccount`, unique per company, assigned on the first export
  that needs one (Debitoren from 10000, Kreditoren from 70001, 70000 =
  "Diverse Kreditoren" for expenses without a supplier) and kept.
- **Zero-rated revenue** is classified as in the UStVA: igL 8125, Ausfuhr
  8120, § 13b domestic 8337, EU services 8336, third-country services 8338,
  other exempt 8100, Kleinunternehmer 8195. New configurable fields in the
  DATEV settings, labelled in de/en/zh.
- **SKR03 defaults corrected**: USt 7 % 1771 (was 1760 "USt nicht fällig"),
  Vorsteuer 7 % 1571 (was 1577 = Vorsteuer § 13b), Vorsteuer igE 1574 and
  § 13b 1577 (were 1782 / 1780, the Umsatzsteuer-Vorauszahlungen); new
  USt igE 1774, USt § 13b 1787. `receivable` stays 1406: the bank import's
  vouchers book on it, and existing companies' vouchers already do. The bank
  import's 7 % Vorsteuer line now books 1571 (it booked the § 13b account
  1577); vouchers already posted stay as they are. With keys DATEV picks
  the tax accounts itself; these label the Buchungsliste. Stored per-company
  overrides are kept as they are.
- **Vouchers**: skipped when the booking is exported elsewhere — `invoice`,
  `BankReconciliation` (the match records a Payment) and its reopening, and
  Storno vouchers of those. A bank payment of a recorded expense (`Expense`)
  is Bank an Kreditor (it exported the Aufwand and Vorsteuer lines again). The
  rest: one row per booking, a tax line folded into its base line with the
  key; an N:M voucher goes line by line against 1590 (Durchlaufende Posten).
- **Proforma invoices (PI)** are no longer exported (they were, when paid).
- **Buchungsliste / USt-Verprobung / Kontenplan** follow: the gross row is
  split into Sachkonto net + tax account; the Verprobung groups by the real
  keys; the Kontenplan lists the company's actual mapping.
- `PUT /companies/:id/datev-config` saved Berater-/Mandantennummer only when
  `accounts` was in the same body; now always, Beraternummer up to 7 digits.
- Preview endpoint: a negative amount (credit note) is no longer a warning.

Unit test `datev-ust-schluessel.test.ts` rewritten on DATEV's keys (it
asserted the invented ones). `_lib.sh` gains `datev_rows` / `datev_balance`,
which read a Buchungsstapel by column heading. Specs updated, each asserted
the old layout by column position: 07 (Vorsteuer 7 % 1571; the
reconciliation voucher is not exported), 11 (a Storno is one row, sides
swapped), 25 (header fields, KOST1/2, igL / § 13b accounts and keys, CHF in
EUR, payment rows — the currency / Kurs / ISO3 / payment-method columns it
checked do not exist in DATEV's layout), 26 (igE 1574, Lauf in header field
31), 30 (amounts converted at the ECB snapshot instead of a "Kurs" column),
58 (key 3), 198 (gross rows with keys; the customer's account clears);
Playwright `datev-buchungsliste-tier167` (the Kontenplan section).

Non-EUR documents: booked in EUR at the document's stored EUR amount, else
at the company's ECB snapshot (foreign units per EUR), else 1:1.

Local runs: backend **211 passed / 1 failed** (212 specs; `16-dark-mode.sh`
ran instead of skipping because a frontend from an earlier Playwright run was
still up on :3100), 0 × 500; Playwright **929 passed, 1 flaky**
(`legal-pages-tier170` test 4, the cookie banner still visible after
"accept" on two attempts, passed on the third — nothing here touches it).
The failure: `203-tier414-zugferd-cii.sh`, "igl: no CII found in the
ZUGFeRD PDF", in both full runs — never on its own (five times), and not
after replaying every spec before it in order on a fresh stack. No 500 was
logged, so the endpoint answered; the spec now prints the HTTP status and
the start of the body when this happens. Nothing in this tier touches the
ZUGFeRD path. CI run 35705970443 passed it (`igl: ACCEPTABLE`): backend
211 / 0 / 1, Playwright 930, no flaky.

Spec `e2e/212-tier423-datev-buchungsstapel.sh` (17 assertions, 15 failing
against the previous code).

Not done / to confirm with a Berater (§ 9): the SKR03 accounts for the
zero-rated cases; foreign-currency documents are booked in EUR (no WKZ /
Kurs columns); expenses without a bank match have no
payment row (the app records no payment date for expenses); the UStVA and the
aging report still count proforma invoices (next tier); a Debitoren /
Kreditoren master-data file (EXTF category 16) is not exported yet.

### A Skonto payment left the invoice open and the VAT unreduced (Tier 422)

Measured on a 1 190 € invoice with 2 % Skonto (14 days), paid 1 166,20 € on
the issue day:

| | Before | Now |
|---|---|---|
| invoice status | sent | paid |
| open to dun | **23,80** — the dunning chased the discount, plus interest and fees | 0 |
| UStVA 19 % | 1 000 / 190 | 980 / 186,20 (§ 17 UStG) |
| bank-import voucher | 8730 debit 23,80 gross, no VAT correction | cash only; the Skonto is a credit note |

`PaymentService.create` now settles a Skonto when a payment inside the window
(issue date + `skontoDays`) leaves exactly the offered discount open: it
creates a credit note for it, dated the payment day and split over the
invoice's rates like a refund by amount (Tier 416) — "Skonto 2 %". The UStVA,
the open balance and the dunning then see it; the credit note's synthetic
payment settles the invoice. A payment after the window, or of a different
amount, is an ordinary part payment. `createCreditNote` takes an optional
`issueDate` for this.

**A mistake of mine in Tier 421, found here.** `createCreditNote` books a
synthetic "Gutschrift" payment on the original for every credit note, so the
payments already include them. Tier 421's `openBalance` subtracted the credit
notes a second time: a 1 190 € invoice with a 190 € credit note was dunned for
810 € instead of 1 000 €. Fixed (open = total − payments), with a regression
check. (Early in this tier I also believed a credit note did not count towards
settling an invoice — it does, through that synthetic payment.)

`e2e/79` asserted the 8730 voucher line; it now asserts the cash-only voucher,
the credit note (−20,00 net / −3,80 USt) and the paid status.

Spec `e2e/211-tier422-skonto-settlement.sh` (15 assertions, 8 failing against
the previous code).

Not changed, next tier: **the DATEV export contains no credit notes at all**
(it exports paid INV / PI only), so refunds and Skonti never reach the
Berater's books; and its payment row books the invoice total, not the cash
received.

### Verzugszinsen were a flat 9 %, on the invoice total (Tier 421)

§ 288 BGB: Basiszinssatz + 9 percentage points between businesses (Abs. 2),
+ 5 points against a consumer (Abs. 1). The app charged a flat 9 % a year to
everyone, and on the invoice total even after part payments. Measured on a
1 190 € invoice, 100 days overdue, 500 € already paid:

| | Before | Now |
|---|---|---|
| principal / "Offener Betrag" on the letter | 1 190 | 690 |
| rate, business customer | 9 % | 10,52 % (1,52 + 9) |
| rate, consumer | 9 % — **above the legal maximum** | 6,52 % (1,52 + 5) |
| Verzugszins business / consumer | 29,34 / 29,34 | 19,81 / 12,25 |
| totalDue on the letter | 1 224,34 (the 500 demanded again) | 714,81 / 707,25 |
| letter wording | "9.00 % über Basiszinssatz" while a flat 9 % was charged | "10,52 % p. a. = Basiszinssatz 1,52 % + 9,00 Prozentpunkte, § 288 Abs. 2 BGB" |

The settings page always described `verzugszinsPct` as the surcharge over the
Basiszinssatz; the backend applied it as the whole rate. It is now the
surcharge, capped at 5 for a consumer (a company may charge less, not more).
`basiszinssatz.ts` holds the Deutsche Bundesbank table (checked 21.09.2026,
last entry 1.7.2026 = 1,52 %) and computes day by day, so a period across a
1 January / 1 July change uses both rates. **The table must be extended every
half year** — past its last entry it keeps using the last value. The open
balance is total − payments (Tier 422: this said "− credit notes" too, which
subtracted them twice — they are already among the payments); interest runs on today's open
balance for the whole period, which under-charges when a part payment fell
inside the overdue period (never over-charges). The letter shows the invoice
total, the deduction and the open amount, and its legal note cites Abs. 1 or
Abs. 2 by customer type.

Spec `e2e/210-tier421-verzugszinsen.sh` (14 assertions, 12 failing against
the old code).

Not changed — see §9 item 17: the default Mahngebühren (5 / 5 / 10 €, the
first Mahnung included) rest on a code comment citing a "post-2023 § 288 BGB
reform" that I cannot find; and the 40 € Pauschale of § 288 Abs. 5 is not
offered.

### The GoBD archive did not hold the invoices as issued (Tier 420)

Measured on one company — two sent invoices (1 000 € and 200 €), a 500 €
draft, a cancelled 300 € invoice:

| | Before | Now |
|---|---|---|
| summary `totalRevenueNet` / `totalVat` | 1 700 / 323 (the draft counted) | 1 200 / 228 |
| summary `invoiceCount`, PDFs in the ZIP | 4 (the draft included) | 3 |
| MANIFEST.json `revenueNet` | 2 000 (draft and cancelled counted) | 1 200 |
| archived invoice PDF | re-rendered from `{ name, taxId }`: **no seller address, no USt-IdNr., no bank details** | the stored PDF as issued, else rendered as `GET /invoices/:id/pdf` renders it |

The archive is what the company hands the tax office under § 147 AO; the
invoices in it were not the ones the customers received. The first download
of an invoice's PDF is stored (`pdfPath`); the archive now takes that file
byte for byte — measured: after the company moved, the archived copy still
shows the address it was issued with. Invoices never downloaded are rendered
with the full company data and template (`companyContext`, the same fields as
the controller). Drafts were never issued and are left out; a cancelled
invoice was issued and stays in the archive, but not in the totals.

`e2e/103` compared the archive's invoice count with every row of the year,
drafts included; it now excludes drafts.

Spec `e2e/209-tier420-gobd-archive-issued.sh` (12 assertions, 10 failing
against the old code).

### GuV and BWA counted input tax as a cost (Tier 419)

Both summed the expenses' `grossAmount` — the supplier's price including VAT.
For a business that deducts input tax, that VAT comes back through the UStVA;
it is not a cost. Measured on one company, revenue 1 000 € and three expenses
of 100 € net / 119 € gross:

| Report | Before | Now |
|---|---|---|
| GuV Jahresüberschuss | 643 | 700 |
| BWA Materialaufwand / Jahresergebnis | 119 / 643 | 100 / 700 |
| EÜR Gewinn (already net) | 700 | 700 |

`expense-cost.ts` now decides: net, or gross for a Kleinunternehmer (§ 19
UStG, `Company.defaultVatMode`), who cannot deduct input tax. The Bilanz still
reads gross amounts for Verbindlichkeiten — correctly, a payable is the gross.

`e2e/108` and `e2e/112` inserted expenses with gross 400 / net 336.13 and
asserted the GuV / BWA moved by 400 — the defect; they now expect the net.

Spec `e2e/208-tier419-expense-net-cost.sh` (9 assertions, 3 failing against
the old code; the Kleinunternehmer half is the same before and after).

### A long invoice was a PDF of hundreds of mostly blank pages (Tier 418)

The invoice PDF's item table had no page break. Once a row fell below the
page's bottom margin, PDFKit started a new page for each of its cells.
Measured:

| Items | Pages before | Pages now |
|---|---|---|
| 12 | 1 | 1 |
| 25 | **26** | 2 |
| 40 | **116** | 2 |
| 100 | **476** | 4 |

The totals, notes and bank details landed on the very last page, the header
only on page 1, and the one page label written said "Seite 1" wherever it
ended up. The ZUGFeRD PDF embeds the same document, so it had the same page
count.

A row that does not fit now starts a new page with the column headers
repeated (standard and compact layouts), keeping 40 pt free for the page
number; the document is built with `bufferPages` and every page gets
"Seite i von n". The totals guard from Tier 413 still moves the totals block
to a page of its own when it would reach the footer.

Spec `e2e/207-tier418-pdf-pagination.sh` (13 assertions, 9 failing against
the old code): page counts for 5 / 25 / 100 items, every item row printed
exactly once, the labels, headers on every page, totals on the last page, and
the ZUGFeRD PDF's page count.

Not changed: the bank / Impressum footer is drawn on the last page only; the
other PDF generators (Mahnung, Beleg, reports) draw short fixed tables — a
voucher with very many lines could overflow the same way.

### The UStVA put reverse charge on the wrong lines, under invented Kennzahlen (Tier 417)

Measured in one month for one company:

| Transaction | Before | Now |
|---|---|---|
| § 13b sale to a German builder, 1 000 | "sonstige steuerfreie Umsätze" | Kz 60 |
| B2B consulting to an Austrian company, 500 | counted as **igL** | Kz 21 (§ 18b) |
| igL 300, refunded 100 | igL **800** (500 + 300; a 0 % credit note never subtracted) | 200 |
| § 13b purchase 2 000 (domestic) | tax owed 380, **deducted 0** | Kz 84/85 2 000 / 380, Vorsteuer Kz 67 380 |
| igE 400 | tax owed 76, **deducted 0** | Kz 89 400 (76), Vorsteuer Kz 61 76 |
| input tax on a 16 % invoice | dropped | Kz 66 |
| **Zahllast** | **+456** | **−16** |

The output side added net × 19 % for every igE / § 13b purchase, but the input
side read the expense's `vatAmount`, which is 0 on a reverse-charge invoice —
so every such purchase made the company pay the tax it was entitled to
deduct. The tax is now net × the expense's rate on both sides; zero-rated
sales are classified once (invoice flags first, then customer country) and
credit notes use their original's flags.

**The Kennzahlen were invented.** Checked against the BMF form models of
29.12.2025 (USt 1 A 2026 and USt 2 A 2026), none of the app's numbers matched:
19 % / 7 % bases in "Kz 20 / 21" with tax in "Kz 26 / 27", § 13b in "Kz 36",
other exempt sales in "Kz 44" (the form's Kz 44 is new vehicles), input tax
in "Kz 56 / 57 / 59 / 60" (Kz 60 is § 13b *sales*), and **the amount payable
in "Kz 81" — the form's 19 % tax base**. Measured: the old export wrote
`B-Kz081=+000000045600` for a Zahllast of 456 €; typed into ELSTER, that
declares 456 € of 19 % turnover. The UStJA used the same invented set (plus
"Kz 66/67/68/39/69" totals, with a Sondervorauszahlung of "January ÷ 11" —
on the form it is 1/11 of the *previous* year's advance payments).

`ust-kennzahlen.ts` now holds both mappings (USt 1 A: 81, 86, 35/36, 41, 43,
48, 89, 93, 95/98, 46/47, 84/85, 60, 21, 45, 66, 61, 67, 83; USt 2 A: 177,
275, 155/156, 741, 752, 781, 793, 798/799, 846/847, 877/878, 209, 721, 205,
320, 761, 467). The UStVA compute returns its `kennzahlen`; the UStVA page
shows them and exports its CSV from them; the UStJA lines, PDF and both
ELSTER exports use them. Zero-rated sales without an igL / § 13b / export
classification have no single annual Kennzahl (the USt 2 A splits them by
exemption provision) and are listed without one. The UStJA totals are now
Umsatzsteuer − Vorsteuer = verbleibende Umsatzsteuer, minus the
Vorauszahlungssoll (the sum of the computed months; the Finanzamt's Soll
governs) = Abschlusszahlung.

A code comment from Tier 355 left open "whether the UStJA has to report input
tax split by rate / igE / § 13b, or only as a total" and kept four unused
accumulators for it. The USt 2 A answers it — Kz 320 / 761 / 467 are separate
lines — and the UStJA now reports them.

The export files no longer claim to be an ELSTER upload ("one upload away
from being filed"); the text list says "Keine amtliche Upload-Datei". The
XML container itself is unchanged — §9 item 9 still stands.

Also: `SaveUstvaFilingDto` had `@Min(0)` on the sales amounts and the
Umsatzsteuer, so a month whose credit notes exceeded its sales could not be
saved; and it rejected the new fields, which would have broken "save filing"
on the page.

Specs: `e2e/206-tier417-ustva-kennzahlen.sh` (29 assertions, 25 failing
against the old code). `e2e/131` and `e2e/133` asserted the invented
numbering and now assert the official one; `e2e/49` called Kz 81 the
"Verbleibender Betrag"; `frontend/e2e/ustja.spec.ts` looked for the invented
total rows.

Local full run: backend 204 / 1 / 1 (the failure is `50-webhooks`, nip.io DNS
as always locally), 0 × 500; Playwright 928 + 1 failed + 1 flaky before the
fix below. The failure was mine: with only non-zero Kennzahlen listed, the
seed company's UStJA table can be empty, and `ustja.spec.ts` assumed a row —
the section now shows an empty-state row. The flaky one,
`admin-activity-log-tier202` #3, posts a real webhook to httpbin.org and gives
it 5 s; a delivery took 6.1 s. Unrelated to this tier; spun off as a task.

### Credit notes took back the wrong tax (Tier 416)

`createCreditNote` had three ways to build a Gutschrift and each got the tax
wrong. Measured:

| Credit note | Before | Now |
|---|---|---|
| full, of 1 000 € − 10 % @ 19 % (invoice 1 071 €) | −1 190 €, VAT −190 — the discount was not mirrored | −1 071 €, VAT −171 |
| by amount, 119 € of a 19 % invoice — the dialog's "Erstattungsbetrag", i.e. **every partial refund** | one line of −119 € at **0 %** | −100 € + −19 € VAT |
| by amount, 113 € of a 19 % + 7 % invoice (226 €) | −113 € at 0 % | −50 € @ 19 % + −50 € @ 7 %, VAT −13 |
| a refund line without a rate, on a 7 % invoice | 19 % | 7 % |
| two full refunds of a 1 190 € invoice | both accepted (−2 380 €) | the second refused (400) |

In one month's UStVA for those transactions, 19 %: **1 940 / 368,60 before,
950 / 180,50 correct**. A partial refund reduced the customer's debt but not
the output tax (§ 17 UStG), so the company paid VAT on money it had given
back; a full refund of a discounted invoice took back more VAT than was ever
charged.

Now: the refund amount is gross (the dialog pre-fills it with the open
balance) and is split over the original's rates by their gross amounts, one
line per rate; the full refund mirrors the lines *and* the discount (stored on
the CN, so its PDF shows the Rabatt row); a line without a rate takes the
original's rate, and with several rates it must name one; credit notes
together cannot exceed the invoice total, and a "full" refund after partial
ones credits what is left. The dialog's label now says "brutto".

Spec `e2e/205-tier416-credit-note-tax.sh` (18 assertions, 14 failing against
the old code), ending with the UStVA figure above.

**Five specs truncated their deltas.** The full run failed `e2e/106` with
"Kz 4100 delta = 799, expected 800": the data was right — the baseline was
3 795,98, now 4 595,98 — but the spec computed `int(4595.98 − 3795.98)`, and
that float is 799.9999999999995. The same `print(int(float(a) − float(b)))`
was in 106, 107, 108, 109 and 112; any of them failed whenever the shared
company's baseline had cents, which cent-rounded amounts (Tier 415) and
split refunds (this tier) now make common. They round instead.

### Invoice amounts were stored to four places, never to cents (Tier 415)

Every invoice amount was stored with four decimals and never rounded; the
documents rounded only when printing. Measured:

| Invoice | Stored before | Stated on the PDF before | Now stored and stated |
|---|---|---|---|
| 3 × 33,33 @ 19 % | VAT 18,9981 · total 118,9881 | 19,00 · 118,99 | 19,00 · 118,99 |
| 1,5 × 87,35 @ 19 % + 7 × 2,99 @ 7 % | net 151,955 · VAT 26,3598 · total 178,3149 | 151,96 + 26,36 = **178,31** (does not add up) | 151,96 + 26,37 = 178,33 |
| 3 × 0,99 @ 19 % | VAT 0,5643 | 0,56 | 0,56 |
| 3 × 33,33 − 7,5 % | discount 7,4992 · VAT 17,5732 | 7,50 · 17,57 | 7,50 · 17,57 |

The tax owed is the tax stated on the invoice (§ 14c UStG); UStVA, OSS and
DATEV sum the stored VAT, so they drifted from what was invoiced by up to half
a cent per invoice. The in-process XRechnung check itself flagged BR-CO-15 on
the mixed-rate invoice.

`invoice-amounts.ts` (`computeInvoiceAmounts`) now computes an invoice's
amounts once, in integer cents, by EN 16931's rules — line net rounded to the
cent; the discount rounded and split across rates by their line nets; VAT per
rate on the discounted net, rounded (BR-CO-17); total VAT = the sum per rate,
not per line — so the stored figures are what the PDF, XRechnung and ZUGFeRD
state. It replaces four copies of the arithmetic: create, same-day edit,
credit note and the recurring run. Two of them had their own defects: the
**recurring preview** rounded only its totals, so it could show a different
amount from the invoice the run then created (26,36 vs 26,3598), and the
**edit** path reused the stored `discountAmount` from the previous lines when
the discount was a percentage.

The **invoice form's live summary** computed VAT on the lines before the
discount: 1 000 € at 10 % off showed "USt 190,00 · Gesamt 1.090,00", and the
invoice it created said 171,00 / 1.071,00. It now uses
`frontend/src/lib/invoice-amounts.ts`, a copy of the backend module (separate
packages); spec 204 fails if the two differ.

Existing invoices keep their four-place amounts — issued documents are not
rewritten. Reports read both kinds.

Specs: `e2e/204-tier415-amounts-in-cents.sh` (24 assertions, 21 failing
against the old code) and `frontend/e2e/invoice-form-totals-tier415.spec.ts`
(2 tests; the fill-and-check is retried as one step because a fill before
hydration is reset — it failed once that way before the retry was added).

Found on the way, fixed in Tier 416: a full credit note of a discounted invoice
mirrors the lines without the discount (a 1 071 € invoice is refunded as
−1 190 €), and a refund by amount (`amount: 100`) is booked at **0 % VAT**
whatever the original's rate — a partial refund of a 19 % sale reduces the
customer's debt but not the output tax (§ 17 UStG).

### The ZUGFeRD XML was not CII — nothing had ever checked it (Tier 414)

With your go-ahead, the CEN EN 16931 **CII** schematron (`en16931-cii-1.3.16.zip`,
same release as Tier 412) and the **CII D16B schema** (SCRDM subset,
uncoupled code lists, 54 XSD files from the same tag of
ConnectingEurope/eInvoicing-EN16931) are now in `infra/kosit/repository/`,
and `scenarios.xml` has a second scenario, `EN16931-CII`, matched on
`/rsm:CrossIndustryInvoice`. The official CEN examples pass it.

The `factur-x.xml` embedded in every ZUGFeRD PDF **failed the schema before a
single business rule was reached**. The generator wrote elements that do not
exist in CII — `SupplierTradeParty`, `DefinedTradeAddress`, `StreetName`,
`ExchangedDocument/IssueDate` as "01.09.2026", `ExchangedDocument/Name`,
`TestIndicator` with text content — and put the parties straight under the
transaction and the lines last, where D16B wants lines first, then
`ApplicableHeaderTradeAgreement` / `…Delivery` / `…Settlement`. Behind that,
the amounts had the pre-Tier 412 defects: on a 10 % discounted invoice the
tax basis was 1000 and the tax 190, next to `TaxBasisTotalAmount` 1000 and
`TaxTotalAmount` 171; every header tax line was category S, the 0 % igL one
included, with an empty `ExemptionReason`. A receiving ERP that reads the XML
(the point of ZUGFeRD) could not parse it; one that falls back to the PDF was
never told.

`generateZUGFeRDXml` is rewritten in D16B order and takes every amount,
category and discount allowance from `computeXRechnungTotals` — the XRechnung
computation, so the two formats cannot disagree. Parties, identifiers and
electronic addresses follow the Tier 412 rules. Skonto is the `#SKONTO#`
payment term. The igL rule BR-IC-11 wants a delivery date or period: both
formats now use the invoice's `deliveryDate` (Leistungsdatum) when set, else
the issue date — the UBL already used the issue date as its invoice period.

The Factur-X XMP said `fx:Version` 2.1 and `fx:ConformanceLevel` "EN16931";
the Factur-X XMP schema's values are "1.0" and "EN 16931".

`e2e/87` asserted those two wrong XMP values, and **its XML checks never
counted**: the loop that turns them into pass/fail had no input redirect, so
it read the runner's stdin (empty on CI) — the ✓/✗ lines in the log came from
a `cat` before it. It now reads the parse output, and checks for D16B
elements instead of the invented ones.

Spec `e2e/203-tier414-zugferd-cii.sh` (34 assertions, 27 failing against the
old code) runs KoSIT on the CII of six invoices — plain, 10 % discount,
19 % + 7 % with 10 % off, Skonto, igL, § 13b — all ACCEPTABLE, and checks the
key amounts and codes.

Left open: the PDF itself is not PDF/A-3 conformant as ZUGFeRD requires — the
XMP has no `pdfaExtension` schema description for the `fx` namespace, and there
is no output intent; checking that needs veraPDF. The app has no
"validate ZUGFeRD" endpoint (`/xrechnung/validate?engine=kosit` covers UBL
only); the CII scenario is used by spec 203 directly.

### The invoice document never showed the discount (Tier 413)

The PDF the customer receives — and the invoice detail page, and the customer
portal — printed the line sum *before* the invoice discount next to the
discounted total. Measured on a 1 000 € invoice at 10 % off:

```
Zwischensumme (Netto):   1.000,00
Gesamtbetrag USt:          171,00     1 000 + 171 = 1 171, not 1 071
Gesamtbetrag:            1.071,00
```

The 100 € reduction appeared nowhere, which § 14 Abs. 4 Nr. 7 UStG requires
("im Voraus vereinbarte Minderungen des Entgelts"), and a 19 % + 7 % invoice
showed one blended figure instead of each rate's Entgelt and tax (Nr. 8). The
totals block is now built from the Tier 409 breakdown:

| | Before | Now |
|---|---|---|
| 1 000 € − 10 % | Zwischensumme 1.000,00 · USt 171,00 | Zwischensumme 1.000,00 · **Rabatt 10 % −100,00** · **Nettobetrag 900,00** · USt 19 % 171,00 |
| 100 € 19 % + 100 € 7 % | Gesamtbetrag USt 26,00 | **USt 19 % auf 100,00 → 19,00** · **USt 7 % auf 100,00 → 7,00** · Gesamtbetrag USt 26,00 |

`formatVatRate` had a third defect of its own: it mapped 19 % and 7 % and
returned **"0%" for everything else**, so a 16 % or 5 % line (2020's rates)
stated a rate the invoice did not charge. It now formats any rate.

The block is 2 to 6 rows now, so on a long invoice it can reach the footer.
When it does not fit, it starts a page of its own — an overflowing block
pushed the footer onto a second page by itself (measured with 12 items).

The invoice detail page and the customer portal show the Rabatt row too; the
portal's footer had the same before/after mismatch.

Specs: `e2e/202-tier413-invoice-pdf-discount.sh` (25 assertions, 14 failing
against the old code) reads the PDF's text with `pdf_contains`;
`frontend/e2e/invoice-discount-row-tier413.spec.ts` (2 tests) covers the
detail page.

Left open: the ZUGFeRD/Factur-X CII XML still groups VAT per line and ignores
the discount (XRechnung was fixed in Tier 412); invoice amounts are stored to
4 places and never rounded to cents; a multi-page invoice still labels every
page "Seite 1".

### Every XRechnung failed EN 16931 — the check never ran it (Tier 412)

With your go-ahead (§9 item 16) the CEN EN 16931 UBL schematron is now in
`infra/kosit/repository/schematron/en16931/` (release
`validation-1.3.16`, `en16931-ubl-1.3.16.zip`, EUPL-1.2, checksums in the
README there and in `setup.sh`) and runs as step 2 of
`infra/kosit/scenarios.xml`, before the XRechnung rules. The first run with it
**rejected every invoice the app produced, including a plain one**:

| Invoice | Rules broken |
|---|---|
| all | BR-06 / BR-07 (no `PartyLegalEntity/RegistrationName`), BR-CL-25 (`EndpointID schemeID="DE:VAT"` is not an EAS code; a Steuernummer went out as 9931 — the **Estonian** VAT number) |
| 10 % discount | BR-CO-14 / BR-CO-15 — tax subtotal 190 from the lines next to a total tax of 171 |
| Skonto | BR-S-08, BR-CO-11 — Skonto as a document allowance that reduced nothing |
| igL, § 13b | BR-E-01, BR-S-01, BR-S-08 — 0 % lines as S/E, no exemption reason |
| buyer without e-mail (AT) | PEPPOL-EN16931-R010 — no buyer electronic address |
| seller with only a Steuernummer | BR-S-02, BR-CO-26 |

plus warnings for `LineCountNumeric`, per-line `TaxTotal` and the
`listID`/`listAgencyID` attributes. `xrechnung.service.ts` now:

- computes every amount once, in integer cents (`computeXRechnungTotals`):
  lines stay undiscounted (EN 16931's line net); an invoice discount becomes
  one document allowance per VAT category (reason code 95), sized so each
  category's taxable amount is its share of `total − totalVat` from the
  Tier 409 breakdown; tax per category = taxable × rate; payable = taxable +
  tax. The arithmetic rules hold by construction.
- names the tax category from the invoice: rate > 0 → S; `euTransaction` → K
  (VATEX-EU-IC, with the deliver-to address, BR-IC-12 / BR-DE-10/11);
  `reverseCharge` → AE (VATEX-EU-AE); otherwise E.
- writes Skonto as the XRechnung payment-terms line
  `#SKONTO#TAGE=14#PROZENT=2.00#`, not as an allowance.
- gives both parties a `RegistrationName` (the seller's `legalName` when set),
  the seller's `registerEntry` as BT-30, a Steuernummer as BT-32 (tax scheme
  `FC`) and — when there is no VAT id and no register entry — also as the
  seller identifier BT-29, which BR-CO-26 needs.
- uses CEF EAS codes for `EndpointID`: e-mail `EM`, Leitweg-ID `0204`, a VAT
  id under its country's code (DE 9930, AT 9914, FR 9957, … — `vatEasScheme`).
- drops `LineCountNumeric`, line `TaxTotal` and the `listID` attributes.

The in-process check (`engine=basic`) compared the stored totals with the
lines (BR-CO-09/10/13), which a correctly discounted invoice can never
satisfy; it now checks the computed XML totals against the document
(payable = total, tax = totalVat, ±0.01), requires the seller's e-mail or an
EAS-coded VAT id (BR-09 — a Steuernummer is not an electronic address) and
the buyer's electronic address (PEPPOL-EN16931-R010).

Measured after the change with the real validator: plain, 10 % discount,
19 % + 7 %, 19 % + 7 % with 10 % off (odd cents), Skonto, igL, § 13b and an
Austrian buyer without e-mail are all `ACCEPTABLE` with no warnings.

Spec `e2e/201-tier412-xrechnung-en16931.sh` (46 assertions, 32 failing
against the old code). `e2e/139` asserted the old defects (`DE:VAT`,
`LineCountNumeric`, Skonto as `AllowanceCharge`) and now asserts the
corrections; it also seeds the company e-mail and — a leak found on the way —
restores the seed company's `vatId`/`taxId`, which its BR-09 section wiped and
never put back.

Left open: ZUGFeRD / Factur-X (CII) reuses the transform but has its own
generator with the same per-line VAT grouping, and nothing validates the CII;
the PDF of a discounted invoice still shows no discount line (§ 14 Abs. 4
Nr. 7 UStG) and no per-rate VAT.

### The income statements counted revenue before the discount (Tier 411)

Tier 409 put the tax figures on the discounted, per-rate breakdown; the income
statements still took `eurSubtotal ?? subtotal` — the amount *before* the
invoice discount. One company, a 1 000 € invoice at 10 % off plus a 100 € 19 %
+ 100 € 7 % invoice — net revenue 1 100:

| Report | Before | Now |
|---|---|---|
| EÜR 4100, Anlage S 4100 | 1 200 | 1 100 |
| GuV Umsatzerlöse, BWA Erlöse | 1 200 | 1 100 |
| GoBD archive summary `totalRevenueNet` | 1 200 | 1 100 |
| sales report `totalSales` | 1 200 | 1 100 |
| Anlage G 2110 / 2120 | 1 200 / **0** | 1 000 / 100 |

Anlage G had a second defect of its own: its 19 % matcher took any invoice with
VAT and ran first, so the 7 % line (2120) was unreachable, and a mixed invoice
could only land on one line. It now splits each invoice per rate with the
Tier 409 breakdown (0 % → 2130 for a Kleinunternehmer, otherwise 2190; igL /
§ 13b → 2150, as in Tier 410).

`invoiceNetRevenue()` (in `tax-breakdown.ts`) is `total − totalVat`, from the
EUR amounts stored at issue when the invoice has them, signed so a credit note
stays negative. Anlage S and V now aggregate in EUR too, as EÜR already did.
The sales report keeps the invoice currency, like the rest of that report.

Spec `e2e/200-tier411-net-revenue.sh` (11 assertions), 8 failing against the
old code.

Left open (fixed in Tier 420): the GoBD archive summary and its PDF bundle include drafts and
cancelled invoices in the revenue total (the document list should include them;
the total arguably should not); BWA sums expenses by `grossAmount` (with VAT) — fixed in Tier 419.

### Every igL and reverse-charge invoice was issued with 19 % VAT (Tier 410)

`invoice.service.ts` wrote `item.vatRate || 0.19` in twelve places. `0` is
falsy. The invoice form, when the user picks *Reverse Charge* or
*innergemeinschaftliche Lieferung*, sets every line to `vatRate: 0` — so the
backend stored and billed 19 %. Measured, sent exactly as the form sends them:

| Invoice | Before | Correct |
|---|---|---|
| igL (§ 4 Nr. 1b / § 6a), 1 000 € net | VAT 190, total **1 190**, line rate 0.19 | 0 / 1 000 / 0 |
| § 13b reverse charge, 1 000 € net | VAT 190, total **1 190** | 0 / 1 000 |
| a 0 % line (§ 4 steuerfrei), 100 € | VAT 19 | 0 |
| 19 % + 0 %, 100 € each | VAT 38 | 19 |
| a same-day edit of a 0 % invoice | VAT 38 on 200 | 0 |

An invoice that states VAT owes it whether or not it was due (§ 14c UStG):
the company owed 190 € per such invoice, the EU business customer was billed
German VAT on a tax-free supply, and the document contradicted itself —
flagged tax-free, VAT on it. `vatRateOf(item)` now defaults only a *missing*
rate (`??`). The product CSV import had the same `|| 0.19`; an unparseable
value still falls back to 19 %, an explicit 0 no longer does.

**A second defect on the same path.** With the rate fixed, the igL invoice
still did not reach the UStVA's igL line: the classifier read
`customer.country`, and `Customer` has no such column — the country is in the
address JSON — so it was always `''` and every zero-rated sale fell through to
*sonstige steuerfreie Umsätze*. The igL figure the ZM is reconciled against was
0 for everyone. It now reads `address.country` (normalised like the OSS
report: "Frankreich" → FR) and the invoice's own `euTransaction` flag wins over
any inference.

**A third, surfaced by the full suite.** Once 0 % invoices really were 0 %,
EÜR and Anlage S filed them as **§ 19 Kleinunternehmer revenue**: their
zero-VAT matcher (4120) took *every* invoice without VAT and ran before the
tax-free line (EÜR 4170 / Anlage S 4135), which in turn only looked at
`reverseCharge` and never at `euTransaction`. Neither was visible before, since
no invoice was ever really 0 %. Now the tax-free line takes the invoice's own
igL / § 13b flags and any zero-VAT revenue of a company that is not a
Kleinunternehmer; 4120 is used only when `Company.defaultVatMode` is
`kleinunternehmer`.

Two existing specs had **baselines that only held because of the bug**, and
went red in the full run once other specs' igL / § 13b invoices landed on the
tax-free line: `e2e/106` asserted every non-4100 revenue line of the shared
company was 0 and compared the revenue *total* against the *4100* baseline;
`e2e/141` summed every 2026 invoice as if all were 4100. Both now baseline what
they measure (per line, and what EÜR actually puts on 4100: invoices with VAT
plus credit notes).

Spec `e2e/199-tier410-zero-vat-rate.sh` (24 assertions), including EÜR's
classification for an ordinary company (igL → 4170) and for a Kleinunternehmer
(→ 4120), and a static gate that no `|| 0.<n>` default on a VAT rate is left
in `src`. 10 of the original 19 fail against the old code; the EÜR ones do too.

**An unexplained 500, and why the log could not explain it.** One of four
full backend runs failed `e2e/15-dashboard-kpis.sh` with a 500 from
`GET /reports/dashboard`; the other three passed, two sequential runs of specs
01-15 passed, and the endpoint answered 200 on the same database afterwards.
The backend log had nothing — and could not have had: `e2e/20` and `e2e/191`
restart the backend with `> /tmp/backend.log`, **truncating** everything
written before them, so the "zero 500s in the log" check every tier has
reported only ever covered the specs after spec 20. Both now append. The run
after that change reported 199 / 0 / 0 with zero 500s across the whole run,
which is the first time that number covered every spec. If the dashboard 500
comes back, the log will now say why; the suspicion to test first is the
Prisma pool (the stack's `DATABASE_URL` sets no `connection_limit`, and
Tiers 406-408 added a serialised audit write per changed record).

**Next, found while tracing this (Tier 411):** EÜR, Anlage S / G / V, GuV, BWA,
Bilanz and the GoBD archive summary still take `subtotal` — the amount *before*
the invoice discount — as revenue. Tier 409 fixed the tax figures (UStVA, OSS,
VAT report, DATEV); the income statements need the same treatment.

Found on the way and **not** changed:

- **Outgoing § 13b sales** belong in UStVA Kz 60; the compute result has no
  field for it, so they still land in *sonstige steuerfreie Umsätze*. Adding
  the field touches the UStVA PDF and page — its own tier.
- **The KoSIT engine does not check EN 16931** — see §9 item 16. It needs a
  download to fix, so it is a question, not a change.
- **Skonto is emitted as a document-level `AllowanceCharge`** in the
  XRechnung without reducing `TaxExclusiveAmount`. EN 16931 treats Skonto as a
  payment term (`#SKONTO#` in the XRechnung PaymentTerms note), not an
  allowance. The in-process check does not look for it and, per item 16,
  neither does "KoSIT". Belongs with the document tier below.
- Still open from Tier 409: the discounted invoice's PDF and XRechnung.

### The invoice discount never reached a tax figure (Tier 409)

Started from rounding (invoice amounts are stored to 4 places and never
rounded to cents — still open, see below) and found something much larger.
An invoice-level discount lives only on the invoice; the stored line amounts
are *before* it (create stores quantity × price — which is also what EN 16931
means by a line's net amount). Every tax figure was built from those lines.
One invoice, 1 000 € net, 10 % discount, 19 %, customer pays 1 071 €:

| Figure | Before | Owed |
|---|---|---|
| UStVA 19 % | net 1 000, VAT 190 | 900 / 171 |
| OSS (AT customer, 200 € − 10 %) | 200 / 38 | 180 / 34.20 |
| DATEV revenue | **1 000 on 8125, key 0** | 900 on 8400, key 1 |
| DATEV VAT | 171 on 1760 (the 7 % account) | 171 on 1776 |
| DATEV receivable | debit 1 071, credit 1 171 — 100 short | balanced |

DATEV derived one blended rate as `totalVat / subtotal`; 171 / 1 000 = 0.171
is neither 19 % nor 7 %, so the revenue went to **8125 — the tax-free
intra-EU account the ZM is built from** — and the VAT to the 7 % account. And
the blend did not need a discount to go wrong: **every 19 % + 7 % invoice**
(26 / 200 = 0.13) was exported the same way, its whole revenue as tax-free EU
turnover. Two smaller ones rode along: the VAT report (`/reports/vat`) counted
drafts (measured: 1 600 / 304 instead of 1 000 / 190), and `update()` stored
discounted line net/VAT next to an undiscounted gross while `create()` stored
undiscounted amounts — saving an invoice unchanged on its issue day changed
every report that read its lines.

`src/modules/invoice/tax-breakdown.ts` is now the one place that answers
"which taxable amount and which tax, at which rate". It anchors on the
invoice's own totals — the document the customer received, whose stated tax is
what is owed (§ 14c UStG): net after discount = total − totalVat, tax =
totalVat. Only the split across rates comes from the lines (weighted by
quantity × price, and by quantity × price × rate for the tax), rounded to 4
places with the remainder on the largest bucket so the parts always sum to the
document. UStVA (sales and credit notes), the VAT report, OSS and the DATEV
export all read it; DATEV now emits one revenue row and one USt row per rate,
on that rate's account with that rate's key. `update()` stores the same line
semantics as `create()`. For invoices already edited under the old update
path, the breakdown does not read the stored line amounts at all, so their
reports are right too.

Spec `e2e/198-tier409-tax-breakdown.sh` (22 assertions): UStVA per rate and in
total, the VAT report without the draft, DATEV's accounts and keys per rate
with both invoices balancing and nothing on 8125, OSS for an Austrian private
customer, and an unchanged same-day save leaving lines and totals alone. 11
fail against the old code — with the old numbers in the table above.

**Still open, deliberately not in this tier:**

- **The documents.** The PDF for that invoice prints *Zwischensumme (Netto)
  1.000,00 · Gesamtbetrag USt 171,00 · Gesamtbetrag 1.071,00* — no discount
  line, so it does not add up, and § 14 Abs. 4 Nr. 7 UStG wants an agreed
  reduction of the consideration stated. Its XRechnung fails the validator on
  exactly this (BR-CO-09: tax subtotal 190 ≠ total tax 171; BR-CO-13; the
  100 € allowance is absent and the taxable amount is 1 000). Next tier.
- **Rounding.** Totals are stored to 4 places (0.357, 3.5343, 33.7133 measured)
  and never rounded to cents, while the PDF shows cents. Needs its own look.

### A bulk write left a count, not a record (Tier 408)

`updateMany` / `deleteMany` on an audited model wrote one row: entityId
`bulk:<where>`, newData `{ count }`. Measured on a customer merge:

- both invoices moved to the other customer, and each invoice's own trail still
  read only `invoice.created`;
- the one relevant row said "2 invoices of customer A were updated" — not
  which, and not to what;
- five more rows said `{ count: 0 }` for relations the customer did not have.

The same shape covered an invoice's items deleted with it, the AfA storno
deleting booked depreciation, a SEPA batch marking invoices paid, and customer
credit / instalment / mandate moves in the merge. *Wer hat wann was geändert*
had no answer precisely for the operations that change many booked records at
once.

Now each affected record gets its own row under its own id: the before-image
(read before the statement) and, for an update, the after-image. **The
after-image is read lazily, when the audit row is written** — that is the
subtle part. The merge runs in a transaction, and a read from the audit
writer's own connection before commit would still see the *old* customer; with
Tier 406's buffer the row is written after commit, so the after-image is the
committed state (asserted). Outside a transaction the statement has already
committed when the row is written.

- A bulk that matched nothing writes nothing.
- `ErrorEvent` keeps the count-only row: its bulk operations are retention
  purges and "resolve all" over operational data, with per-row rows written
  elsewhere since Tier 208.
- Above `BULK_DETAIL_CAP` (5000) records the first 5000 are detailed and a
  summary row notes the rest, so a runaway statement cannot stall a request on
  the serialised audit writer.
- Composite-key models (no `id`) keep the summary row.

Spec `e2e/197-tier408-bulk-audit.sh` (17 assertions): both merged invoices show
source → target in their own trail, attributed, with the committed after-image,
and no count-only rows; a deleted invoice's two items each on the record with
their text; the AfA storno's removed booking on the record under its own id
with amount and asset; the chain verifying; and the two escape hatches pinned.
10 fail against the old code.

Found on the way, left as a decision (§9 item 15): the AfA storno deletes the
bookings rather than reversing them.

### Payments, roles and company data had no audit trail (Tier 407)

Tier 406 made transactional writes reach the audit extension. The next question
was what the extension actually covers: 18 models. Everything else was written
with no row — and, checked service by service, with no explicit
`writeActivity` call either. Measured:

| Change | Trail before |
|---|---|
| a 119 € cash payment recorded, then deleted | three `invoice.updated` rows; nothing naming the payment, the amount or who deleted it |
| a member's role changed viewer → accountant | **no row at all** — `changeRole` upserts, and the extension had no `upsert` hook |
| registration / invitation acceptance | `usercompany.created` with `companyId` NULL — on the company-less chain, absent from the company's own trail |

Added to `AUDITED_MODELS`: the records that carry money or settle a debt —
`Payment`, `Mahnung`, `Mahnungspause`, `InstallmentPlan`, `Installment`,
`CustomerCreditTransaction`, `CashBookDailyClose`, `UStvaFiling`, `VoucherLine`,
`BankReconciliation`, the four SEPA models, `VatRate` — and who may do what:
`Company` (tax numbers, bank details) and `UserCompany` (roles).

Four supporting changes in the extension:

- **`upsert` and `createMany` hooks.** `upsert` records `created` or `updated`
  depending on whether a before-image existed. Nothing calls `createMany` on an
  audited model today; the hook is there so the first caller does not reopen
  the gap.
- **Composite keys.** `getPreImage` only knew `where.id`; update/delete always
  take a unique input, so it now uses `args.where` as given, and `extractId`
  turns `{ userId_companyId: {…} }` into `userId:companyId`. Without this a
  role change had no before-image and no findable entity id.
- **Company fallback for public routes and crons.** When the request context
  has no company, the row's own `companyId` is used, so registration,
  invitation acceptance and the payment portal land in the company's chain.
  The context is **copied** first: it is one mutable object per request (the
  guard fills it in since Tier 400), and assigning into it would have leaked
  one row's company into every later write of the same request.
- **`sanitize()` redacts PEM private keys at any depth and no longer mutates.**
  Adding `Company` carried a real risk: before Tier 208 a company's signing key
  lived in `Company.settings.signing.key`, and a database from that era would
  have copied it into an append-only, hash-chained table on the first company
  update — permanently. Any string carrying `-----BEGIN … PRIVATE KEY-----` is
  now `[REDACTED]`, wherever it sits and whatever the field is called, plus a
  few named secret columns. The old version also wrote `[REDACTED]` into the
  very object the query returned to the service; the new one copies only the
  levels it changes and leaves Decimal / Date instances alone for the Tier 366
  hash canonicalisation.

Measured after: the payment's trail is `payment.created, payment.deleted` with
amount and actor; the role change is `usercompany.updated viewer → accountant`
by the admin; both memberships are in the company's chain; a company update
with a planted legacy key is audited, the key text appears **0** times in
`AuditLog`, the rest of `settings` is kept, the company row is untouched, and
the chain verifies.

Spec `e2e/196-tier407-audit-coverage.sh` (24 assertions) asserts all of that,
plus a gate: every model with a `Decimal` column must be in `AUDITED_MODELS` or
in the spec's exemption list with a reason (`ProductStockHistory` and
`VatRateHistory` are history tables themselves, `RecurringInvoiceItem` is a
template, `Asset` writes explicit activity rows since Tier 368). A new
money-bearing model turns it red until someone decides. 13 fail against the old
code.

### Writes inside a transaction were never audited (Tier 406)

Found by pulling on something smaller. `InvoiceService.delete` allows removing
the newest invoice of the day — measured, that included a **paid** one, and its
119 € payment went with it. Then the audit trail for that invoice read
`invoice.created, invoice.updated, invoice.updated` and stopped: no deletion,
no payment. The extension covers `delete`, so why no row?

**Cause.** `PrismaService` copies the audit-extended client's model accessors
onto itself and skips every `$…` member, so `this.prisma.$transaction` is the
one `PrismaService` inherits — a *second*, unextended `PrismaClient`. In the
callback form, `tx` belongs to that client and every write through it bypassed
the audit extension. Controlled measurement:

| Write | Audit rows |
|---|---|
| plain invoice create | 1 |
| credit note (`$transaction(async tx => …)`) | **0** |
| voucher correction (`$transaction([…])`) | 1 — the array form's promises come from the extended accessors |

Eleven callback-form sites were affected: **credit notes, recurring invoices,
customer credit movements, customer merges, instalment plans, portal
"mark paid", invitation acceptance, invoice deletion.** For a GoBD system the
credit notes and recurring invoices alone are the kind of gap a Prüfer finds.

**The obvious fix was wrong on its own.** Pointing `$transaction` at the
extended client does produce the rows — measured, it also produced a row for a
write that was then **rolled back** (customer absent, audit row present),
because the extension writes on its own connection. So inside a transaction the
rows are now held in an `AsyncLocalStorage` buffer and written only after the
transaction commits (`runWithBufferedAudit`); a rollback rejects before the
flush and the buffer is dropped. The request context is captured when the
change is made, so a buffered row is attributed to whoever made it; a nested
transaction leaves the flush to the outermost. The array form now runs on the
same client and pool too. None of the eleven callbacks writes through
`this.prisma` instead of `tx` (checked), which is the one pattern the buffer
would mis-handle — a non-tx write inside a callback that later rolls back.

`scripts/probe-audit-transactions.ts` drives exactly that wiring against a
database and prints `{"committedRows":1,"rolledBackRow":0,"rolledBackRows":0,
"nestedRows":1}`.

**Two neighbouring findings, fixed with it.**

- **An invoice with recorded payments could be deleted**, payments and all. It
  is now refused with a message pointing at Storno / Gutschrift. A payment is a
  booked cash receipt.
- **The "only the newest may be deleted" rule no longer did its job.** It
  exists so the series stays *lückenlos*, but since Tier 174 numbers come from a
  SEQUENCE that never goes back: delete the newest draft, create the next, and
  the book read 1, 3 (measured). `releaseInvoiceNumber()` now sets the
  company's sequence back — **for drafts only**. A sent invoice's number may be
  in a customer's hands; issuing it again would put two documents with one
  number into circulation, which is worse than a gap the audit row now
  explains.

**Left open, as a decision (§9 item 14):** `update` and `delete` still allow a
*sent* invoice to be changed or removed on its issue day. That is a policy
question, not a defect with one right answer.

Spec `e2e/195-tier406-transaction-audit.sh` (27 assertions): the credit note's
and the recurring invoice's audit rows with user and company, the probe's
commit / rollback / nested counts, the paid invoice refused with invoice and
payment intact, a sent invoice's deletion audited with its number in the
before-image and not reused, a draft's number given back, and the company's
audit chain still verifying after the buffered writes. 16 fail against the old
code.

### A flaky test that was a production 502 (Tier 405)

Tier 404's CI run reported success, but Playwright counted **925 passed + 1
flaky**, not 926. `gobd-month-button-tier183` #4 had failed once with

```
Error: apiRequestContext.get: read ECONNRESET
  → GET http://localhost:3001/api/v1/gobd-export?year=2026&month=13&…
```

and passed on retry. Nothing about that request was wrong — it is a plain
400-path check. The obvious move is to shrug at a retry that passed; the job
verdict invites exactly that. The count is what made it worth a look, and
§1 has tracked "0 flaky" since Tier 365b.

**Cause: Node closes idle keep-alive sockets after 5 s.** Measured with the new
`backend/scripts/probe-keepalive.ts` (one TCP connection, one request, then
silence, report when the server hangs up): **closed 6004 ms after the
response.** Any client that pools connections can reuse a socket at the moment
the server closes it; Playwright's request context did, and got ECONNRESET.

**In production that client is nginx.** `infra/prod/nginx.conf` pools upstream
connections (`keepalive 32`, `proxy_http_version 1.1`, `Connection ""`) with
nginx's default 60 s `keepalive_timeout`. nginx believes a socket is good for a
minute that the backend drops after five seconds, so under light traffic —
exactly when a socket sits idle — a user's request can land on a dead one and
get **502 "upstream prematurely closed connection"**: intermittent, unlogged by
the app, and unreproducible by hand. The flaky test was the only place this was
visible before deployment.

- `main.ts` sets `server.keepAliveTimeout = 65 s` (overridable with
  `HTTP_KEEPALIVE_TIMEOUT_MS`) and `headersTimeout` 1 s above it — Node needs the
  latter larger, or it can drop a connection while the next request's headers
  are arriving on it. The rule is simply that the server must outlast every
  client that pools connections to it.
- `nginx.conf` states `keepalive_timeout 60s` on the backend upstream. That is
  nginx's default, so no behaviour changes; it is there so the pairing is
  visible where someone would change it.

Measured after: the idle socket was **still open after 15 s**; with
`HTTP_KEEPALIVE_TIMEOUT_MS=3000` it closed at ~4 s, which shows both that the
knob works and that the probe does detect a close.

Spec `e2e/194-tier405-keepalive.sh`: an idle socket survives 10 s (the old
server closed at ~6 s), and — statically, since nobody wants a 65 s test — the
backend default, the `headersTimeout` derivation, nginx's explicit value, and
that the backend's is the larger. Raising nginx's timeout past the backend's
turns the spec red. 4 of the 5 assertions fail against the old code.

**Lesson:** a job that says success is not the same as a count that matches.
Tier 395 found a hidden skip that way; this one was a flaky that pointed at a
production failure mode.

### Every tenant was numbering invoices out of one shared counter (Tier 404)

Two fresh companies on a throwaway stack, alternating creates:

```
A: INV-2026-000001
B: INV-2026-000002
B: INV-2026-000003
B: INV-2026-000004
A: INV-2026-000005
```

Company A's books go 1, 5. Tier 174 was right that numbering had to be atomic
and used a Postgres SEQUENCE per (type, year) — but one sequence for the whole
platform, reasoning that `@@unique([companyId, invoiceNumber])` "already handles
per-company isolation downstream". It does prevent duplicates; it also hides
what the shared counter does to each tenant's series:

- **Cross-tenant leak.** A reads its own gaps and knows how many invoices
  everyone else issued between its two.
- **§ 14 Abs. 4 Nr. 4 UStG.** The number must be *fortlaufend*. In a
  Betriebsprüfung the operator has to explain the missing numbers, and the only
  explanation is other clients' invoices — data they may not show.

The sequence is now per `(company, type, year)`. Existing numbers are never
rewritten (GoBD § 146 forbids altering a booked document): a company's sequence
is created starting **above** the highest number that company already used for
that type and year, read from the invoice numbers themselves rather than from
`sequenceNumber`, which is null for every row written before Tier 174.

**A second bug, measured while proving the first.** On the old code the shared
sequence had no relationship to any one company's numbers, and when it handed
out a number that company had already used, the P2002 from the unique
constraint was never caught — the invoice create answered `500 Internal server
error`. Cross-tenant traffic can no longer cause that, but a restore or a
direct insert still can, so the numbering now checks its candidate, and on a
clash fast-forwards the sequence past the company's max and takes the next one
(bounded to three attempts). Measured after: rewinding a sequence by hand
yields the next free number instead of a 500.

**And the code existed twice.** `recurring.service.ts` had its own copy with a
comment asking that "the two implementations must stay in sync" — they had
already drifted (the recurring one hardcoded `INV` and skipped the Tier 318
type guard), and it used the shared sequence, so every recurring run punched a
gap into every other company's books. Both now call
`src/modules/invoice/invoice-number.ts`, which is the only copy and carries the
Tier 174 / 318 reasoning with it.

Spec: `e2e/193-tier404-invoice-numbering.sh` (23 assertions) — two companies
each numbering from 1 through interleaved creates, credit notes as their own
per-company series, an existing company continuing at max+1 with nothing
reused, 8 parallel creates still distinct and contiguous (Tier 174's original
race), the self-repair after a rewound sequence, and a recurring run taking its
own company's next number without moving anyone else's. 11 of them fail against
the old code.

### A password reset did not end the sessions (Tier 403)

Sessions (Tier 400) gave the app a credential that outlives a single request —
and nothing took it away when it had to. Measured on the stack:

```
register → session minted        GET /customers  200
forgot-password + reset-password {"ok":true,"…Sie können sich jetzt anmelden"}
the SAME session afterwards      GET /customers  200   ← the hole
```

Resetting the password is the move someone makes when they believe their
account is in the wrong hands. With 30-day sliding expiry the intruder kept
working for a month while the owner believed they had locked them out.

The two neighbouring cases were measured too, and both were **already** safe —
worth recording so nobody "fixes" them twice: `HeaderAuthGuard` re-reads the
user and the `UserCompany` row on every request, so deactivating a user (401)
and revoking a company grant (401) take effect immediately. The password reset
was the one path that evicted nobody.

- `UserSessionService.revokeAllForUser()`, called from `resetPassword`. The
  count goes into the `password_reset_success` audit row's `newData`, so the
  trail shows the lock-out happened rather than only that a password changed.
- The owner logs in again — which the response already told them to do.

**Second finding, from the same look: nothing ever deleted a session row.**
Not `UserSession`, not the `CustomerPortalSession` that has carried the portal
since Tier 130. One row per sign-in, for ever — 20 users logging in daily is
~7000 rows a year, plus one per magic link a customer clicks. The new
`session-cleanup` cron (03:30 Europe/Berlin, between the cron-health check and
the backup) drops rows whose `expiresAt` is older than
`SESSION_RETENTION_DAYS` = 90. They are kept that long on purpose: a dead row
still answers "who was signed in, from which address, when", which is what an
incident review or a GoBD question actually asks. It is the 9th registered
cron, so `e2e/143`'s three hard-coded `8`s became `9` — that count is exactly
what the assertion is for. The Playwright side asserts `>= 7`, so it was
unaffected.

**CI caught what my grep did not.** Adding the 9th cron means editing every
place that pins the count, and I found two of the three: `e2e/143` (three `8`s)
and `system-health.spec.ts` (which asserts `>= 7`, so it was fine). The third,
`cron-history-tier124.spec.ts:51`, pins `toHaveCount(8)` — I had grepped the
Playwright specs for `crons` and `toBe(8)`, and that line matches neither.
Playwright went 926 → 925. The count is pinned on purpose in both suites, the
same deliberate-edit gate as the `EXPECTED` registry, so the fix is the number,
not a looser assertion. **Lesson, sharper than Tier 398's:** when a change
alters something a spec can count, grep for the *thing being counted*
(`cron-row`, the registry name) across **both** suites, not for the number or
the word.

Spec: `e2e/192-tier403-session-lifecycle.sh` (18 assertions) — two sessions
from two sign-ins both die at the reset, both rows carry `revokedAt`, none is
left live, the audit row records the count, the old password stops working and
the new one mints a fresh session; then the cleanup cron drops a 200-day-old
row, **keeps** a 5-day-dead one (the evidence window) and leaves the live
session alone, with the run visible in `CronHealth`. 7 of them fail against the
old code.

### The production auth mode is now measured, not grepped (Tier 402)

Tiers 400-401 left `ALLOW_HEADER_AUTH=1` on in CI, because ~300 specs
authenticate with the header. That meant **nothing ever started the app the way
production runs it**: spec 190 could only grep the two guards for the flag, the
same way the `@Throttle` limits are checked (`THROTTLE_DISABLED=1` in CI). A
grep cannot catch a controller that reads `x-user-id` directly (Tier 399
counted 14 of them), a login path that mints no session — exactly the Tier 401
bug, which was invisible while the header worked — or a public route that stops
answering.

`e2e/191-tier402-production-auth-mode.sh` restarts the backend with
`ALLOW_HEADER_AUTH=0`, measures, and restarts it back. The restart follows
`e2e/20` (which already does this for `VIES_MOCK`): kill by port, go through
`scripts/start-backend.sh` so `FRONTEND_URL` and friends survive, and wait on
`/health/deep` rather than `/health`, which answers before Nest has wired the
modules. Two details make it safe to have in the suite:

- it is numbered **last** (the runner's glob expands in sorted order), and
- it restores the backend from an `EXIT` trap, so a failed assertion cannot
  leave later specs talking to a backend in the wrong mode. The final assertion
  is that `x-user-id` works *again*, which is what proves the restore happened.

Measured with the flag off: the legacy header is `401 … keine gültige Sitzung`;
login and register both mint sessions and the cookie and Bearer forms each
answer 200; a brand-new company is usable immediately; `/health` and
`/invitations/verify` still reach their handlers rather than the guard; and a
write under session-only auth is attributed to the session's user in `AuditLog`.

A hazard worth recording, hit while writing this: run standalone from a shell
that has no `DATABASE_URL`, the restart falls back to `.env` and the backend
comes up against the **dev** database at :5432 (it failed with P1001 here only
because that container was not running). Inside `run-all.sh` — in CI and under
`local-ci-stack.sh` — the URL is exported into the spec's environment and
inherited by `env`, which is why this works there. `e2e/20` has the same
property.

### The browser now signs in with the cookie (Tier 401)

Phase 2 of the §9 item 10 plan. Tier 400 gave the backend sessions; the browser
still logged in by header, so the hole was *closable*, not closed.

**Three of the four routes that finish a login minted nothing.** Tier 400 only
did `/auth/login`, and I had not checked the others — measured here:

| Route | Who reaches it | Before Tier 401 |
|---|---|---|
| `/auth/2fa/verify` | every user with 2FA on | no session — `/auth/login` returns `twoFactorRequired` and stops *before* the minting branch |
| `/auth/register` | every new company | no session, yet the page writes the ids and redirects to /dashboard |
| `/invitations/accept` | every invited member | same |

With `ALLOW_HEADER_AUTH=0` each of those users would have finished signing in
and then been unable to use the app at all. All four now go through one
`UserSessionService.issue()`. The 2FA case also carries a real guarantee worth
pinning: a correct password alone still mints nothing — the session appears
only after the code is verified (`e2e/24`, 4 new assertions).

Frontend:

- `src/lib/auth.ts` (new) is the only place that starts or ends a session.
  `storeSession()` stores the ids (still needed to show who is signed in and to
  select the Mandant) and records **only the boolean fact** that a session
  exists — the token is deliberately not stored, since putting a bearer token in
  localStorage would recreate exactly the stealable credential this removes.
- `apiFetch` sends `credentials: "include"` and, once a session exists,
  **stops sending `x-user-id` entirely**. The fallback stays for the e2e suites,
  which seed ids without ever logging in.
- The four login pages funnel through `storeSession()`. Each of their `fetch`
  calls needed `credentials: "include"` as well: without it the browser
  **discards the Set-Cookie** on a cross-origin response (:3100 → :3001), so the
  session would exist server-side and never reach the browser.
- The Next middleware gates on `de_session` (it is httpOnly against JavaScript,
  not against the server) and still accepts the mirrored legacy cookie for the
  specs.
- **"Abmelden" was `localStorage.clear()` in five places.** With sessions that
  would leave the credential valid for its full 30 days in whoever's hands had
  the cookie. All five now call `signOut()`, which revokes server-side first.

Spec: `frontend/e2e/session-cookie-tier401.spec.ts` drives the real login form
(no injected auth — the point is what the *browser* does): the cookie is
httpOnly and unreadable from the page and never mirrored into storage; after
login **no** request to `/api/v1/` carries `x-user-id`; the dashboard still
works after deleting `userId` from localStorage, which is the proof that only
the cookie is authenticating; and Abmelden makes the token 401 afterwards. All
four fail against the old frontend (verified with the source stashed).

One measurement that is *not* a Tier 401 finding but was made here: on this
developer machine `50-webhooks.sh` failed its Tier 391 DNS-rebinding assertion
(`http://127.0.0.1.nip.io/` → expected 400, got 201). Both `nip.io` and
`sslip.io` answered "has no A record" while `google.com` resolved fine — this
network's resolver strips private-IP answers — so `assertHostResolvesPublic`
took its lenient `allowUnresolved` path. The spec fails identically against
pre-Tier-401 code, and CI (whose resolver does answer) is green. The assertion
depends on a third-party wildcard DNS service; making it network-independent is
filed as its own task.

**What is still open in §9 item 10:** the ~169 Playwright specs seed
`x-user-id` directly, so CI must keep `ALLOW_HEADER_AUTH` on — phase 3 (setting
it to 0 in `infra/prod/.env`) is safe for production but cannot be verified by
the suite until those helpers mint real sessions. The measured browser path is
now cookie-only either way.

### `x-user-id` was the credential; login now mints a session (Tier 400)

The single largest hole in §9, and the reason 2FA (Tier 386) protected nothing:
the guard took `x-user-id`, looked the user up, checked `UserCompany` for
`x-company-id` and let the request through. **Knowing a user's UUID was being
that user** — and UUIDs are not secrets: they travel in invitation flows, in
audit exports, in Berater hand-offs. Nothing could be revoked, nothing expired,
and the password check protected only the login response itself. Measured on the
old code: `POST /auth/login` returned no cookie and no token, a request carrying
only a cookie or `Authorization: Bearer` got 401, and `POST /auth/logout` was a
404 — there was no credential to steal, only an id to guess.

Phase 1 of the Tier 399 plan, with the operator's two decisions: **server-side
sessions**, **30 days, sliding**.

- `UserSession` (63rd model), shaped like the `CustomerPortalSession` that has
  carried the portal since Tier 130: token `@unique`, `expiresAt`, `lastSeenAt`,
  `revokedAt`, plus `ipAddress` / `userAgent` for the record.
- `auth/user-session.service.ts`: `create` (32 random bytes, hex),
  `resolve` (unknown / revoked / expired → null, otherwise slides `expiresAt`
  **at most hourly** so this is one write per session per hour, not one per
  request), `revoke`, and the `Set-Cookie` builders — `HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Secure` only when `NODE_ENV=production`. The token is read from the
  cookie header (parsed by hand — no `cookie-parser` dependency for one cookie)
  or from `Authorization: Bearer`, which is what lets scripts and the e2e suites
  authenticate without a cookie jar.
- `POST /auth/login` mints the session, sets the cookie and also returns
  `sessionToken` / `sessionExpiresAt`. New `POST /auth/logout` revokes and clears
  the cookie; it is `@Public()` on purpose — an expired session must still be
  able to log out instead of getting a 401 it cannot clear.
- Both guards resolve **session first, legacy header second**, and the header
  path is behind `legacyHeaderAuthAllowed()` (`ALLOW_HEADER_AUTH !== '0'`). A
  present-but-invalid session is a 401 and never falls back to the header.
- The guard also fills the Tier 384 audit context (`getRequestContext()`) with
  `userId` / `companyId` after it resolves them. The context is created by an
  Express middleware that runs **before** guards, so under cookie auth it would
  otherwise have had no user to record — the store is a mutable object, so the
  guard writing into it is visible to the audit extension.

`x-company-id` is unchanged: it was never the credential, it selects the active
Mandant and is still validated against `UserCompany`, so the Berater switching
flow is untouched.

Three things worth keeping:

- **The DI failure is informative.** `HeaderAuthGuard` is constructed in many
  modules, so adding a constructor argument produced "Nest can't resolve
  dependencies of the HeaderAuthGuard (PrismaService, Reflector, ?) … in the
  StorageModule". A `@Global()` `UserSessionModule` is the right answer for a
  dependency of a guard that is wired in everywhere.
- **The flag was measured, not assumed.** With `ALLOW_HEADER_AUTH=0` — what
  production will run — a legacy-header request is `401
  Authentifizierung erforderlich (keine gültige Sitzung)` while the cookie and
  the Bearer token both answer 200.
- Audit attribution was checked under cookie-only auth: `customer.created` and
  `customer.updated` carry the session's user and company.

`e2e/176-tier375-auth-default-deny.sh` also needed one line: it keeps a reviewed
list of every `@Public()` route and went red on `POST auth/logout` — which is
exactly what that list is for, so the route was added deliberately rather than
the check loosened.

Spec: `e2e/190-tier400-session-auth.sh` — the cookie's flags and 30-day Max-Age,
that the cookie and the Bearer token authenticate with no `x-user-id` anywhere,
that an unknown token is refused and does **not** fall back to the header, that a
session cannot claim another Mandant, audit attribution, logout revoking one
session but not the user's other one, and an expired session being refused. The
`ALLOW_HEADER_AUTH=0` behaviour is asserted statically, the way the `@Throttle`
limits are (the stack runs with the flag on so the other ~300 specs keep
passing).

**Still to do (phases 2-3 of the plan, §9 item 10):** the frontend still logs in
with headers — `authHeaders()` must stop sending `x-user-id`, `apiFetch` needs
`credentials: 'include'`, and the Next middleware must gate on the httpOnly
cookie; that is what forces `ALLOW_HEADER_AUTH=0` in `infra/prod/.env` to be
safe, and it touches the `injectAuth` / `setupAuth` helpers of ~169 Playwright
specs.

### The last unbounded bodies: portal profile, note and invoice templates (Tier 398)

Three bodies were still inline types. Measured, all stored verbatim:

| Route | Input | Before |
|---|---|---|
| `PATCH /customer-portal/profile` (token auth — the customer) | name × 100 000, vatId × 5 000, address.street × 50 000 | 200, all stored |
| `POST /note-templates` | label × 50 000, text × 500 000, `sortOrder: -5` | 201, all stored |
| `POST /invoice-templates` | name × 50 000, `templateType: "bogus-type"`, configJson 500 KB | 201, all stored |

The portal one matters most: it is the only externally driven write in the app —
the actor is the customer holding a portal token, not a company user — and that
name is printed on their invoices and travels into the DATEV / GoBD exports.
The service did check that `name` is non-empty and that the e-mail parses, so
this was purely about bounds.

- `dto/update-profile.dto.ts`: name and vatId reuse the Tier 397 constants
  (200 / 20), contact and address are nested DTOs with per-field limits and the
  e-mail check; the objects stay partial, so the service's merge is unchanged.
- `dto/note-template.dto.ts`: label ≤ 200, text ≤ 5000, sortOrder an integer
  0…9999, plus a bounded preview DTO.
- `dto/invoice-template.dto.ts`: name ≤ 200, `templateType` restricted to
  standard|simplified|compact|custom (the four the service actually renders).
  `configJson` stays free-form — `validateConfig` checked the known keys but
  ignored unknown ones, so it now bounds the serialised size at 20 KB, the same
  approach as the Tier 392 error context.

Three self-inflicted problems, the third only caught by CI — all worth recording:

- The note-template DTO first emitted German "erforderlich" messages, but
  `e2e/157` pins the service's existing English "label is required" /
  "text is required". The DTO now emits those exact strings — a DTO that
  replaces hand-rolled checks has to keep their message contract.
- The portal section was first appended at the very end of `e2e/148`, i.e.
  **after** that spec's own "Step 8: cleanup", so the final positive assertion
  got 401 on a revoked session. Moved ahead of the cleanup step.

- **CI caught the third: `portal-profile-tier155.spec.ts` went red.** It asserts
  `expect(data.message).toMatch(/ungültige e-mail/i)` — a *string*. Adding
  `@IsEmail` to the portal DTO made the ValidationPipe answer first, so
  `message` became an array `["contact.Ungültige E-Mail-Adresse"]` and
  `toMatch` threw `TypeError`. The DTO now bounds only the length of
  `contact.email`; the format stays the service's check, which still throws the
  plain-string German message the spec pins. Same lesson as the note-template
  one, in a spec my local selection did not include — I had run `portal.spec.ts`
  and `portal-link-tier132.spec.ts` but not `portal-profile-tier155.spec.ts`.

**Lesson: pick the specs to re-run by grepping for the route, not by name.**
`grep -rln "customer-portal/profile" frontend/e2e` names the spec in one second;
guessing from spec names missed it. For a change that touches a shared route,
run the full Playwright suite locally before pushing — the last two pushes each
had something a full local run would have caught (Tier 396's hidden skip, and
this).

Specs: `148` (portal, 5 assertions), `157` (note templates, 3) and `33`
(invoice templates, 4), each also asserting that the real page shape still
saves. 8 of them fail against the old code.

Verified locally: full backend **189 passed / 0 failed** of 189 specs, zero 500s
in the captured log; Playwright portal, portal-link-tier132,
note-templates-tier156, note-templates-page-tier233, settings-vat-mode-tier176:
26 passed.

### Bulk import bypassed the interactive rules; the VIES budget was the client's (Tier 397)

The three importers (`customers` / `products` / `expenses`) already cap the file
at 5000 rows, and the product importer validates each row (a negative price is
refused). Two gaps remained, both in the customer path:

| Input | Before |
|---|---|
| a row with `name` × 100 000 chars | imported verbatim — the row is stored with a 100 000-character name |
| a row with `email: "nicht-eine-email"` | imported verbatim, though `POST /customers` refuses it (`@IsEmail`) |
| `maxVatVerifications: 5000` | used as-is: 50 rows with a VAT id were **all** verified, though the intended cap is 10 |

The VIES one is the amplification: `MAX_VERIFICATIONS = opts.maxVatVerifications
?? 10` took the client's number, so a 5000-row file could fire 5000 synchronous
VIES calls in one request — the code's own comment notes each can take ~8s and
that 10 is chosen to leave the shared token bucket for interactive
"Jetzt prüfen" clicks. VIES is an external EU service; exhausting its limit
affects the whole deployment.

Fix:
- the budget is clamped to 0…50 server-side (a non-finite value falls back to
  the default 10), so the client can lower it but not raise it past the ceiling;
- `importBulk` now applies the rules the interactive route already had —
  name ≤ 200, e-mail format, vatId ≤ 20 — and reports each violation **per row**
  like every other import check, so one bad line does not fail the file;
- `CreateCustomerDto` gained the matching `@MaxLength` on `name` and `vatId`:
  the 100 000-character name was accepted on the interactive route too, so this
  was a missing bound rather than only an import bypass. The constants live in
  `customer.service.ts` and are shared by both paths.

Not changed: the product and expense importers already validate their rows, and
all three keep the 5000-row cap.

Spec: `e2e/19-bulk-import.sh` gained a Tier 397 section (8 assertions) — a file
with one over-long name and one bad e-mail imports only its good row and reports
both per row, nothing over-long reaches the table, `POST /customers` refuses the
long name, and the VIES budget comes back clamped to 50 when the client asks for
5000. All 6 of the assertions that exercise the old paths fail against it.

Verified locally: full backend **189 passed / 0 failed** of 189 specs, zero 500s
in the captured log; Playwright customers-import, vies-verify-tier128,
vies-batch-tier134, customer-detail-page-tier232, supplier-vies-batch-tier137:
16 passed.

### An omitted companyId dropped the tenant filter (Tier 395)

`HeaderAuthGuard` binds a `companyId` in the body/query to the authenticated
company **only when it is present** (Tier 375). Where a handler passed that
optional value straight into a Prisma `where`, leaving it out made the filter
`undefined` — which Prisma drops, so the lookup matched every company.

`POST /customer-portal/admin/create-session` did exactly that. Measured, tenant
B against company A's customer id:

| Body | Result |
|---|---|
| `{customerId: A's, companyId: A's}` | 403 — the guard catches it |
| `{customerId: A's, companyId: B's}` | 400 "Kunde nicht gefunden" |
| `{customerId: A's}` — **companyId omitted** | **201 with a working portal token + URL for A's customer**, that customer's e-mail address in the response, and the portal login mail sent to them |

The portal shows a customer their invoices, so that token is cross-tenant data
access, not just an id leak. The lookup now takes the company from the
guard-validated `x-company-id` header and never from the body; the UI keeps
sending `companyId` and is unaffected.

`GET /system/errors/timeline` had the same shape (`if (companyId) where.companyId
= companyId` on an optional query param): without it, the timeline counted every
tenant's errors. It now derives the company from the caller like its sibling
`GET /system/errors` does, so both halves of the dashboard agree. (Both use
`req.user.companyId` — the user's *home* company, not the active Mandant; for a
Berater switched to another Mandant that is the pre-existing behaviour of the
errors list and was not changed here.)

A scan of every `companyId: <request expression>` inside a Prisma `where` found
no other instance: the remaining optional-`companyId` routes either fall back to
a guard-checked query value (`ocr/match-supplier`), throw when it is missing, or
ignore it (the dev-only assets test trigger).

Checked and found already correct, so not changed: `PUT /companies/:id/datev-config`
validates everything (account numbers 3-5 digits via `sanitizeDatevConfig`,
Berater/Mandanten-Nr `^\d{1,5}$`, opening-balance entries filtered by konto /
shVz / positive betrag with the text truncated to 60, `laufNr` keys 4-digit years
with positive integer values) — its doc comment claiming the fields are
"round-tripped verbatim; the client validates" is stale. Only the
`openingBalances` array length is uncapped. `PATCH /companies/:id/feature-flags`
type-checks each of its seven booleans explicitly.

Spec: `e2e/179-tier378-cross-tenant-ids.sh` §4b — B minting a portal session for
A's customer without a companyId is 400 with no token, the guard still refuses
the explicit foreign companyId, and B's error timeline counts none of A's
errors. 3 of the 4 fail against the old code.

Verified locally: full backend **189 passed / 0 failed** of 189 specs, zero 500s
in the captured log; Playwright portal, portal-link-tier132,
system-errors-timeline-tier200, customer-detail-page-tier232: 17 passed.

### e2e 92 skipped on ambient data (Tier 396)

Tier 395's CI run was green at **187 passed / 0 failed / 2 skipped** where every
run since Tier 383 had been 188 / 0 / 1 — a green run hiding one more skip, the
Tier 381 lesson. The new skip was `92-tier65-ratenplan-suggestion.sh`: "no
high-amount (>= 500 EUR) sent invoice for the test customer".

Cause, not a product regression: the spec picked an arbitrary customer
(`SELECT id FROM "Customer" ... LIMIT 1`, no ORDER BY) and then *required* that
customer to happen to own both a >= 500 EUR and a < 500 EUR sent invoice,
`skip_if`-ing when it did not. The specs added in Tiers 388-395 create and
delete customers in the seed company, which changes which row an unordered
LIMIT 1 returns. Its own comment already admitted the fragility ("data-dependent
— the dev DB state has drifted over time").

The spec now creates exactly what it needs — its own customer plus a 1000 EUR
and a 100 EUR invoice, both set to `sent` — and deletes them in its cleanup. The
`skip_if` is gone, so it can no longer skip on ambient data. Full backend is
back to **189 passed / 0 failed / 0 skipped** locally (188/0/1 in the CI backend
job, where 16-dark-mode skips for want of a frontend).

**Lesson (again, and now with a second instance): compare the counts, not the
verdict.** Tier 381 was a Playwright skip; this one was a backend skip that
appeared only in CI. A spec that selects its fixtures with an unordered
`LIMIT 1` over shared seed data will eventually pick a different row — specs
should create the fixtures they assert on.

### Invoice e-mail: the CC fields were unbounded and unchecked (Tier 394)

`POST /invoices/:id/send-email` and `/invoices/bulk-send-email` took inline
types. The recipient (`overrideTo`) was already validated —
`InvoiceEmailService` throws "Ungültige Empfänger-E-Mail" — but the CC fields
were only `trim()`ed. Measured:

| Input | Before |
|---|---|
| `extraCc` with 200 addresses | 201, and **all 200 reached the mailer** (verified in the `[NO-SMTP]` log line) — every one receives the customer's invoice PDF, sent through the company's own SMTP account |
| `ccEmail: "total-garbage-not-email"` | 201 |
| `ccEmail: "a@b.test\r\nBcc: victim@evil.test"` (raw CRLF) | 201 |
| `overrideSubject` × 20 000 chars | 201 |
| `language: "kl"` | 201 |

`dto/send-invoice-email.dto.ts`: `overrideTo` / `ccEmail` must be e-mail
addresses, `extraCc` is an array of addresses capped at **10** (the UI's CC box
is a comma-separated field a person types), `overrideSubject` ≤ 300,
`overrideBody` ≤ 20000, `language` de|en|zh, `salutation` ≤ 200. The bulk body
gets the same fields plus `concurrency` 1…10 (the handler clamped it silently)
and `invoiceIds` elements ≤ 64 chars — the **count** stays the handler's check so
its German "Maximal 100 Rechnungen pro Anfrage" is still what the caller sees.

Already correct and left alone: the bulk handlers cap at 100 invoices,
`bulk-send-by-filter` requires a date range and caps at 100 rows, both are
throttled 15/5 min, and `createdById` is bound to the caller by HeaderAuthGuard
(Tier 383).

`overrideTo` pointing at an unrelated address is **by design** (send the invoice
to the customer's accounting department) and is recorded on the EmailSend row —
not changed.

Spec: `e2e/17-email-send.sh` gained a Tier 394 section (8 assertions); the
invoice-page shape (ccEmail + 2 extraCc) still sends. 7 fail against the old
code.

Verified locally: full backend **189 passed / 0 failed** of 189 specs, zero 500s
in the captured log; Playwright bulk-send, bulk-send-by-filter-tier141,
recurring-email-tier129, recurring-email-preview-tier136,
customer-email-history-tier144: 20 passed.

### Bank-import book-expense wrote before it validated (Tier 393)

The three bank-import money routes took single `@Body('x')` params, which the
global ValidationPipe cannot check. Measured on a real 150 € debit transaction:

| Input | Before | Now |
|---|---|---|
| `expenseAccountNumber: "NICHT-EXISTENT-9999"` | **201** — an Account with that number ("Sonstige betriebliche Aufwendungen", type expense) was created in the chart of accounts and booked against | 400, chart unchanged |
| `expenseAccountNumber: "1200"` (the bank account) | 201 — the expense line was debited to the bank account | 400 "Konto 1200 ist kein Aufwandskonto" |
| another company's `expenseId` | **404 — but the voucher was already written** (tagged `[expense:<foreign id>]`, `referenceType: 'Expense'`) and the transaction marked booked, so it could never be booked again | 404, no voucher, transaction still bookable |
| `vatAmount: 999` on 150 € | 400 "Soll und Haben müssen ausgeglichen sein" from inside the voucher service | 400 naming vatAmount and the booking amount |

The account one matters because the UI field is a raw `prompt()` defaulting to
"4900" — any typo permanently entered the company's Kontenrahmen and flowed on
into DATEV export, BWA, GuV and Bilanz.

The `expenseId` one is the GoBD-relevant defect: ownership was checked only by
the `expense.update({where:{id, companyId}})` at the very end, after
`voucherService.create` and the transaction link, and outside any transaction —
so an error response left a permanent booking behind.

Fix (`dto/book-expense.dto.ts` + the service):
- everything the caller supplies is validated **before the first write**:
  `expenseId` and `supplierId` must belong to the company (404);
- `expenseAccountNumber` must look like an account number (3-8 digits), so an
  unknown but plausible SKR number is still auto-created on first use — the
  intended convenience — while nonsense is refused; and if the number already
  names an account of another type the booking is refused;
- `vatAmount` ≤ the booking amount, `vatRate` 0…1, `description` ≤ 500;
- `autoConfirmThreshold` 0…100 (the service already clamped it; it is now
  rejected rather than silently clamped), `invoiceId` required and bounded.

`supplierId` is accepted and validated but **still unused** by `bookExpense` —
it is declared in the opts type and never read (the vendor-bill path uses
`expenseId`). Left as-is; noted so it is not mistaken for a working field.

Also fixed: `system.filter.ts` built the body with a hard-coded
`statusCode: 500` while `res.status(status)` sent the mapped code, so every
Prisma P2025 answered **HTTP 404 with a body saying 500** (Tier 378 mapped the
status but not the body).

Spec: `e2e/08-bank-import.sh` gained a Tier 393 section — 12 assertions. It
reuses one transaction for every rejected booking, which only works because a
rejected booking no longer consumes it; the final "4900 still books" 201 proves
that. Against the old code 7 fail, and the cascade shows the bug: the junk
account booking succeeded, so every later call answered "bereits als Aufwand
gebucht".

Verified locally: full backend **189 passed / 0 failed** of 189 specs, zero 500s
in the captured log; Playwright fints-banking, webhooks, error-pages,
system-errors-timeline: 17 passed.

### The public error-capture route trusted the client (Tier 392)

`POST /system/errors` is `@Public()` (a crash on the login page must still be
recorded) and took `any`. Measured unauthenticated against the running backend:

| Request | Result |
|---|---|
| 5 posts with random `fingerprint` | 5 `ErrorEvent` rows — and a new row fires `pushErrorNotification`, so 5 operator alerts |
| `context: { pad: "A".repeat(2_000_000) }` | stored verbatim, 2 000 011 chars (JSON body limit 10 MB → ~10 MB/row) |
| post carrying an existing group's `fingerprint` | **that group's message and stack were rewritten** — "Echter Fehler: Zahlung fehlgeschlagen" became "Alles in Ordnung, bitte ignorieren", occurrences 1 → 2 |

The fingerprint decides which group a row joins, and `capture()` refreshes
`message`/`stack` on every hit — so an outsider could blank a real error out of
the operator's dashboard, mint unlimited groups, or bloat the table.

The frontend computed that fingerprint itself with a **32-bit** hash (its comment
claimed it mirrored the backend's SHA-256 — it did not), so unrelated real
errors could also collide and clobber each other's message with no attacker
involved.

Fix: `dto/capture-error.dto.ts` + the handler —
- the client's `fingerprint` is **not used**; the service derives it from
  source + message + first stack frame (what the frontend's hash approximated),
  so grouping is unchanged: same message twice → 1 row, occurrences 2 (verified);
- `context` is bounded to 4000 serialised chars, else stored as
  `{truncated, bytes, preview}` (2 MB → 555 chars, verified);
- `message` ≤ 4000, `stack` ≤ 8192, `url` ≤ 2048, `browser` ≤ 500,
  `kind` restricted to the stored `ErrorKind` union (any string was accepted
  before), `level` to error|warn|info|fatal;
- `@Throttle` 60/60s per IP on the route (the global default is 600/60s);
- the frontend no longer computes or sends a fingerprint.

`fingerprint` and `source` stay declared-but-ignored in the DTO so an
already-loaded browser tab (and Playwright tier205, which posts `source`) is not
refused by `forbidNonWhitelisted`; `message` stays optional so a body without one
still answers 200 `{ok:true}` — the deliberate "no noisy 400 in devtools"
behaviour e2e 21 test 14 pins.

`CaptureInput.fingerprint` is kept for the trusted internal caller
(`system.filter.ts` hashes the route name in so five routes throwing the same DB
error don't dedupe into one row).

Spec: `e2e/21-system-errors.sh` §15–19 — the server computes the fingerprint and
ignores the client's, an existing group is not rewritten by a posted
fingerprint, same-message dedupe still gives occurrences=2, an oversized context
is bounded and marked truncated, a 4001-char message and an unknown `kind` are
400, and a static check that the route carries a `@Throttle` (THROTTLE_DISABLED
in CI, so the limit itself cannot be exercised). Against the old code the
section fails at the first assertion (the client fingerprint was stored).

Verified locally: full backend **189 passed / 0 failed** of 189 specs, zero 500s
in the captured log; Playwright system-errors-timeline, error-rate-threshold,
top-fingerprint-rate, admin-notifications, error-pages: 36 passed.

### SSRF: webhook and FinTS URL guards had bypasses (Tier 391)

`POST /webhooks` and `POST /fints/connections` take a URL from the client (both
`company.update`) and the backend later fetches it. Each had its own ad-hoc
allow/deny check. Measured against the webhook guard (`isValidUrl`), all
accepted (201) though they reach loopback / internal:

| URL | old | now |
|---|---|---|
| `http://0.0.0.0/` | 201 | 400 |
| `http://[::1]/` | 201 | 400 |
| `http://[::ffff:127.0.0.1]/` | 201 | 400 |
| `http://user:pass@127.0.0.1/` | 400 (parse) | 400 (explicit) |
| `http://127.0.0.1.nip.io/` (DNS → 127.0.0.1) | 201 | 400 |
| `http://127.0.0.1/`, `http://2130706433/` (Node normalizes to 127.0.0.1) | 400 | 400 |

Node's WHATWG URL parser already normalizes decimal/octal/hex IPv4
(`http://2130706433` → hostname `127.0.0.1`), so those were already caught; the
gaps were `0.0.0.0`, every IPv6 form, IPv4-mapped IPv6, URL credentials, and any
DNS name. The webhook delivery also followed redirects (a public host could
302 into the internal network) and stores up to 4000 chars of the response body,
shown in the deliveries drawer — so a successful SSRF exfiltrates.

Fix: one shared guard `src/common/ssrf-guard.ts`:
- `isPrivateAddress(ip)` — an IP-family-aware classifier (loopback, `0.0.0.0/8`,
  RFC1918, `169.254/16` incl. cloud metadata, CGNAT `100.64/10`, IPv6 `::`,
  `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6). Unit-checked against
  15 private + 9 public addresses.
- `assertPublicHttpUrl(raw, {requireHttps,label})` — protocol (http(s), or
  https-only for FinTS), no URL credentials, reserved private-use TLDs
  (`localhost`, `.local`, `.internal`), and the IP-literal range check.
- `assertHostResolvesPublic(host, label, {allowUnresolved})` — resolves DNS and
  rejects a private result. `webhook.create` calls it lenient (a name that
  resolves private → 400 now; one that does not resolve here is left to
  delivery, so a prod-only or transient name is not blocked). `postJson`
  (delivery) calls it strict and sets `redirect: 'error'`, so a name that was
  public at create but resolves private at delivery (rebinding) is still caught
  and no redirect is followed.

Both `webhook.service.ts` (`isValidUrl` deleted) and `fints.controller.ts`
(inline block deleted) now use it; FinTS requires HTTPS as before.

**Residual (documented, not fixed):** delivery re-resolves and then `fetch`
resolves again — a sub-second DNS-rebinding window between the two remains. A
full fix pins the resolved IP into the connection (custom undici dispatcher);
not done — the re-resolve + no-redirects closes the practical exfil path for an
authenticated-but-malicious company admin, the only actor who can reach these
routes.

Spec: extended `e2e/50-webhooks.sh`'s existing SSRF section (§10b) with the five
bypasses above — 0.0.0.0, `[::1]`, `::ffff:127.0.0.1`, credentials, and the
nip.io DNS name → all 400; the public `https://example.com` / `httpbin.org`
cases still 201. The existing `e2e/39-ssrf-guard.sh` (the FinTS endpointUrl
guard, incl. its `.internal` case) still passes unchanged — the shared guard
keeps the `.local`/`.internal` block the old FinTS code had. The delivery-time
redirect / rebinding guards are code- and unit-verified, not e2e-reproduced
(needs a controllable public redirector).

Verified locally: full backend **189 passed / 0 failed** of 189 specs, zero 500s
in the captured log; Playwright webhooks, webhook-dead-letter, -deliveries-csv,
-event-type-filter, -last-success, fints-banking: 34 passed. (In the CI backend
job 16-dark-mode skips, no frontend → 188/0/1.)

**Not changed:** the webhook create body is still an inline type (name/events
length unbounded) — the same low-severity class as the Tier 388 `@IsString`
note.

**Seen in passing, not changed:** `POST /auth/2fa/verify` is `@Public()` and
takes only `email` + a TOTP or recovery code — no password, no attempt limit
beyond the global throttler. With header auth (§9 item 10) knowing a user id
already is a login, so 2FA cannot protect anything yet; it belongs to the
auth replacement.

### Notes from Tiers 347–352 (recovered in Tier 364)

Tier 353 wrote a new version of this file but left the previous one appended
below it, so from Tier 353 to 363 the file held two copies, and everything
written in Tiers 347–352 existed only in the lower one. It is restored here
as written then. Several points are superseded: `frontend-lint` (Tier 349) and
backend eslint (Tiers 355–356) exist, specs honour `PG_CONTAINER` (Tier 353),
and `backend/scripts/local-ci-stack.sh` reproduces both CI suites (Tiers
357–358). The ci-seed `ON_ERROR_STOP` faults and the webhook "pending" lesson
still apply.

**Local Playwright runs are limited by the dead dev container.** Many specs
hardcode `docker exec de-invoice-postgres`, so with that container down
(and a throwaway one under a different name) their `beforeAll` throws and
they fail locally for environment reasons, not code reasons — seen in Tiers
350, 351 and 352. Specs without that dependency (installment-plan,
list-pages-2, recurring-invoices) do run locally. Two ways out: have the
user run `scripts/fix-dev-pg.sh` (needs sudo), or teach those specs to
honour a `PG_CONTAINER` env var the way `ci-seed.sh` already does. The
latter is a decent standalone tier.



**The webhook dead-letter "cron race" was never a cron race** (Tier 350).
Four skips and one persistent flake in `webhook-dead-letter-tier198` were
blamed, in three separate in-file comments, on the retry cron or on "requeue
from test 2". Both diagnoses were wrong:

- the cron selects `status='failed' AND nextRetryAt <= now()`
  (`webhook.service.ts:420`), so it can never touch an `'exhausted'` row;
- `seedTag` / `deliveryId` are scoped **inside** each `describe`, so the two
  blocks never shared a delivery row.

The real cause: a delivery row is INSERTed `status='pending'`
(`webhook.service.ts:338`) while the POST to the receiver is still in
flight, and the service UPDATEs that same row with the final status when the
response lands (`:792`, or `:815` on network error/timeout). Both
`beforeAll`s polled only for the row to **exist**, so they broke on the
pending row and applied the seed UPDATE into a window where the delivery
write-back was still coming — and it overwrote `'exhausted'`.

Measured on an isolated stack: row appears `pending` at t=0.14s, flips
terminal at t=0.54s. A/B run of the two loops, 3 attempts each: old logic
lost the seed 3/3, new logic kept it 3/3.

Fix: poll until `status !== 'pending'`, then seed. Budget is 80 x 250ms =
**20s on purpose** — the delivery HTTP timeout is 10s (`:848`), the catch
branch still writes a terminal status, so the row always leaves `pending`,
but only just after 10s; a 10s budget would race exactly that write.

**Lesson: "pending" is transient but not instant.** Any spec that seeds over
a row the backend is still writing must wait for a terminal state first, not
for the row to appear.

**Lint: 0 errors, 0 warnings, and now enforced.** Tier 349 cleared the
38 errors + 42 warnings that had accumulated in `frontend/e2e/` and added a
**`frontend-lint` CI job** running `npx eslint . --max-warnings 0`. The
`--max-warnings 0` is the part that matters: `eslint` exits non-zero on
errors only, so without it warnings drift back exactly as before.

Three config decisions in `frontend/eslint.config.mjs`, each for a genuine
idiom rather than to silence a real finding:
- `no-empty: ["error", { allowEmptyCatch: true }]` — all 29 empty blocks
  were catch blocks, every one deliberate: `try { data = await res.json() }
  catch {}` (a non-JSON body means `data` stays null — that IS the handling)
  and `try { unlinkSync(tmp) } catch {}` in a `finally` (cleanup must not
  mask the real assertion failure). Empty **non**-catch blocks stay errors.
- `ignoreRestSiblings: true` — `const { selfHash, ...rest } = manifest` is
  the omit-a-key idiom; `selfHash` is destructured precisely so it is not in
  `rest`.
- `varsIgnorePattern: "^_"` — matches the `argsIgnorePattern` already there.

The other 40-odd were real dead code: unused imports, a `cleanupByBlz` stub
that only `return null`ed and was never called, consts like `API_BASE` /
`COMPANY_ID` / `CUSTOMER_ID` that nothing read, and unused Playwright
fixture params (removing an unused `{ page }` also stops Playwright
instantiating a browser page for that test). Note when deleting an unused
fixture param that it may be the only one — `async ({}) =>` then trips
`no-empty-pattern`; drop the whole parameter, `async () =>`.

**Backend has no eslint at all** — no config, no devDependency, no script —
so `frontend-lint` covers `frontend/` only. Adding lint to the backend is a
separate decision, deliberately not smuggled into this job.

**Tier 347 closed the seed gap and 10 more skips.** The fixture customer
`f84ebd20-...` + 1 paid invoice + 1 payment now live in `ci-seed.sh`
(section 5g). Seeded by direct SQL on purpose: it sidesteps the Tier 174
P2002 invoice-sequence race that made the specs hard-code the UUID in the
first place. 35 -> 8 "masking" skips remain (webhook dead-letter cron race,
installment-plan, ratensplan, cost-center, vies-batch, invoice-create).

**Tier 347 also found `ci-seed.sh` had been silently failing for months.**
`psql_test()` was a bare `psql`: on error psql prints to stderr, CONTINUES
to the next statement, and still exits 0 — so a broken INSERT was skipped
and the `ok "... seeded"` line right below printed a green checkmark. Four
statements had been dead this whole way:

| Statement | Fault | Fix |
|---|---|---|
| `RecurringInvoiceItem` | column `sortOrder` | -> `position` (the exact Tier 343 bug — fixed in the spec then, missed here) |
| `Invoice` x2 | `date` / `totalNet` / `totalGross` | -> `issueDate` / `subtotal` / `total` |
| `CashBookClose` | table does not exist (model is `CashBookDailyClose`, entirely different columns) | deleted — the row was referenced nowhere, and `cashbook-signature-tier194.spec.ts` closes its own days via the API |

Turning on ON_ERROR_STOP immediately exposed a **fifth** dead statement that
a column audit cannot catch — an FK violation: `VoucherLine.accountId`
pointed at `d8833d31-...` and `92b7d7a0-...`, account ids that exist in no
seed path. Default accounts are created through the API
(`seedDefaultAccounts()` -> 1000/1200/1400/1600/1800/2000/2200/2800/4200/
4300/4400/4980/6000/8000) with **backend-generated UUIDs**, so any
hard-coded account id in this file is guaranteed wrong on a fresh DB. Fixed
by creating 4960 (absent from the defaults) and referencing all three
account ids by `(SELECT id FROM "Account" WHERE "companyId" = ... AND
"accountNumber" = ...)`. Run the FK audit too, not just the column audit:
collect every id created by an INSERT, then check each `*Id` value against
that set (`AuditLog.entityId` is a plain String, not a relation — expect it
as a false positive).

And a sixth: **backticks inside an unquoted heredoc are command
substitution.** These blocks are `<<SQL`, not `<<'SQL'`, because they must
expand `$COMPANY_ID` — so two SQL *comments* were being executed on every
seed run. One became a redirect from a file named `=`, the other tried to
run a non-ASCII char as a command. The second was, verbatim, the comment
warning about the first. `set -e` does not catch these: the failure happens
inside command substitution during heredoc expansion. Never use backticks
in a comment inside an unquoted heredoc.

`psql_test` now passes `-v ON_ERROR_STOP=1`, so this class fails loudly.
Verify seed changes locally before pushing: a throwaway `postgres:16`
container + `prisma db push` + the backend started the way CI starts it
(`VIES_MOCK=1 EXCHANGE_RATES_MOCK=1 THROTTLE_DISABLED=1 npx ts-node
src/main.ts`), then `PG_CONTAINER=<name> bash backend/e2e/ci-seed.sh`
twice — the second run proves idempotency. Expect exit 0 and **empty
stderr**.
**Before adding SQL to `ci-seed.sh`, run the column audit** (parse
`schema.prisma` models, diff against every `INSERT INTO "X" (cols)`) — it is
what surfaced all four, and lesson 10 only catches it if you actually run it.

~~**No lint job in CI.**~~ **Obsolete — corrected in Tier 368.** CI has had six
jobs for some time, `backend-lint` (`ci.yml:98`) and `frontend-lint`
(`ci.yml:118`) among them, and both ran green in run 34684152720. The claim
below was also self-contradictory: §5 has listed 6 jobs all along. What
remains true is the history — an unused-import warning once drifted into
`customer-detail-invoices-chip-tier243.spec.ts` while no lint job existed
(removed in Tier 347); the lint jobs are what stop that recurring.

### Operational issues (updated Tier 364)
- ~~`tmp-pw-fail/` untracked~~ — gitignored since Tier 344.
- ~~No `timeout-minutes` on CI jobs~~ — added in Tier 364.
- **No `needs:`** between jobs — e2e and playwright each re-run the seed.
  Sharing it via artifact would save ~30 s; not done.
- ~~GitHub Actions blocked by account billing~~ — resolved 2026-09-11 (§1).

## 9. External blockers (user must provide / decide)

These are **not in the repo** — only the user can do them:

1. ~~**GitHub account billing / spending limit**~~ — fixed 2026-09-11; CI ran
   green again for `843f9bf`. Keep an eye on the spending limit.
2. **Repository variable `NEXT_PUBLIC_API_URL`** (the public site URL) before
   pushing any `v*` tag — `release.yml` builds the frontend image with it and
   fails on purpose without it (Tier 363).
3. **Revoke the old `ghp_` personal access token** that used to be in the git
   remote URL (github.com/settings/tokens). Corrected in Tier 367: the remote
   does **not** use SSH — `origin` is `https://github.com/saurojohn/de-invoice.git`
   with `credential.helper=osxkeychain`. The token is no longer *in the URL*
   (which was the leak), but an HTTPS remote authenticates from the macOS
   keychain, so the old PAT is most likely still stored there and still valid.
   Revoking it is therefore still worth doing; a push will then prompt for a
   fresh credential (or switch the remote to SSH).
4. **Dev database out of `/tmp/pgdata`.** The manually created
   `de-invoice-postgres` container bind-mounts `/tmp/pgdata`; macOS purges
   `/tmp`, and nightly backups have contained **no database since
   2026-09-06** (last full one: `backup-2026-09-05-224235`). Recreate it via
   `docker-compose.yml`'s named volume. Rotation no longer deletes the old
   full backups while dumps fail (Tier 360).
   **Update 2026-09-15 (Tier 380):** the Mac rebooted; `/tmp/pgdata` no longer
   exists (checked with `ls`). `de-invoice-postgres` had already been
   `Exited (1)` for 4 days. Nothing was touched — rebuilding the dev database
   (from `backup-2026-09-05-224235` or fresh) is the user's call.
5. **Decide whether to re-hash the existing audit chain.** Only for *historical*
   rows — since Tier 367 a healthy chain verifies with no re-hash at all, so
   this is no longer needed to make `/audit-logs/verify` return ok. Rows that
   cannot verify under the rules they were written with: pre-Tier-366 rows
   containing a Decimal, and Tier-366-era rows whose payload carried an
   undefined-valued key (`recurringinvoice.created`; see §8).
   `cd backend && npx ts-node scripts/audit-rehash.ts` recomputes every row's
   hash and pointer in `seq` order with the fixed canonicalisation — which means
   rewriting stored hashes on historical rows, so it stays a deliberate operator
   decision, ideally with a database backup first.
6. **Review every recurring template's "Rechnung an Kunden senden" setting.**
   Until Tier 365 unchecking it was not saved, so all templates are stored
   with `sendEmail = true` and generated invoices were e-mailed regardless.
   Which ones were meant to be off cannot be recovered from the data:
   `SELECT id, name FROM "RecurringInvoice" ORDER BY name;` and re-save the
   ones that should not e-mail.
7. **Anlage AUS KapG rule** — `anlage-aus.service.ts` never recognises a
   legal name like "SH Leder GmbH"; a word match would also hit
   "GmbH & Co. KG" (§8, Tier 361). Needs a product decision.
8. **Hetzner VPS IP + SSH key** — for `infra/prod/HETZNER-DEPLOY.sh`
   (DNS A record, deploy). `sudo` only for `scripts/fix-dev-pg.sh`.
9. **Verify the ELSTER UStVA XML format against the official schema** (found
   Tier 371). `src/modules/reports/elster.service.ts` says its output is "ERiC
   Datenlieferungs-XML … following the official ERiC 32.x schema" and "one
   upload away from being filed". What it actually writes is a `<Datenlieferung>`
   whose amounts are text lines like `B-Kz081=…` inside `<Kennzahlen>`/`<Feld>`
   — it emits **no** `<Umsatzsteuervoranmeldung>`, `<DatenLieferant>` or
   `<KzNN>` elements. `e2e/49-elster-xml.sh` was written expecting exactly those
   elements, which (to my understanding) is closer to the official ELSTER UStVA
   layout — but I could not check the official XSD offline, so this is a strong
   suspicion, not a verified defect. There is no ERiC submission path in the code:
   users download the XML and upload it themselves, so a wrong format would
   surface as a rejected upload at ELSTER. Needs someone with the ERiC schema
   (or a test upload in Mein ELSTER's test mode) to decide which side is right
   before anyone changes the generator — it is a tax filing format.
   *Tier 417:* the **Kennzahlen** inside it are now verified against the
   BMF form models (USt 1 A / USt 2 A 2026) and corrected — the old ones were
   invented and put the Zahllast in Kz 81 (the 19 % base). What remains open
   is only the container format, and the files no longer claim to be an
   upload.
10. **Replace the header "authentication" before any real deployment**
    (**phases 1-2 done, Tiers 400-401** — the browser is cookie-only; what is
    left is phase 3, `ALLOW_HEADER_AUTH=0`, which CI cannot run until the
    Playwright helpers mint sessions) (found
    Tier 375). `HeaderAuthGuard` trusts the `x-user-id` / `x-company-id`
    request headers: it checks that the user exists, is active and has a
    `UserCompany` row — but nothing proves the caller *is* that user. No token,
    no session cookie, no signature; the frontend reads both ids from
    localStorage. Anyone who learns a user id and a company id (UUIDs; they
    appear in API responses, audit rows, the other tenant's data a user can
    see) can act as that user. `JWT_SECRET` is required by the deploy scripts
    and the Sept-6 security audit rated it "✅ 64-char", yet **nothing in
    `backend/src` reads it**. The guard's own comment says "header-based shim,
    not JWT". Also client-asserted: the Steuerberater read-only mode
    (`x-readonly` header — the client decides whether it is read-only).
    Tier 375 closed the two holes that needed no stolen id at all (unguarded
    routes, `?companyId=` of another tenant); this one needs a design decision:
    signed httpOnly session cookie (recommended: fits the same-origin nginx
    setup, no token in localStorage) or a JWT, plus migrating the frontend
    `api.ts`, the Playwright auth helper and the bash e2e `_lib.sh`. It changes
    login behaviour and every test harness, so it is not a side edit. Per §9
    item 8 the app is not deployed yet.
    **Measured plan (Tier 399) — read this before deciding.**

    *Today:* `x-user-id` **is** the credential. `HeaderAuthGuard` looks the id up,
    checks `UserCompany` for `x-company-id`, and lets the request through — so
    anyone who knows a user's UUID is that user. This is why 2FA cannot protect
    anything yet (Tier 386), why downloads needed the blob workaround (Tier 389)
    and why `x-readonly` needed a CORS entry (Tier 389).

    *Blast radius, counted:*

    | Surface | Files | Occurrences |
    |---|---|---|
    | backend source reading `x-user-id` | 16 (2 guards + 14 controllers) | — |
    | backend e2e specs | 140 (139 with direct `curl`, `_lib.sh` has only 5) | 712 |
    | Playwright specs | 169 | 425 |
    | frontend source | 24, but `apiFetch` funnels through **one** `authHeaders()` | — |

    The important consequence: **making production safe does not require touching
    the ~300 spec files.** Gate the legacy header path behind
    `ALLOW_HEADER_AUTH` — CI keeps it on, production turns it off.

    *Option A — server-side session + httpOnly cookie (recommended).* A
    `UserSession` table mirroring the existing `CustomerPortalSession`
    (token, expiresAt, lastSeenAt, revokedAt). `/auth/login` and
    `/auth/2fa/verify` create it and `Set-Cookie`; the guard resolves the cookie
    (or `Authorization: Bearer`) and falls back to the header only when
    `ALLOW_HEADER_AUTH=1`; `/auth/logout` revokes. Revocable, no key management,
    and it matches a pattern already in this codebase. `x-company-id` stays what
    it is today — a *selector* for the active Mandant, already validated against
    `UserCompany` — so the Berater switching flow is untouched.

    *Option B — JWT.* Stateless, no table, but revocation needs a denylist;
    worse fit for GoBD and for Berater access that must be withdrawable.

    *Option C — leave it.* Defensible only while nothing is deployed (§9 items 7-8
    are still open, so real exposure today is zero), but it keeps 2FA meaningless.

    *Migration that keeps 189 + 922 green:*
    1. ~~add sessions, guard accepts session **or** legacy header
       (`ALLOW_HEADER_AUTH=1` by default) — no spec changes;~~ **done, Tier 400**
       — `UserSession` + `auth/user-session.service.ts`, both guards resolve the
       cookie / Bearer token first, `POST /auth/logout` revokes, 30 days sliding.
       Spec `190-tier400-session-auth.sh`. Measured with `ALLOW_HEADER_AUTH=0`:
       the legacy header is 401, cookie and Bearer are 200.
    2. ~~frontend logs in to a cookie~~ **done, Tier 401** — `apiFetch` sends
       `credentials: 'include'` and stops sending `x-user-id` once a session
       exists, the four login routes all mint one (2FA verify, register and
       invitation accept minted *nothing* before), the middleware gates on
       `de_session`, and Abmelden revokes server-side. Spec
       `frontend/e2e/session-cookie-tier401.spec.ts` drives the real form and
       proves no request carries `x-user-id` any more. The ~169 Playwright
       specs still seed ids directly, which is why the flag stays on in CI;
    3. `ALLOW_HEADER_AUTH=0` in `infra/prod/.env`; the bash specs keep using
       headers, so the flag must stay on in CI — but since **Tier 402** CI does
       start the backend that way for one spec
       (`191-tier402-production-auth-mode.sh`, which restarts it with the flag
       off, measures, and restarts it back), so the production mode is no longer
       unverified. What remains is the deployment-side edit itself, which is
       blocked behind §9 items 7-8 (nothing is deployed yet).

    *Two details already checked, so the plan is not guesswork:*
    - **Cookies ignore ports.** Measured in Chromium: a `localhost` cookie set by
      the frontend on :3100 is in the jar for `http://localhost:3001` as well, so
      dev works with `credentials: 'include'` (CORS already sets
      `credentials: true`); behind nginx it is same-origin anyway.
    - **The audit context (Tier 384) is set in an Express middleware that runs
      before guards**, so it cannot read a session-resolved user. Fix without an
      extra query: start the AsyncLocalStorage with an empty mutable context in
      the middleware and let the guard fill in `userId` / `companyId` — the store
      is an object, so mutation inside the scope is visible to the audit
      extension.

11. **Decide who is a platform operator** (found Tier 378). Registration is
    public and every new user is `admin` of their own company, but several
    routes act on the *installation*, not a company, and only check a tenant
    role: `/admin/backups` (list, `run` a full pg_dump of all tenants, `verify`,
    `restore-drill`, `DELETE` a backup — `admin.read`, i.e. accountant rank),
    `/admin/cron-health` (status of every cron; `:name/run` triggers a cron for
    all tenants, e.g. reminder auto-send — `admin.update`), `/system/errors`
    prune / resolve-all / mute-all and `/system/notifications/*` (platform
    Slack/e-mail alert config and threshold — `users.read`). Measured as a
    freshly registered tenant: `GET /admin/backups`, `/admin/cron-health`,
    `/system/notifications/config` and `/threshold` → 200. Nothing was run or
    deleted in the probe. Needs a notion of platform admin — recommended: an
    env allowlist (`PLATFORM_ADMIN_EMAILS`) checked by a `@PlatformAdmin()`
    guard, set for the CI seed user and by the operator in `infra/prod/.env`.
    For a single-company installation the operator must set it, or those admin
    pages stop working — hence a decision, not a side edit.

12. **Audit rows written before Tier 384** (found Tier 384). Under concurrent
    requests the audit log stamped rows with another request's company and user,
    or none (§8 Tier 384). The rows are signed into per-company hash chains, so
    rewriting them breaks verification. Options: leave them and document the
    period; or add a correction record per affected row. Neither was done. Only
    relevant if a database with real users ran a build before Tier 384.

13. **May an explicit Mahnung override a Mahnungspause?** (found Tier 388)
    A pause (e.g. for an agreed Ratenplan, or a disputed invoice) stops only the
    daily cron. The invoice page's manual send and the bulk send still dun a
    paused customer or invoice — and since Tier 388 the manual send really
    e-mails. Options: refuse (400 "Mahnungspause aktiv"), or allow with a
    warning in the modal. Not changed.

14. **May a sent invoice be edited or deleted on its issue day?** (found
    Tier 406) Both `update` and `delete` check only that the issue date is
    today, not the status: a `sent` invoice can have its amounts changed or be
    removed until midnight, although the customer may already hold the PDF (the
    delete method's own comment says so). GoBD's position is that an issued
    invoice is corrected by a new document — Storno or credit note — not
    altered. Tier 406 closed the two unambiguous cases (an invoice with
    recorded payments can no longer be deleted; every deletion is now audited,
    and a sent invoice's number is never reused), but left this one: options
    are "drafts only" (the GoBD reading, a UX change for anyone who fixes a
    typo right after sending) or "same day, as now". The frontend shows
    Bearbeiten / Löschen on every invoice dated today. Also open under the same
    heading: editing an invoice that has payments.

15. **Should the AfA storno reverse bookings instead of deleting them?**
    (found Tier 408) `POST /assets/storno-afa` hard-deletes the year's booked
    depreciation expenses and re-books on the next run. Since Tier 408 every
    deleted booking is on the audit record with its amount and asset, so the
    history is recoverable — but the ledger itself no longer shows that the
    booking ever existed, which is not how a Storno normally works (a
    counter-booking that nets it to zero). Options: keep delete-and-rebook
    (simple, audited), or book negative counter-entries. Matters most once a
    year's figures have gone into a filed Anlage EÜR / E-Bilanz. Not changed.

16. ~~**The "KoSIT" XRechnung check does not run the EN 16931 rules — may I
    download them?**~~ (found Tier 410) **Resolved Tier 412** with your
    go-ahead: the CEN EN 16931 UBL schematron 1.3.16 runs as step 2 of
    `infra/kosit/scenarios.xml`, and the XRechnung generator was fixed until
    every invoice type passes it — see §8, Tier 412.

17. **Mahngebühren defaults** (found Tier 421). `getFeeConfig` defaults to
    5 € for the first Mahnung, 5 € for the second and 10 € for the final one,
    justified in code by a "post-2023 § 288 BGB reform (BGBl. I 2022 Nr. 51)"
    that supposedly allows charging for the first Mahnung. I could not verify
    that reform. The usual reading: the first reminder that puts the debtor in
    default is not chargeable (unless default already arose from a calendar
    due date, § 286 Abs. 2 Nr. 1), and only actual costs may be charged —
    courts often allow 1–3 € per letter, flat 5–10 € is contested, especially
    against consumers. Between businesses § 288 Abs. 5 allows a 40 € flat fee
    per claim, which the app does not offer. Which defaults to ship is a legal
    / business decision; nothing was changed.

18. **Have a Steuerberater import one DATEV Buchungsstapel** (found Tier 423).
    The export now follows DATEV's published format (EXTF 700, Formatversion
    13, DATEV's own sample file as reference) and DATEV's standard tax keys,
    but it has never been imported into DATEV Rechnungswesen — only DATEV
    software can prove it. Worth confirming at the same time: the SKR03
    accounts chosen for zero-rated revenue (8125 igL, 8120 Ausfuhr, 8337
    § 13b, 8336 EU services, 8338 third-country services, 8100 other exempt,
    8195 Kleinunternehmer), and whether the Berater wants foreign-currency
    documents with WKZ / Kurs instead of in EUR.

19. **What is a Quittung (RCV) used for?** (found Tier 424) Since Tier 424 it
    counts as a sale of its own (revenue, UStVA, DATEV, ageing). If users
    also issue a Quittung to confirm the payment of an existing invoice, that
    payment would be counted twice; the app has no link from an RCV to an
    invoice. Either confirm "RCV = cash sale" or add that link.

20. **EÜR on a cash basis (§ 11 EStG)** (found Tier 425). The EÜR and
    Anlage S / V count invoices at their issue date and expenses at their
    invoice date — a December invoice paid in January lands in the wrong
    year. Payment dates now exist for invoices, cash-, SEPA- and
    bank-matched expenses, but not for an expense paid by a transfer that
    was never matched. Switching needs a decision on those (fall back to the
    invoice date and say so?) — and whether Anlage G, which may belong to a
    bookkeeping business, follows. Also: a Kassenbuch entry without a VAT
    rate is treated as Privateinlage / -entnahme (no income) — confirm.

When the Hetzner items are available, the deploy is:

```bash
cd infra/prod
./HETZNER-DEPLOY.sh --check       # Tier 127 pre-flight, ~5s
./HETZNER-DEPLOY.sh                # 10-step deploy, ~15-20 min
bash infra/prod/smoke-test.sh      # 17-check post-deploy verification
```
Set `FRONTEND_URL` in `infra/prod/.env` first: since Tier 363 it is the
frontend's build arg, and the frontend image refuses to build without it.

## 10. Critical patterns / lessons (must read)

These are the **top 10 lessons** that prevented the Tier 339 audit from
finding critical/high issues. Future agents must respect them:

1. **`prisma db push` ≠ `prisma migrate deploy`** when raw-SQL migrations
   exist (search_tsv). Use `migrate deploy` for CI + prod.
2. **`execSync + docker exec + stdio: 'pipe'`** deadlocks at >1MB output.
   For throw-away SQL: `stdio: 'ignore'` OR `execFileSync` + `maxBuffer: 16MB`.
3. **HTML-escape source text BEFORE wrapping with `<mark>`** in any
   search/highlight code path that ends in `dangerouslySetInnerHTML`.
4. **Date fields in hashes:** always `Math.floor(t.getTime()/1000)*1000`
   to round to whole seconds before hashing.
5. **Audit-log hash chains need `stableStringify`** with explicit Date →
   ISO special case (Object.keys(date) returns []).
6. **React 18 + `domcontentloaded` ≠ hydrated.** For cold-compile pages,
   wait for `document.readyState === 'complete'` + 500ms buffer before
   any `click()` / `fill()`. Universal pattern in this codebase.
7. **`browser.newContext()` does not inherit auth cookies** — must
   explicitly `addCookies` + `addInitScript`.
8. **`page.setViewportSize()` after `page.goto()` is racy** on shared
   fixtures. Use `browser.newContext({ viewport: { ... } })`.
9. **`docker exec <container> pg_isready -q`** is the right readiness
   gate (returns 0 only when socket pool accepts connections), not
   `docker inspect ... State.Health.Status == healthy`.
10. **Prisma schema column names ≠ spec `INSERT INTO` column names** when
    a recent tier refactored the schema. Always grep `schema.prisma`
    before writing raw SQL in tests (`ci-seed.sh`, Playwright specs).
11. **A spec that passes on a stack other specs already ran on is not
    verified.** Only a fresh stack in `run-all.sh` order counts (Tier 361:
    117 and 134 passed alone, failed fresh).
12. **A fresh local run is still not the CI runner.** Specs that parse tool
    output or probe local paths broke on Linux (Tier 361b: `unzip -l` date
    format, macOS JDK path).
13. **Instantaneous `.count()` + `test.skip` hides races.** Wait with a
    web-first assertion; skip only for data that can legitimately be absent
    (Tiers 346–348, 362b).

## 11. What to do when you start

1. **Read this file + `backend/AGENTS.md`.** `AUDIT-TIER339-2026-09-08.md` is
   older background.
2. **Check the last CI run** (`gh run list --limit 3`). If jobs are not
   started or CI is otherwise unavailable, verify locally with
   `backend/scripts/local-ci-stack.sh` and say so.
3. **Ask the user** which open item to take next — §9 for their blockers, §8
   for known technical issues.
4. **Do NOT touch** the 2 intentional TODO strings in FinTS / eBilanz.
5. **Tier-number convention:** commit messages follow `Tier N: <short summary>`.
   Sub-tiers use letter suffixes (`Tier 361b`). Numbering is per-change, not
   per-release.

## 12. Tier / session-numbering convention

- **297 tier-prefixed commits** in repo history (`git log --oneline | grep -cE '^[0-9a-f]+ Tier'`).
- Tier numbers are a **monotonically incrementing per-change counter**,
  not release/sprint numbering.
- They are the project's primary cross-reference scheme in commits and the
  audit / playwright / deploy / runbook docs.
- Sub-tiers (e.g. `Tier 338b`) are follow-up commits on the same logical
  change, before moving to a higher number.
- **No `TIER.md` / `TIER-INDEX.md`** — look up by `git log --oneline | grep Tier`.
