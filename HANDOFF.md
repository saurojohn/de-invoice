# de-invoice — Handoff to Claude (2026-09-09)

**This file is the first thing a new Claude session should read.** It orients you
to the project state, the most recent changes, the known blockers, and the
exact commands + docs you need to be productive.

---

## 1. Project snapshot

- **Stack:** Next.js 15.5.7 + NestJS 11 + Prisma 5 + PostgreSQL 16 (Docker)
- **Repo:** github.com/saurojohn/de-invoice, branch `main`, HEAD = `4a6b08a`
- **Domain:** German accounting / invoice web app (§ 146 AO GoBD compliant)
  - All UI text in **German** (operator-facing). PDF output in German. i18n:
    de / en / zh (de is source of truth).
  - Full accounting features required: Raten, Rabatte, Mahnung, DATEV,
    UStVA, UStJA, ELSTER, Anlage S/V, GoBD-Archiv, Berater-mode, audit log
    hash chain. **No simplified MVP** — every feature must be complete.
- **Test count (last green CI, Run #315 / commit `4a6b08a`):**
  - Backend e2e: 99 / 99 ✅
  - Playwright: 884 passed / **0 failed** / 1 flaky (cron race) / 27 skipped
  - `npx tsc --noEmit` clean on backend + frontend
  - 0 ESLint errors / warnings
  - 172 backend bash scripts validated

## 2. Branch state (clean)

```
$ git log --oneline origin/main | head -5
4a6b08a Tier 343: rec147 sortOrder -> position (schema column name, Tier 337 lesson)
047344d Tier 342: rec147 stderr capture + stdin pipe (true error message)
3982a34 Tier 341: 3 more PW spec cold-compile/race fixes (mobile auth copy, mahnungen loading wait, recurring pg_isready)
564d1ce Tier 340: 3 PW spec cold-compile hydration fixes (recurring-generated, bulk-send, invoice-tax)
a644217 Tier 339: full error + vulnerability audit (28 files, 0 critical/high)
```

- **No** staged, unstaged, or in-progress work
- **Untracked:** `tmp-pw-fail/` (leftover Playwright failure-artifact directory,
  15 entries, 2026-09-09 11:33) — safe to delete or `.gitignore`.

## 3. Recent session arc (Tiers 339 → 343, CI-hardening closeout)

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

## 5. CI configuration (`.github/workflows/ci.yml`, 517 lines, 4 jobs)

- **Jobs:** `backend-typecheck`, `frontend-typecheck`, `e2e`, `playwright`
  — all run in parallel, no `needs:`, no artifact handoff between jobs
  (both e2e + playwright re-run `ci-seed.sh` independently).
- **Triggers:** push to `main` + pull_request to `main`
- **`concurrency.cancel-in-progress: true`** is set — a new commit cancels
  the prior run on the same ref.
- **No `timeout-minutes`** set on any job — relies on GitHub's default 360 min.
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
- **5 `if:` clauses** — all artifact uploads (`if: always()` or
  `if: failure()`). No conditional test-skipping.
- **No commented-out steps**, no TODO/FIXME in the workflow file.

## 6. Schema + migrations

- **22 migrations** in `backend/prisma/migrations/` (oldest:
  `20240101000000_baseline`, newest:
  `20260905000001_invoice_eur_aggregation`).
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

- **Backend e2e:** 172 shell specs in `backend/e2e/*.sh`;
  seed driver `backend/e2e/ci-seed.sh` = 496 lines.
- **Playwright:** 171 spec files in `frontend/e2e/`;
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
  per-spec failure count is lost. Convention is `set -uo pipefail`
  (149/172 specs). The 23 specs carrying `set -euo pipefail` are a
  historical inconsistency — do not copy them.
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

### Operational issues (consider for next tier)
- **`tmp-pw-fail/`** untracked — delete or `.gitignore`.
- **No `timeout-minutes`** on CI jobs (relies on GitHub default 360 min).
- **No `needs:`** between jobs — both e2e + playwright re-run seed
  independently. Could share via artifact for ~30s speedup.

## 9. External blockers (user must provide)

These are **NOT in the repo** — the user needs to provide them:

1. **Hetzner VPS IP** — needed by `infra/prod/HETZNER-DEPLOY.sh` step 3
   (DNS A record) and step 5 (the deploy itself).
2. **Hetzner SSH key** — needed for the initial `ssh-copy-id` to the VPS.
3. **`sudo` password** (only for `scripts/fix-dev-pg.sh` if dev PG corrupts;
   not a deploy blocker).

When these are available, the deploy is:

```bash
cd infra/prod
./HETZNER-DEPLOY.sh --check       # Tier 127 pre-flight, ~5s
./HETZNER-DEPLOY.sh                # 10-step deploy, ~15-20 min
bash infra/prod/smoke-test.sh      # 17-check post-deploy verification
```

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

## 11. What to do when you start

1. **Read this file + `backend/AGENTS.md` + `AUDIT-TIER339-2026-09-08.md`.**
2. **Ask the user:** "Do you want me to continue the CI-hardening work
   (the 3 deferred LOW items + the 2 operational issues), start the
   Hetzner deploy (need IP + SSH key), or work on something else?"
3. **Do NOT touch** the 2 intentional TODO strings in FinTS / eBilanz.
4. **Do NOT remove** `tmp-pw-fail/` without checking with the user.
5. **Tier-number convention:** commit messages follow
   `Tier N: <short summary>`. Sub-tiers use letter suffixes
   (`Tier 338a/b/c/d`). Numbering is per-change, not per-release.

## 12. Tier / session-numbering convention

- **390 tier-prefixed commits** in repo history (`git log | grep -c "^.\{8\} Tier"`).
- Tier numbers are a **monotonically incrementing per-change counter**,
  not release/sprint numbering.
- Numbers are referenced in 29 tracked `.md` files (audit / playwright /
  deploy / runbook docs). They are the project's primary cross-reference
  scheme for "what was learned/done when".
- Sub-tiers (e.g. `Tier 338b`) indicate a follow-up commit on the same
  logical change set, before moving to a higher number.
- **No `TIER.md` / `TIER-INDEX.md`** at repo root — lookup is by
  `git log --oneline | grep Tier` or by reading the audit / session-summary
  docs.
