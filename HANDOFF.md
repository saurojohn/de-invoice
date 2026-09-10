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

**Still open — 17 skips, blocked on a seed gap.** `customer-detail-tabs-tier238`
and `customer-detail-invoices-chip-tier243` both hard-code the customer UUID
`f84ebd20-4513-48e4-b331-87ba19477ae3`, described in their comments as
"created by Tier 50 e2e, has 1 invoice + 1 payment". **That UUID exists in no
seed script** — `grep -r f84ebd20` matches only those two spec files. It was
presumably a row in a developer's local dev DB. In CI the customer never
exists, so the pages render nothing, every dependent assertion misses, and
~10 tests have been silently skipping since Tier 243 — permanent zero
coverage. Converting their skips to assertions without first seeding the
fixture just turns CI red, so Tier 346 deliberately left both files alone.

**Fix for a follow-up tier:** add that customer + 1 invoice + 1 payment to
`backend/e2e/ci-seed.sh` with the same fixed UUID. Direct SQL there sidesteps
the Tier 174 P2002 invoice-sequence race that the specs' own comments cite as
the reason they took the hard-coded shortcut in the first place. Grep
`schema.prisma` for the real column names first (lesson 10).

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
