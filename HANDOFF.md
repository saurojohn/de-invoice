# de-invoice — Handoff to Claude (2026-09-11)

**This file is the first thing a new Claude session should read.** It orients you
to the project state, the most recent changes, the known blockers, and the
exact commands + docs you need to be productive.

---

## 1. Project snapshot

- **Stack:** Next.js 15.5.7 + NestJS 11 + Prisma 5 + PostgreSQL 16 (Docker)
- **Repo:** github.com/saurojohn/de-invoice, branch `main`. Tiers 344–364 are
  in `git log`; §8 records what each learned. (Snapshot refreshed Tier 364.)
- **Domain:** German accounting / invoice web app (§ 146 AO GoBD compliant)
  - All UI text in **German** (operator-facing). PDF output in German. i18n:
    de / en / zh (de is source of truth).
  - Full accounting features required: Raten, Rabatte, Mahnung, DATEV,
    UStVA, UStJA, ELSTER, Anlage S/V, GoBD-Archiv, Berater-mode, audit log
    hash chain. **No simplified MVP** — every feature must be complete.
- **Test counts (last green CI, run 34617401242 / commit `843f9bf`, Tier 364):**
  - Backend e2e: **169 passed / 0 failed** — 100 two-digit + 69 three-digit
    specs; before Tier 361 only the two-digit ones ever ran. `QUARANTINE` empty.
  - Playwright: **908 passed / 0 failed / 4 skipped** (3 deliberate skips +
    `admin-ops-tier195` 4, which needs a backup with `db.sql.gz`)
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
  re-hash the audit-log chain in `createdAt` order (only needed if chain
  gets corrupted)

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

- **22 migrations** in `backend/prisma/migrations/` (oldest:
  `20240101000000_baseline`, newest: `20260905000001_invoice_eur_aggregation`).
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

### Playwright silent-skip coverage hole (Tier 346 partial)

The suite has **62 runtime `test.skip(true, ...)` calls across 29 spec
files**. 35 of them fire on "element not found / not present / may be
loading" — i.e. a hydration race or a real UI regression is converted into
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

**No lint job in CI.** The 4 jobs are backend-typecheck, frontend-typecheck,
e2e and playwright — eslint is never run, which is how an unused-import
warning drifted into `customer-detail-invoices-chip-tier243.spec.ts` against
the repo's stated "0 warnings" bar (removed in Tier 347). Worth a job.

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
   remote URL (github.com/settings/tokens). The remote now uses SSH.
4. **Dev database out of `/tmp/pgdata`.** The manually created
   `de-invoice-postgres` container bind-mounts `/tmp/pgdata`; macOS purges
   `/tmp`, and nightly backups have contained **no database since
   2026-09-06** (last full one: `backup-2026-09-05-224235`). Recreate it via
   `docker-compose.yml`'s named volume. Rotation no longer deletes the old
   full backups while dumps fail (Tier 360).
5. **Anlage AUS KapG rule** — `anlage-aus.service.ts` never recognises a
   legal name like "SH Leder GmbH"; a word match would also hit
   "GmbH & Co. KG" (§8, Tier 361). Needs a product decision.
6. **Hetzner VPS IP + SSH key** — for `infra/prod/HETZNER-DEPLOY.sh`
   (DNS A record, deploy). `sudo` only for `scripts/fix-dev-pg.sh`.

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
