# de-invoice — Handoff to Claude (2026-09-11)

**This file is the first thing a new Claude session should read.** It orients you
to the project state, the most recent changes, the known blockers, and the
exact commands + docs you need to be productive.

---

## 1. Project snapshot

- **Stack:** Next.js 15.5.27 + NestJS 11 + Prisma 5 + PostgreSQL 16 (Docker)
- **Repo:** github.com/saurojohn/de-invoice, branch `main`. Tiers 344–646 are
  in `git log`; §8 records what each learned. Tiers 443–462 came from the
  cloud branch `claude/eloquent-hopper-qbea72` (PR #1, merged `ba31e7f`). (Snapshot refreshed Tier 646.) **Deployment status, confirmed by the owner on 06.10.2026: not live — local development only.** The `infra/prod/` findings of Tiers 555–560 are pre-launch hardening, not incidents; nothing there needs to be checked on a server, and `scripts/baseline-migrations.sh` has no database to run on yet.
- **Domain:** German accounting / invoice web app (§ 146 AO GoBD compliant)
  - All UI text in **German** (operator-facing). PDF output in German. i18n:
    de / en / zh (de is source of truth).
  - Full accounting features required: Raten, Rabatte, Mahnung, DATEV,
    UStVA, UStJA, ELSTER, Anlage S/V, GoBD-Archiv, Berater-mode, audit log
    hash chain. **No simplified MVP** — every feature must be complete.
- **Test counts (last green CI, run 38021079126 / commit `7363651`, Tier 646):**
  - Backend e2e: **381 passed / 0 failed / 1 skipped** of 382 specs — 100
    two-digit + 282 three-digit (Tiers 636–646 added 376 the reminder's open amount, 377 the bank
    matching against what is open, 378 OSS sales out of the UStVA, 379 bank files as a bank writes
    them, 380 the tax forms by legal form, 381 the layout of the tax PDFs, 382 the statement's sender and the signature's signer; Tiers 629–635 added 374 the role in a 403 and the sealed SMTP
    password, 375 the customer portal's own data; Tiers 626–628 added 373 rounding per customer,
    pauses on the entry and the report's CSV; Tiers 621–625 added 372 progress, pause, rounding and the
    hours report; Tiers 614–618 added 368 the order confirmation, 369 a quote
    in parts, 370 projects and hourly rates, 371 the timer and the time sheet;
    Tiers 609–613 added 364 closing the books, 365 quotes and
    delivery notes, 366 time tracking, 367 a quote is not booked;
    Tiers 589–608 added 353 the activity log's company filter,
    354 the dashboard's net profit, 355 foreign ids in a request body, 356 a not-found is no
    error event, 357 DISABLE_CRON for every job, 358 the Leitweg-ID, 359 a recurring run gives
    its number back, 360 the Impressum, 361 a supplier invoice by hand, 362 strict booleans,
    363 the documented environment variables;
    Tier 586 added `352-tier586-gutschrift-als-e-rechnung.sh`,
    Tier 585 added `351-tier585-abgelehnte-rechnung-verbraucht-keine-nummer.sh`,
    Tier 583 added `350-tier583-signaturpruefung.sh`,
    Tier 581 added `349-tier581-ausgabe-mit-mehreren-steuersaetzen.sh`,
    Tier 577 added `348-tier577-eine-zahlung-mehrere-steuersaetze.sh`,
    Tier 576 added `347-tier576-monitoring-overlay.sh`,
    Tier 575 added `346-tier575-passwort-aendern.sh`,
    Tier 574 added `345-tier574-scan-lieferant-erst-bei-bestaetigung.sh`,
    Tier 573 added `344-tier573-eingangs-e-rechnung.sh`,
    Tier 572 added `343-tier572-abhaengigkeiten-untergrenze.sh`,
    Tier 566 added `342-tier566-kaputter-beleg-stuerzt-nicht-ab.sh`,
    Tier 561 added `341-tier561-caddyfile-gueltig.sh`,
    Tier 560 added `340-tier560-logo-im-speicher.sh`,
    Tier 559 added `339-tier559-migrationen-ergeben-das-schema.sh`,
    Tier 556 added `338-tier556-link-adresse.sh`,
    Tier 553 added `337-tier553-heute-ist-der-deutsche-tag.sh`,
    Tier 551 added `336-tier551-ohne-companyid-ist-nicht-alle.sh`,
    Tier 550 added `335-tier550-fehlerliste-je-firma.sh`,
    Tier 549 added `334-tier549-probes-sagen-nicht-wo.sh`,
    Tier 548 added `333-tier548-betreiber.sh`,
    Tier 547 added `332-tier547-read-only-ist-read-only.sh`,
    Tier 546 added `331-tier546-fints-schreibrechte.sh`,
    Tier 545 added `330-tier545-portal-nur-rechnungsdaten.sh`,
    Tier 544 added `329-tier544-logo-pfad.sh`,
    Tier 543 added `328-tier543-logo-ist-ein-bild.sh`,
    Tier 542 added `327-tier542-beleg-inhalt.sh`,
    Tier 541 added `326-tier541-fahrten-wohnung-betrieb.sh`,
    Tier 540 added `325-tier540-kursdifferenzen.sh`,
    Tier 539 added `324-tier539-bewirtungsbeleg.sh`,
    Tier 538 added `323-tier538-skonto-im-gesperrten-zeitraum.sh`,
    Tier 537 added `322-tier537-uebermittelter-zeitraum-gesperrt.sh`,
    Tier 536 added `321-tier536-zahlung-doppelt.sh`,
    Tier 535 added `320-tier535-abo-start-in-der-vergangenheit.sh`,
    Tier 534 added `319-tier534-gleichzeitig.sh`,
    Tier 533 added `318-tier533-fehler-statt-500.sh`,
    Tier 532 added `317-tier532-abfrageparameter.sh`,
    Tier 531 added `316-tier531-ungepruefte-bodies.sh`,
    Tier 530 added `315-tier530-mt940-feld86.sh`,
    Tier 529 added `314-tier529-bankbuchung-einmal.sh`,
    Tier 528 added `313-tier528-tage-ueberfaellig.sh`,
    Tier 527 added `312-tier527-stammdaten-pruefziffer.sh`,
    Tier 526 added `311-tier526-mahnung-erst-nach-faelligkeit.sh`,
    Tier 525 added `310-tier525-zahlungsweg-ueberall.sh`,
    Tier 524 added `309-tier524-kasse-zeitfolge.sh`,
    Tier 523 added `308-tier523-ausgabe-betraege.sh`,
    Tier 522 added `307-tier522-neuer-ratenplan.sh`,
    Tier 521 added `306-tier521-abo-uebersprungen.sh`,
    Tier 520 added `305-tier520-lagerbestand.sh`,
    Tier 519 added `304-tier519-abo-pause.sh`,
    Tier 518 added `303-tier518-faellig-vor-rechnungsdatum.sh`,
    Tier 517 added `302-tier517-tagesabschluss-je-firma.sh`,
    Tier 516 added `301-tier516-kasse-anlagen-zukunft.sh`,
    Tier 515 added `300-tier515-kein-datum-in-der-zukunft.sh`,
    Tier 514 added `299-tier514-zahlung-vorbehalten.sh`,
    Tier 513 added `298-tier513-abo-umsatzsteuer.sh`,
    Tier 511 added `297-tier511-gutschrift-formular.sh`,
    Tier 510 added `296-tier510-mahnungspause-senden.sh`,
    Tier 509 added `295-tier509-eigenkapital.sh`,
    Tier 508 added `294-tier508-ebilanz-steuern.sh`,
    Tier 507 added `293-tier507-kst-vorauszahlungen.sh`,
    Tier 506 added `292-tier506-ertragsteuern.sh`,
    Tier 505 added `291-tier505-fremdwaehrung-bank.sh`,
    Tier 504 added `290-tier504-homeoffice.sh`,
    Tier 503 added `289-tier503-geschenke.sh`,
    Tier 502 added `288-tier502-firmenwagen.sh`,
    Tier 501 added `287-tier501-sondervorauszahlung.sh`,
    Tier 500 added `286-tier500-ratenplan-keine-mahnung.sh`,
    Tier 499 added `285-tier499-betrag-positiv.sh`,
    Tier 498 added `284-tier498-ustid-beider-seiten.sh`,
    Tier 497 added `283-tier497-archivkopie-erst-ab-ausstellung.sh`,
    Tier 496 added `282-tier496-entwuerfe-intern.sh`,
    Tier 495 added `281-tier495-email-stellt-aus.sh`,
    Tier 494 added `280-tier494-pflichtangaben.sh`,
    Tier 493 added `279-tier493-leistungszeitraum.sh`,
    Tier 492 added `278-tier492-leistungsdatum.sh`,
    Tier 491 added `277-tier491-zusammenfassende-meldung.sh`,
    Tier 490 added `276-tier490-ustid-format.sh`,
    Tier 489 added `275-tier489-eingangsrechnung-doppelt.sh`,
    Tier 488 added `274-tier488-kontoauszug-doppelt.sh`,
    Tier 487 added `273-tier487-igl-13b-ohne-ust.sh`,
    Tier 486 added `272-tier486-igl-ustid.sh`,
    Tier 485 added `271-tier485-bewirtung.sh`,
    Tier 484 added `270-tier484-weitere-ust-zahlungen.sh`,
    Tier 483 added `269-tier483-euer-umsatzsteuer.sh`,
    Tier 482 added `268-tier482-kleinunternehmer-xrechnung.sh`,
    Tier 481 added `267-tier481-kleinunternehmer-vorsteuer.sh`,
    Tier 480 added `266-tier480-kleinunternehmer.sh`,
    Tier 479 added `265-tier479-geschaeftstag-buchungen.sh`,
    Tier 478 added `264-tier478-kalendertag.sh`; the
    backend e2e job runs with TZ=Europe/Berlin since Tier 478a,
    Tier 477 added `263-tier477-bearbeiten-nach-zahlung.sh`,
    Tier 476 added `262-tier476-keine-mahnung-proforma.sh`,
    Tier 475 added `261-tier475-anzahlung-rueckzahlung.sh`,
    Tier 474 added `260-tier474-keine-gutschrift-proforma.sh`,
    Tier 473 added `259-tier473-schlussrechnung-xml.sh`,
    Tier 472 added `258-tier472-schlussrechnung.sh`,
    Tier 471 added `257-tier471-db-down-not-401.sh`,
    which stops the database container — CI only, or a throwaway PG_CONTAINER;
    Tier 470 added `256-tier470-anzahlung-proforma.sh`,
    Tier 467 added `255-tier467-skr03-sachkonten.sh`,
    Tier 465 added `254-tier465-ustva-kz10.sh`,
    Tier 464 added `253-tier464-anlage-g-gewinnermittlung.sh`,
    Tier 463 added `252-tier463-ustva-negative-vorsteuer.sh`,
    Tier 462 added `251-tier462-zahlung-status.sh`,
    Tier 461 added `250-tier461-storno-bezahlt.sh`,
    Tier 460 added `249-tier460-zahlung-loeschen.sh`,
    Tier 459 added `248-tier459-quittung-datev.sh`,
    Tier 458 added `247-tier458-privat-kasse.sh`,
    Tier 457 added `246-tier457-ist-versteuerung.sh`,
    Tier 456 added `245-tier456-guthaben-auszahlung.sh`,
    Tier 455 added `244-tier455-anlage-s-v-zufluss.sh`,
    Tier 454 added `243-tier454-euer-zufluss.sh`,
    Tier 453 added `242-tier453-storage-url.sh`,
    Tier 452 added `241-tier452-lieferantenskonto.sh`,
    Tier 451 added `240-tier451-zahlung-eingangsrechnung.sh`,
    Tier 450 added `239-tier450-gutschrift-erstattung.sh`,
    Tier 449 added `238-tier449-berichtigung-noetig.sh`,
    Tier 448 added `237-tier448-ustva-uebermittelt.sh`,
    Tier 447 added `236-tier447-ausgaben-status.sh`,
    Tier 446 added `235-tier446-zuordnung-storno.sh`,
    Tier 445 added `234-tier445-docker-exec-stdin.sh`,
    Tier 444 added `233-tier444-bankbeleg-storno.sh`,
    Tier 443 added `232-tier443-ausgabe-korrigieren.sh`,
    Tier 442 added `231-tier442-lieferantengutschrift.sh`,
    Tier 441 added `230-tier441-rechtsform.sh`,
    Tier 440 added `229-tier440-anlagenabgang.sh`,
    Tier 439 added `228-tier439-kst-ohne-anrechnung.sh`,
    Tier 438 added `227-tier438-anlage-g-gewerbesteuer.sh`,
    Tier 437 added `226-tier437-afa-keine-rechnung.sh`,
    Tier 436 added `225-tier436-afa-im-gewinn.sh`,
    Tier 435 added `224-tier435-kasse-nie-negativ.sh`,
    Tier 434 `223-tier434-kasse-umbuchung.sh`, Tier 433 `222-tier433-sepa-storno.sh`,
    Tier 432 `221-tier432-sepa-datev.sh`,
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
  - Playwright: **1049 passed / 0 failed / 0 skipped / 0 flaky** (Tier 583
    added `pdf-signature-verify-tier583.spec.ts`; Tier 582
    added `ustva-expense-rates-tier582.spec.ts`; Tier 581
    added `expense-tax-lines-tier581.spec.ts`; Tier 577
    added `bank-payment-parts-tier577.spec.ts`; Tier 575
    added `change-password-tier575.spec.ts`; Tier 574
    added `ocr-scan-keeps-file-tier574.spec.ts`; Tier 573
    added `e-invoice-import-tier573.spec.ts` (2 tests); Tier 507
    added `kst-vorauszahlungen-tier507.spec.ts`; Tier 504
    added `home-office-tier504.spec.ts`; Tier 502
    added `company-cars-tier502.spec.ts`; Tier 493
    added `service-period-tier493.spec.ts` (2 tests); Tier 491
    added `zm-tier491.spec.ts`; Tier 483
    added `ustva-payment-tier483.spec.ts`, Tier 484 a second test in it; Tier 473
    added `final-invoice-tier473.spec.ts`, Tier 475 a second test in it; run
    36231779527 on Tier 461 had 1 flaky — `list-pages.spec.ts` "Invoices
    list" counted the rows before the list had rendered; fixed in Tier 462,
    which waits for a row or the empty state. Tier 428's
    run had one flaky — `list-pages.spec.ts` "Invoices list renders without
    console errors" expected the empty state and saw a populated list, then
    passed on retry). 945 tests (922 since Tier 390's
    page tests; +4 in Tier 401's session-cookie spec; +2 in Tier 413's
    invoice-discount-row spec; +2 in Tier 415's invoice-form-totals spec; +3 in
    Tier 443's ustva-expense-edit spec; +2 in Tier 447's expense-edit spec; +1 in
    Tier 448's ustva-berichtigt spec; +1 each in Tiers 449, 450, 451, 452, 453, 454, 455, 457 and 458). Tier 365 turned the last 4 skips into real
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
- **Playwright:** 227 spec files in `frontend/e2e/`;
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

~~Still open~~ (closed in Tier 453): the settings page's file **Download** button is a plain navigation
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

### Read-only mode refuses every write; a re-verification is one company's (Tier 648 — the CSV files a person opens have a comma in their numbers

Decided by the owner on 10.10.2026 (§9 item 25: „用小数逗号“). Every CSV the application writes was fetched for a company with data and its numbers counted by form. With a point: the invoice list (`GET /invoices/export/csv`), the hours report (`/time-entries/report.csv`), the product list and the ageing report (both written in the browser), and the cash book's daily-close column („154.7 EUR (Differenz: 0 EUR)“). The cash book's amounts had a comma and a thousands separator („1.234,50“). With a comma already: the OSS report, the cost-centre report, the statement batch's index, and everything in a format of its own (DATEV EXTF, Buchungsliste, USt-Verprobung).

`common/csv.ts` — `csvNumber` (two decimals, a comma, no thousands separator) and `csvCell` (quoted for a quote, a semicolon or a line break) — is used by the three backend writers; the browser's export button writes a number with a comma. **Found on the way:** the export button and the ageing report quoted a cell for a *comma* and not for the *semicolon* that separates the cells, and the sales report's export quoted nothing — a customer or product with a semicolon in its name split its row. All three quote for the semicolon now. Left as they are: the audit log's export (raw stored values) and the files for DATEV and the GoBD archive.

Spec `383-tier648-csv-mit-komma.sh` (7 assertions): the invoice list's amounts, a name with a semicolon as one quoted cell of eighteen, the cash book's amount and daily close, the hours report, and no cell of the three files that is digits-point-digits. Spec 373 expects commas. Playwright `csv-comma-tier648.spec.ts`: the product list downloaded — „19,99“, „"Tasche; groß"“. The product import already read „19,99“.

### Read-only mode refuses every write; a re-verification is one company's (Tier 647 — one name for each dunning level

Decided by the owner on 10.10.2026 („你来改“). The three levels had five sets of names: the letter said Zahlungserinnerung / 1. Mahnung / Letzte Mahnung; the e-mail's subject Erinnerung / „2. Mahnung“ / Letzte Mahnung; the reminders page „1. Erinnerung“ / „2. Mahnung“; the settings „2. Mahnung (1. Mahnung)“ and, for the third level, both „3. Mahnung (Letzte Mahnung)“ and „2. Mahnung (3. Stufe)“; the invoice page's selector „1. 1. Erinnerung“ / „2. 2. Mahnung“ (a number in front of a label that had one). A customer got an e-mail headed „2. Mahnung“ with a letter headed „1. Mahnung“.

One set, the letter's: **Zahlungserinnerung · 1. Mahnung · Letzte Mahnung** (en: Payment reminder · 1st dunning notice · Final dunning notice; zh: 付款提醒 · 第一次催款 · 最后催款), and where the level's number is meant, „Stufe 2: 1. Mahnung“. Changed: the e-mail's default subjects (a template nobody edited follows, Tier 638), twenty message keys in three languages, the two pages with names of their own. Spec 376 asserts the three default subjects; Playwright `reminders-open-amount-tier638.spec.ts` the three options of the reminders page and that „2. Mahnung“ / „1. Erinnerung“ are gone; `mahnung-templates-tier151.spec.ts` expected „2. Mahnung“ and expects „1. Mahnung“.

### Read-only mode refuses every write; a re-verification is one company's (Tier 646c — the accounting page's sections are moved, not placed late (a flaky test, read three runs too late)

Reading the counts for the snapshot: „1 047 passed, **1 flaky**“ — and the same line in the three runs before it, back to the run that brought Tier 643. Each time a test of `/dashboard/accounting` had failed and passed on its retry (`gobd-archive.spec.ts` three times, then `kst-vorauszahlungen-tier507.spec.ts`: four quarters filled with 250, saved, 750 stored). The runs were green and the conclusion was all that was looked at.

The cause was Tier 643's own caution: the sections were placed only once `GET /accounting/forms` had answered, „so none loads its figures twice“. That moved every section's first load to a later moment — after the page counts as loaded — and a field filled in that moment was overwritten when the section's own load arrived. A person who types fast meets the same thing as the test. Now all nineteen sections are in **one keyed list from the first render**, in the old order; the answer reorders the list and inserts the line as one more keyed element. React moves a keyed element, it does not mount it again: nothing loads twice, and nothing waits.

Playwright `accounting-forms-tier643.spec.ts`, third test (fails on the version before, which shows no section while the answer is held): the answer is held back by a route; the sections are there in the old order; a year is typed into KSt 1; the answer is released; the section has moved to second place, is the same DOM element, and still holds the year. The two tests that had been flaky cannot run on this machine (port 3001) — the CI run of this commit is their check: **0 flaky** is the number to read.

### Read-only mode refuses every write; a re-verification is one company's (Tier 646 — the statement and the signature are the sending company's; statement and reminder letter are one page

Tier 645 named three PDFs it had not opened. Two were opened (a reminder letter and a customer statement, for a company made an hour before), and the statement had **another company's letterhead**.

- **One company's identity written into the source, on every company's documents.** `customer-statement-pdf.service.ts`: letterhead „SH Leder GmbH · Otto-Hahn-Str. 24 · 63303 Dreieich · Deutschland“, footer „SH Leder GmbH · Steuer-Nr. … · USt-ID … · Bank Sparkasse Dreieich · IBAN …“, the PDF's author the same — literals. A second company that sent a customer its statement sent it under the first company's name, tax number and bank account. The statement now carries its sender (`CustomerStatement.company`, read from the company's record) and the PDF prints that: name, address, and of tax number, VAT id, bank and IBAN the ones the company has. Looking for the same literal elsewhere found `signing.service.ts`: **every invoice PDF is signed on download, and the signature's signer, contact and place were „SH Leder GmbH“, „info@shleder.de“, „Stuttgart“** for every company (and „Stuttgart“ for a user's own signature). The signer is the issuing company — its legal name, its e-mail address, its town. (The certificate itself was already per company, Tier 165.) Found by opening a PDF of a company that is not the first one; every spec that fetched these PDFs checked `%PDF`.
- **A second page with one line on it.** Both the statement and every reminder letter wrote their footer below the bottom margin, where pdfkit starts a new page for it. Written with the margin lifted, the footer stays on its page.
- **The statement's Saldo column jumped.** Balances are run in chronological order; the display order was sorted again by date and type, which left two payments of one day in ascending order inside a descending list (3 128,36 above 2 778,50 above 3 300,86). The display order is the run order or exactly its reverse.
- Smaller, in the same two PDFs: the reminder letter's cost block was headed „ZUSÄTZLICHE KOSTEN 0,00 €“ above a fee of 5,00 € and interest of 7,15 € (now their sum) and had a line of its own that said „(Werktage)“; the statement's „Saldostichtag“ ran into its date, and its first row and its sums stood on the rules above them.

Not changed, a wording decision (§9 item 25): the second dunning level is „2. Mahnung“ in the e-mail's subject and in the interface and „1. Mahnung“ in the letter attached to that e-mail.

**Tier 646b — the cash book's daily close**, the last PDF not yet opened: its signature block („Integritäts-Signatur“, algorithm, hash, date) stood in the amount column, a few letters to a line, under a heading that read „Integritäts-Signatur (Tier 194)“; the table's „Betrag“ heading was off the page. It is made with `flowFromLeft` now and the heading is the heading. Spec 381 fetches it for a closed day.

Spec `382-tier646-kontoauszug-absender-und-eine-seite.sh` (12 assertions, 6 of the first 10 fail on the code before): the statement names its sender; the balance column runs in both orders; statement and reminder letter are one page; the PDF's author and the signature's signer, place and contact are the company's; neither source file contains a company's name or numbers. With this every PDF route of the application has been opened once.

### Read-only mode refuses every write; a re-verification is one company's (Tier 645 — the invoice's total box

The PDFs outside the tax previews were measured the same way (invoice, journal, time sheet, voucher, VAT audit, Anlage SO v2): no line off the page, none in a wrong column. The invoice was opened: one flaw — the box around „Gesamtbetrag“ (and „Zahlbetrag“ after an advance) ended exactly where the amount ends, the last digit on its border; the label has 5 pt of room on the left. The box is 5 pt wider on the right. Spec 381 reads the rectangle out of the PDF (550,28; it was 545,28). Not opened in this pass: the reminder letter, the customer statement, the cash-book close (they need fixtures the scenario did not have).

### Read-only mode refuses every write; a re-verification is one company's (Tier 644b — the same PDFs, looked at again: the amount column's heading, sums, page breaks

With the worst gone, the PDFs were opened once more and measured for a second thing — text placed outside the page. Three more faults, all in `common/pdf-flow.ts` again, so every preview gets the repair:

- **The heading of the amount column was off the page in fourteen PDFs.** The header cells were written with `continued: true` („Kz“, „Bezeichnung“, then „Betrag (€)“ at its own x); pdfkit continues the line and adds the width of what came before, and „Betrag (€)“ was set at x = 893 on a page 595 points wide. A call with a position of its own now starts its own text. (The EÜR writes all its rows that way; its second line of a wrapped label lay under the next row — the row's height now counts a continued cell too.)
- **A sum stood a line below its label** — „Summe“ at `(x, doc.y)` and its amount at `(x2, doc.y)`, the cursor having moved in between (Bilanz, G+V, KSt 1, the annexes, EÜR). A cell that starts to the right of the cell just written, at exactly the y that cell ended on, is in that cell's row.
- **A row at the foot of a page was torn apart**: pdfkit breaks the page inside the cell that overflows, and the row's other cells, written at the y the caller remembered, land at that height on the new page — in Anlage G „GewStG)“ alone at the top of page 2 and its „0,00“ at the bottom of an otherwise empty page. A row that does not fit (with room for a label of two lines and its note) moves to the next page as a whole.

One of these repairs broke something on the way and was caught by the count of text lines, not by a spec: measuring a `continued` cell with `heightOfString` took its text out of the line, and the EÜR came out with amounts and no labels (32 lines instead of 138) until the measurement skipped such cells. Spec 381 now also asserts that no line is off the page (16 PDFs) and that the EÜR's numbers and labels stand in their columns (22 assertions).

Still as they were: the developer wording of the notes; the E-Bilanz PDF's 19 pages; a table's header row can stand alone at the foot of a page.

### Read-only mode refuses every write; a re-verification is one company's (Tier 644 — the tax previews as PDFs: from the left margin, in characters the font has

Tier 643b ended with „the other PDFs were not opened“. They were then: all nineteen of the accounting page, for a GmbH with a month of business, each measured by where its lines of text start and the suspicious ones looked at.

- **The same fault in eleven of them.** pdfkit's text cursor stays where the last table cell began; a heading, a summary or a closing note written without a position was set in the amount column, 90 points wide. GewSt: „BMF Vordruck GewSt 1A — / Kennziffern“ in the right-hand column, the summary „Festzusetzen / de GewSt / (Kz 10): / 378,00 € | Vo / rauszahlunge / n …“, and the explanation **cut off at the page edge** in the middle of every line. UStJA, KSt 1 (30 such lines, a second page because of them), Anlage G (26), N, R, Kind, SO, AUS, S, V the same. `common/pdf-flow.ts`, `flowFromLeft(doc)`: a `text()` without x / y that follows a positioned cell starts at the left margin again; positioned calls and continued lines are left alone. All 22 documents of the accounting and report modules are made with it.
- **Signs the fonts do not have.** The built-in fonts print WinAnsi; anything else is written as its two UTF-16 bytes: „↳“ came out as „!³“ in front of every note of the balance sheet, „✓“ as an apostrophe, the minus sign as a quotation mark — „Saldoposten übriges Eigenkapital (Aktiva " sonstige Passiva " Jahresüberschuss)“. `printable()` writes them in characters the fonts have (›, –, „Achtung:“, „Summe“, >=, ->, „ungleich“); it is part of `flowFromLeft` and applied alone (`printableText`) to the voucher, journal and cash-book PDFs, which use such signs too.

- **A wrapped label was overprinted by the next row.** The cells of a row are written at one y and the cursor ends below the last of them, one line high: „Raumkosten (Miete, Heizung, / Nebenkosten)“ in the BWA lay under „Versicherungen, Beiträge“, KSt 1's rows 60 and 80 under their notes, the balance sheet's EKV and 4500 likewise. The helper ends a row below its tallest cell. A zero printed as „-0,00“ where a small negative had been rounded is printed without the sign; the BWA's first row stood on the header's rule.

Seen in the same PDFs and **not done**: the amount of a „Summe“ row stands a line below its label; the notes and closing texts speak to a developer („Tier 506:“, „via PUT /gewst/settings“, „Company.settings.kst1Korrekturen[year]“, „v2: native ELSTER-XML …“) — the paths §9 item 24 already lists for the page; the E-Bilanz PDF has 19 pages. The invoice, reminder, time sheet and statement PDFs are not made with the helper and were looked at in earlier tiers.

Spec `381-tier644-pdf-vom-linken-rand.sh` (19 assertions, 14 fail on the code before): fourteen PDFs fetched and their text positions read — no line starts at the left edge of a right-hand column; a static check that every accounting / report PDF is made with `flowFromLeft` and that no PDF source uses an unprintable sign without the translation; `printable()` itself. The 89 specs that fetch a PDF pass (the ones that fail on this machine only, as before).

### Read-only mode refuses every write; a re-verification is one company's (Tier 643b — the UStVA PDF, looked at

The note about OSS sales was added to the UStVA PDF's footer (Tier 641 had left the PDF out) and the PDF opened to see it: the note ran off the page. So did everything that was written without a position — „2. Sonderfälle“, „Steuer als Leistungsempfänger“, „3. Abziehbare Vorsteuer“ and the three footer lines started where the last amount's column begins and were set 90 points wide („Steuer als L / eistungsem / pfänger“); the first row of the first table stood on the header's rule and looked struck through; no input tax printed as „-0,00 €“. Each heading and the footer now start at the left margin, the row below the rule, zero as zero. No spec had looked at this PDF's layout; spec 378 now reads the text positions out of it (no line starts at the left edge of an amount column — 14 did). **The other PDFs the app makes (BWA, EÜR, the annexes, Bilanz, G+V …) were not opened in this pass.**

### Read-only mode refuses every write; a re-verification is one company's (Tier 643 — the accounting page puts the forms of the company's legal form first

§9 item 24: „the private annexes offered to a GmbH“. The accounting page rendered nineteen forms in one fixed order for every company — a GmbH found its KSt 1 between Anlage N (wages) and Anlage R (pensions), a freelancer the corporation tax return.

`company/tax-forms.ts` says which forms a company files, from the legal form (set, or derived from the name — `rechtsform.ts`) and the profit determination (`gewinnermittlung.ts`): the Berater package, UStJA and the GoBD archive for everyone; KSt 1, GewSt and the Anhang for a corporation; Anlage G and GewSt for a sole trader, Anlage S for a freelancer, and for both the annexes of the owner's own return (V, KAP, N, R, Kind, SO, AUS); GewSt for OHG / KG / GmbH & Co. KG, the Anhang for the latter (§ 264a HGB); EÜR or Bilanz / G+V / E-Bilanz by the profit determination. `GET /accounting/forms` returns the two lists. The page puts the first list on top, then a line — „Für die Rechtsform „GmbH“ nicht einschlägig“, with where the legal form is set and whether it was derived from the name — and the others below it. **Nothing is hidden**: every form is still on the page and works (and the tests that use them still find them). With an unknown legal form the order is the old one. The sections are placed once the answer is there, so none loads its figures twice.

Spec `380-tier643-formulare-nach-rechtsform.sh` (10 assertions): GmbH from the name, Freiberufler, sole trader with EÜR and with books, GmbH & Co. KG, GbR, unknown, another company's (401). Playwright `accounting-forms-tier643.spec.ts`: the order and the line for a GmbH, KSt 1 above it and Anlage N below it and still usable; no line for an unknown legal form. Still open on that page: the developer paths in its explanations and the German words in the other languages.

### Read-only mode refuses every write; a re-verification is one company's (Tier 642 — a bank statement as a bank writes it

§9 item 24, „what the three checks did not cover“: the balance sheet. Its figures agree with the hand calculation (receivables as the open amounts, the year's VAT and income taxes, the result) — and its bank line said „Kein Kontoauszug importiert“ for a company that had imported one. Following that line led to three faults in the import, each of which made it useless with a real file:

- **A CAMT.053 file to the ISO 20022 schema came out empty.** Written by hand to camt.053.001.02 as German banks send it and previewed: 0 transactions, no balances. `camt053.ts` read a format of its own — `<Bal type="CLBD">`, `<Amt>` without its `Ccy` attribute, `<Ccy>` as an element, the parties inside `<CdtTrxTxInf>` — which is what every spec wrote (they copied each other's fixture) and what no bank writes; `<Amt Ccy="EUR">` simply did not match `<Amt>`. The parser is rewritten: tags with attributes, namespace prefixes, the balance type from `<Tp><CdOrPrtry><Cd>` (PRCD is the opening balance German banks send, a DBIT balance is negative), the period from `<FrToDt>` or the balance dates, the bank from `<Svcr>`, per entry the status (a pending one is not booked), every `<Ustrd>` line and a structured creditor reference as the purpose, the party by direction (`<Dbtr>` for a credit, `<Cdtr>` for a debit, `<Pty>` of version 08), `NOTPROVIDED` is no reference, a batch entry becomes its payments when they carry amounts that add up. The old short form is still read.
- **Of a file with a block per booking day, the first day was imported.** MT940 (`:20:` per day) and CAMT (`<Stmt>` per day) both; `const stmt = parsed[0]`, with a comment that the user can upload the rest separately — from the same file. `mergeByAccount` (parsers.ts): the blocks of one account are one statement — every transaction, the first opening and the last closing balance, the period from the first day to the last. A file with several accounts is refused and names them (it imported the first and dropped the others).
- **No import recorded the statement's period**, and the balance sheet takes the bank balance from the latest statement *with* one (spec 215 writes its statement by SQL). MT940 now takes it from the dates of `:60F:` / `:62F:`, CAMT as above.

The spec's files are written from the schema and from what German bank files look like, not taken from a bank — there was none to take. **The first real file from the owner's bank is the test this still needs**; the preview (`POST /bank-statements/preview`) shows what was read before anything is stored.

Spec `379-tier642-kontoauszug-wie-von-der-bank.sh` (13 assertions; on the code before the standard file gives 0 transactions): a two-day camt.053.001.02 file previewed and imported — balances with sign, bank, period, each transaction's party, purpose and reference, the batch split, the pending entry left out, the receipt matched to its invoice at 95, the same file again refused, the same file with a namespace prefix; the balance sheet's line 1700; a two-day MT940 file; two accounts in one file. The 32 specs that touch the bank import pass with the old short form.

### Read-only mode refuses every write; a re-verification is one company's (Tier 641 — another member state's tax is not German tax; a credited sale leaves the OSS report

§9 item 24, „what the three checks did not cover“: OSS. The OSS report (Tier 78) had been checked against its own fixture, never against the UStVA of the same company. Sales of one month: two to a consumer in France (100 € at 20 %, 50 € at 5,5 %), one to a consumer in Austria (200 € at 20 %), one to a consumer at home (300 € at 19 %), an intra-EU supply to a French business (400 €), and a third French sale (80 € at 20 %) credited later.

- **The French and the Austrian tax were declared as German tax.** `GET /ustva/compute`: Kz 35 = 430,00, Kz 36 = 78,75, to pay 135,75 — where 57,00 are owed. The UStVA sorted every rate that is not 19 % or 7 % into „steuerpflichtige Umsätze zu anderen Steuersätzen“; the same 78,75 € stand in the OSS report, to be paid at the BZSt. `reports/oss-scope.ts`: a taxed amount is another member state's when the customer has no VAT id, lives in another member state, and the rate is none German law has had (19, 7; 16 and 5 in the second half of 2020). Such amounts are in no Kennzahl; the result carries them as `ossSales { net, vat }`, the UStVA page says so under its table („Nicht in dieser Voranmeldung: … wird über das OSS-Verfahren beim BZSt erklärt“). All five places that add taxed sales go through it (invoices, credit notes, advances and their settlement, the Ist-Versteuerer's payments). The filing DTO takes the field back — the page posts what it was given, and an unknown property would have refused the save.
- **A credit note was in no OSS report**, so a sale credited in full stayed in it with its tax — and its −16 € lowered the *German* tax of the month it was written in. A credit note of the quarter of its sale now lowers that sale's line (the count stays the number of sales); one for a sale of an earlier quarter is a **correction of that quarter** — `corrections[]` per member state and period, `totals.correctionsVat`, `totals.vatDue`, a block in the CSV, a table on the OSS tab — as the OSS return states them.

Not decided here, for the Steuerberater (§9 item 25): whether the net of OSS sales belongs in a Kennzahl of the UStVA at all, and the case this cannot see — a seller in the OSS whose customer's state has a rate of 19 % or 7 % too (Cyprus): such a sale is taken for German tax (Kz 81) and is in the OSS report as well. Whether the company takes part in the OSS is recorded nowhere; a switch in the settings would settle both. The UStVA PDF names the amount in its footer (added with Tier 643's commit). The bookkeeping was not looked at: the voucher made from an invoice books every sale to one revenue and one tax account, an OSS sale included (SKR03 has 8320 / 1767 for them), and the DATEV export follows it.

Spec `378-tier641-oss-nicht-in-der-ustva.sh` (13 assertions, 10 fail on the code before): the month's Kennzahlen and `ossSales`, the filing saved with the field, the OSS lines; a credit note in a later quarter — no German Kennzahl, a correction in that quarter's OSS report, the earlier quarter unchanged; credit notes in the quarter of the sale, in full and in part; the CSV; an Ist-Versteuerer. Playwright `oss-ustva-tier641.spec.ts`: the note on the UStVA page, no „20%“ row in its table, the correction row and the amount to pay on the OSS tab.

### Read-only mode refuses every write; a re-verification is one company's (Tier 640 — "today" is the German calendar day, in whatever time zone the browser is

CI run 37998673390 (Tiers 636b–637) was red in the Playwright job: 1 042 passed, 1 failed — `partial-conversion-tier615.spec.ts`, three times, waiting for the „Bearbeiten“ button of a draft written seconds before. Not the test: the invoice page offers Edit and Delete when the issue date and the present moment are the same day **in the browser's time zone** (`isSameDayDE`, which compared `getDate()` of both). The backend allows both on the German calendar day, and an issue date is stored as midnight UTC of that day. In Germany the two agree. In the CI browser (UTC) they disagree from 00:00 to 02:00 German time — the run reached the test at 00:41. In a browser in China (UTC+8) they disagree **every day from 18:00 German time on** (17:00 in winter): the buttons were gone from a draft written that afternoon, though the backend would have taken the edit.

`isToday` is now the issue date's day against `todayIso()` (lib/today.ts, Tier 554 — the German day). Two more of the same kind, found by searching for them: the expense form proposed the UTC day as the invoice date (`new Date().toISOString().slice(0, 10)`), and the books-closing card's date field had the UTC day as its `max` (between midnight and 02:00 it refused today). The year pickers that start at `new Date().getFullYear()` are off for a few hours on New Year's night at most and were left.

Playwright `today-in-germany-tier640.spec.ts` (fails on the code before, at any hour): a browser context in `Asia/Shanghai` with its clock at 21:30 UTC of the German day — half past five the next morning there — opens today's draft; Edit and Delete are there, and the edit form opens.

### Read-only mode refuses every write; a re-verification is one company's (Tier 639 — the bank statement is matched against what is open, and by the number the customer wrote

§9 item 24, „what the three checks did not cover“: the bank import. A statement written by hand — seven open invoices of two customers, eight lines (CAMT.053) — imported, suggestions generated, compared with what a bookkeeper would do:

| line | by hand | the app before |
|---|---|---|
| „Rechnung INV-…-01“, 1 190 € | invoice 1 | invoice 1 (95) ✓ |
| „INV-…-02 Teilzahlung“, 300 of 595 € | invoice 2, a part payment | nothing — not even a candidate to pick |
| „RE INV-…-03“, 250 for 238 € | invoice 3, 12 € over | nothing |
| „INV-…-04 abzgl. 2% Skonto“, 349,86 of 357 € | invoice 4, with its Skonto | nothing |
| „INV-…-05 und INV-…-06“, 595 = 119 + 476 € | both | **invoice 2** (70) — not named, its total happened to be 595 € |
| 297,50 €, no number, the other customer | invoice 7 | invoice 7 (70) ✓ |
| a refund, a debit | none | none ✓ |

`getCandidates` compared the amount with the invoice's **total** and dropped every invoice whose total differed by more than 1 €, whatever the purpose said. So with 300 € paid on invoice 2 it stayed the candidate for the next 595 €, and its remaining 295 €, when they arrived with the number on them, found nothing. Now:

- the amount is compared with what is **open** (total less payments), and with what is left of the bank entry when part of it is matched already;
- an invoice **named in the purpose** is a candidate at any amount — „part payment“ (25 points for the amount), „more than is open“ (15), „amount less 2 % Skonto“ (55 inside the Skonto window, 45 after it; this one also without the number);
- **several invoices named** whose open amounts add up to the transfer: each is a candidate with its own amount, and `suggest` writes a suggestion for each (95);
- an invoice the purpose does **not** name loses 30 points when the purpose names another open invoice, and says so („purpose names INV-…“);
- candidates carry `openAmount` and `appliedAmount`; a suggestion's `appliedAmount` is what would be booked (it was the invoice's total). The page shows „offen: …“ next to the amount when they differ.
- On confirmation the amount booked is the lesser of what is left of the entry and what is **open** on the invoice — as the method's comment always said; it was the invoice's total, so 595 € matched by hand to an invoice with 295 € open booked 595 € on it. The rest stays on the bank entry, as it already did for an unpaid invoice.

The posting itself was right wherever a match existed (Tiers 52, 422, 529): payment, voucher, the Skonto credit note split over the rates. Not changed: an amount beyond what is open stays on the bank entry and is not turned into a customer credit; the FinTS matcher (`fints.service.ts`, spec 32) is a second, separate one; the reason texts are English fragments shown as they are.

Spec `377-tier639-bankabgleich-offener-betrag.sh` (21 assertions, 15 fail on the code before): the table above as suggestions with confidence and amount; all confirmed — statuses, payment sums, the 12 € left on the entry, the Skonto credit note; a partly paid invoice (no candidate for its total, its rest found, a manual match takes what is open); the unnamed invoice 30 points lower. The 30 specs that touch the bank import pass.

### Read-only mode refuses every write; a re-verification is one company's (Tier 638 — a reminder asks for what is open; Ist-Versteuerung and dunning reconciled by hand

§9 item 24, „what the three checks did not cover“: Ist-Versteuerung and dunning. Both were set up in a fresh company and computed by hand first.

**Ist-Versteuerung — the figures agree, nothing changed.** Eight invoices over September and October 2026: one paid in two halves across the month end, one unpaid at 7 %, one with two rates half paid, an intra-EU supply, one paid with 2 % Skonto, one paid in full and then credited in part, one cancelled unpaid, one issued and paid in October; an expense with 76 € input tax. Expected and delivered by `GET /ustva/compute`: September Kz 81 1 294,00 / 245,86, Kz 86 50,00 / 3,50, Kz 41 600, input tax 76, to pay 173,36; October Kz 81 1 200,00 / 228,00. The same company switched to Soll: September 2 144,00 / 407,36 and 600,00 / 42,00, October 450,00 / 85,50. The difference between the two over both months is exactly what is unpaid.

**Dunning — the fees agree, the text around them did not.** An invoice over 1 190 €, issued on the 17th of August, due on the 31st, 190 € paid, looked at 40 days after the due date: interest 11,53 € for a business (1,52 + 9 = 10,52 %) and 7,15 € for a consumer (6,52 %), fee 5 € / 10 €, to pay 1 016,53 € — as computed by hand (Tier 421). But:

- **The e-mail's text asked for the invoice's total and misdated the invoice**: „die Rechnung … vom 31. August 2026 mit einem Betrag von EUR 1190.00“ — the due date as the invoice's date, 1 190 € where 1 000 € are open, while the PDF attached to the same e-mail says 1 000 €. `renderForInvoice` is the text of every reminder (by hand, in bulk, the nightly run). `{{totalAmount}}` is now what all three default texts used it for — the amount to pay, total less payments and credit notes — written as a German letter writes it („1.000,00“); new tokens `{{openAmount}}` (the same), `{{invoiceTotal}}`, `{{issueDateFormatted}}`. The default texts say „aus der Rechnung … vom ‹date›, fällig am ‹due date›, noch 1.000,00 EUR offen“. A stored template nobody edited (`isDefault`) is a copy of the default made on the first request and now follows it; an edited one is left alone — and gets the right amount through `{{totalAmount}}` anyway.
- **`GET /reminders/stats`** summed the totals (2 380 € overdue where 2 000 € were) and **`GET /reminders/overdue`** had the total only. Both carry what is open; the reminders page shows it, with „von 2.380,00 € Rechnungsbetrag“ underneath when the two differ. The template editor lists the new tokens.

Not changed, for the owner to know: interest is computed on what is open today for the whole time since the due date — the 190 € paid two weeks late bear none. That is less than the law allows, never more.

Spec `376-tier638-mahnung-offener-betrag.sh` (16 assertions, 11 fail on the code before): the three texts with the open amount and both dates, after a payment and after a credit note; the list and the sum; an unedited copy of an older default follows the default, an edited template stays and resolves all tokens; the reminder that is sent has that text and its Mahnung row the same amount. Playwright `reminders-open-amount-tier638.spec.ts` (fails before: „2.380,00 €“): the page's row and sum, the editor's tokens. The 39 specs that touch reminders and the static guards pass (188 fails on this machine only, as before).

### Read-only mode refuses every write; a re-verification is one company's (Tier 636b — spec 371 failed in the 95 minutes after midnight

CI run 37996473979 (Tier 636, a frontend change) was red in the backend job: 373 passed, 1 failed — `371-tier617-timer-und-stundennachweis.sh`, „stopping writes the entry: 95 minutes today“, expected 2026-10-10, got 2026-10-09. The spec moves the timer's start 95 minutes back; at 00:15 Berlin that is yesterday, and the entry is dated the day the timer started (as section 3 of the same spec says for the forgotten timer). The code is right, the expectation was a literal „today“. It reads the start's date from the table now. Reproduced at 00:20 local time (366, 370, 372, 373 pass in the same window), passes after the change. Lesson in §10.

### Read-only mode refuses every write; a re-verification is one company's (Tier 637 — a field has a name

§9 item 24: „72 form fields without a label“. The 72 were the fields with no label, placeholder or title; the count behind it is larger. Measured on the 45 dashboard pages as they load: **143 visible fields had no label** a program can find, 54 of them nothing at all. The source has 423 `<label>` elements and 24 `htmlFor`: the app writes `<label>Firmenname</label><Input />` — the word stands in front of the field and is not its label. A screen reader announces „edit text“; a click on the word does not reach the field.

- **`components/FieldLabels.tsx`**, mounted once in the root layout (like `AuthenticatedDownloads`): a label that names no field and wraps none belongs to the next field after it in the same container — the first one among its following siblings, up to the next label, that has no name of its own. The field gets an id if it has none, the label points to it. A `MutationObserver` repeats it for what appears later (a dialog, a tab, another invoice line). `aria-label`, `aria-labelledby`, a wrapping label and `htmlFor` in the source are left alone. One rule instead of 400 ids — and it is a rule about the page as rendered: a new form written the same way is covered, a form written differently (the word in a `<span>`, in a card's title) is not.
- **The fields that had no word in front of them** got an `aria-label` from an existing translation: the invoice line (article number, description, quantity, unit, unit price, VAT rate), the notes, the end of the service period, the city next to the postal code, the filters of the accounting, expenses, e-mail and webhook pages, the year of the two cost-centre pages, subject and text of the dunning templates.
- **`<html lang>`** said `en` for every page; it is `de` (the first visit, the legal pages) and `useI18n` sets the chosen language.

After: 10 fields without a label on the 45 pages, each a search or date field with a placeholder or title that says what it is; none with nothing. Not measured: every dialog and every tab of every page (the spec opens one dialog); a screen reader was not run.

Playwright `field-labels-tier637.spec.ts` (fails on the code before): the settings form's fields are found by their label and a click on the word focuses the field; the invoice form has no field without a label, its line included; the customer dialog, opened later, has none; eleven pages have no field with nothing at all; `<html lang>` follows the language. Only 27 of the 223 Playwright files can be run on this machine (the others name port 3001, another project's here) — all 27 pass; the rest is the CI run's.

### Read-only mode refuses every write; a re-verification is one company's (Tier 636 — what a click opens, a key opens too

§9 item 24: „the dashboard's cards are not reachable by keyboard“. That was the smaller half. Tried with the keyboard alone:

- **An invoice could not be written without a mouse.** The customer field of `/dashboard/invoices/create` lists its matches under the field — for the mouse: the arrow keys did nothing, Enter sent the form (without a customer), Tab left the field and the list closed 200 ms later. The same for the article number, the description (the article by name), the reference invoice of a credit note, and the product search of the inventory page. `lib/picker.ts` (`usePicker`) makes each of them a combobox: ↓/↑ move a mark through the list and round its ends, Enter takes the marked entry and does not send the form, Escape closes the list; `role="combobox"`, `aria-expanded`, `aria-activedescendant` on the field, `role="option"` / `aria-selected` on the entries, the mark is the `aria-selected:` style. Enter that ends an input method's composition (a name typed in Chinese) is not a choice. Without a marked entry Enter does what it did.
- **The dashboard's 35 cards** were `<div onClick>`. `components/ui/card.tsx`: a `Card` with an `onClick` is `role="link"`, in the tab order, opened by Enter, with a focus ring — in the component, so the next card has it too.
- **Rows that open on a click** got a link or button in their first cell (the row's click stays): a customer's invoices (the number), instalment plans and e-mails (the subject), the vouchers of the accounting page (the number), a product's name, the recovery codes of the two-factor page (each a button that copies).

Not changed: the modals close on a click on their backdrop and have their own buttons; whether each closes on Escape and keeps the focus inside was not walked.

Playwright `keyboard-tier636.spec.ts` (3 tests, all three fail on the code before): every clickable card is a link with tabindex 0, Tab reaches the next one and Enter opens it; an invoice is written with the keyboard only — the customer chosen with ↓↓↑↑↓↓ Enter among three, the article by number (Escape, then ↓ Enter) and by name, the form sent with Enter — and the saved invoice has that customer and that product; a product's name and a customer's invoice number open by Enter.

### Read-only mode refuses every write; a re-verification is one company's (Tier 635 — an index that leads with the company, on the five tables that had none

§9 item 24: „five models without an index led by `companyId`“. `User`, `CustomerPortalSession`, `VatRate`, `VatRateHistory` and `WebhookDelivery` are filtered by company (the delivery log, the VAT rates of a company, the members whose default company it is) with no index to do it by. Migration `20261009000008_company_leading_indexes` adds one each (`WebhookDelivery(companyId, attemptedAt)` and `VatRateHistory(companyId, changedAt)` for their lists by time). Small tables today — the cost of the index is nothing, and the query plan no longer depends on that staying so. Spec 339 has the check as a static assertion: a model with a `companyId` has an index, unique or id that leads with it.

**Tier 635b — CI red, and not by the commit.** Run 37992218564 failed both end-to-end jobs in their first minute, and again on a re-run: `docker run postgres:16-alpine` got „500 Internal Server Error“ and then „toomanyrequests: You have reached your unauthenticated pull rate limit“ from Docker Hub — the limit of the runner's shared address (about twenty pushes that day, each pulling twice, will not have helped). `backend/scripts/ci-pull-image.sh` now pulls the image first: from Docker Hub, three attempts, then the same official image from Amazon ECR Public (`public.ecr.aws/docker/library/…`, published by Docker) and from Google's pull-through cache (`mirror.gcr.io/library/…`), tagged with the name the run uses. Exercised locally against a stand-in `docker` that refuses Docker Hub; the real mirrors are exercised by the CI run of this commit. Spec 341's `caddy:2-alpine` already skips when it cannot be pulled.

### Read-only mode refuses every write; a re-verification is one company's (Tier 634 — the Leitweg-ID's check digits

§9 item 24: „the Leitweg-ID's check digits are not verified“. Tier 599 checked the shape — a Leitweg-ID with one digit mistyped was stored and went out as the XRechnung's BuyerReference, where the public invoice portals reject the invoice.

The check digits are ISO/IEC 7064 Mod 97-10 over the address without hyphens, letters as A = 10 … Z = 35: `98 − (address × 100 mod 97)`. Verified against published addresses before use: `04011000-1234512345-06`, `991-01484-64`, `05711-06001-79`, KoSIT's test address `991-33333TEST-33`. `common/leitweg-id.ts` (`leitwegIdProblem`, `@IsLeitwegId()`) is on the customer's `address.leitwegId`; the refusal says it is the check digits and does not say which they should be (that would turn a typo in the address into a "corrected" wrong address).

**The example used all over — `991-12345-67` — has wrong check digits** (they are 73). The form's placeholder and the message now show `04011000-1234512345-06`; specs 358 and the Playwright spec use `991-12345-73`. Specs 139, 140 and 372 write the old example by SQL (to a customer's address and to `Company.settings`) and are untouched — the generator does not re-check what is stored.

Spec 358 +5 (17 assertions): wrong check digits, one digit mistyped, two swapped → 400 with the reason; three published addresses taken, one with letters, one in lower case.

### Read-only mode refuses every write; a re-verification is one company's (Tier 633 — a number in a request is a number, or the digits for one

Tier 606's other half, named in §9 item 24 („the implicit conversion of numbers (`""` → 0) is not covered“). The ValidationPipe runs with `enableImplicitConversion`; for a property typed `number` that is `Number(value)` before any decorator sees the value. Measured:

| sent | arrived as | result before |
|---|---|---|
| `{"amount": true}` on a payment | 1 | **a payment of 1,00 € booked** |
| `{"unitPrice": true}` on an invoice line | 1 | an invoice line at 1,00 € |
| `{"basePrice": ""}` on a product | 0 | a product priced 0 |
| `{"creditLimit": "", "paymentTerms": ""}` on a customer | 0, 0 | credit limit 0 and „sofort fällig“ |

On invoices, expenses and payments an empty string was caught by the business checks („Betrag muss größer als 0 sein“) — by luck of the next rule, not by validation.

**`StrictNumber()`** (`common/strict-number.ts`) reads the value as it was sent: a number is itself; **digits in a string are the number** (forms and query strings send strings — „19“, „12.50“); **an empty string is "not given"** (an optional field stays untouched, a required one is refused); anything else — `true`, `[]`, „12abc“ — is left as it is, so `@IsNumber()` / `@IsInt()` refuse it. It stands in front of **all 141 `@IsNumber()` / `@IsInt()` in 26 files**; spec 362's static part keeps it there (as it does for `@StrictBoolean()`).

Spec 362 +11 (29 assertions): the static check; a payment of `true` / `""` / „12abc“ refused and nothing booked, of „19“ and 100 booked; an invoice line priced `true` / `false` / `[]` / `{}` refused, „12.50“ taken; an empty credit limit and payment terms leave both as they were; a product without a price refused.

**What changes for a caller:** an optional number sent as `""` no longer becomes 0 — it is ignored. To set something to 0, send 0.

### Read-only mode refuses every write; a re-verification is one company's (Tier 632 — the flags in bodies that are no validated classes; the operator's routes, called

Two more of §9 item 24's leftovers.

- **„Flags read from an untyped body“.** Eight handlers take `@Body() body: { …?: boolean }` — an inline type, which the ValidationPipe does not check, so Tier 606's `@StrictBoolean()` cannot sit on it. Read one by one: five already ask `typeof … === 'boolean'` or `=== true` (the feature flags, the dunning switch, the Anlage SO import, the OCR lookup). **Three read the flag as a truthy value**: `mockMode` of a FinTS connection („false“ → the demo bank), `dryRun` of `bulk-send-by-filter` („false“ → a dry run — the sibling route with a DTO read it as false), `verifyVat` of the customer import. All three erred to the harmless side; they now go through `strictFlag()` (`common/strict-boolean.ts`: the same spellings as `StrictBoolean`, 400 for anything else). Spec 362 +3.
- **The operator's routes**, called as the administrator of an ordinary company (47 routes under `/admin`, `/system`, `/storage`, `/signing` and the manual triggers): backups, cron health, storage configuration, notification settings and the FinTS run answer „dem Betreiber der Installation vorbehalten“; the bulk actions on errors, the VAT re-verification and the dunning run act on the caller's company only (read in the code: each names `companyId`). Nothing to fix.
- **A Kleinunternehmer** with the new documents (quote, order confirmation, delivery note, invoice from a quote, invoice from hours): every one at 0 % with the § 19 note on the PDF and in the XRechnung — nothing to fix.

### Read-only mode refuses every write; a re-verification is one company's (Tier 631 — the customer portal: one customer against another, and a customer's own record

The second check §9 item 24 named as not done. A company with customers X and Y, a second company with Z; an issued invoice and a portal session for each.

**Isolation holds.** X's session lists X's invoices; the page, the PDF and „Ich habe bezahlt“ of Y's and of Z's invoice answer 404; the profile takes no other customer's id and none of the fields a company decides (credit limit, payment terms, type, tags, number, rates).

**What it found is in `PATCH /customer-portal/profile`** — the only place where someone outside the company writes:
- **X could take Y's e-mail address** (200; two customers of one company with the same address). The address is the portal's login — `request-session` sends a link for "the customer with this address". Creating a customer has always refused a duplicate (409); changing one did not, in the portal **nor in the company's own form** (`PUT /customers/:id`, measured: 200). Both refuse it now (`customer-email.ts`: compared without regard to case, asked only when the address changes — so a customer that shares one from before can still be edited). The portal's answer does not say whose address it is.
- **A USt-IdNr. was stored as typed** — „DE000“, or „de 136 695 976“ unnormalised. The company's form checks and normalises it (Tier 490, `withCheckedVatId`); the portal now does the same.
- Looked at and left: a customer may correct its own name and address (the name printed on invoices already issued is the one snapped at issue); `address.country` is free text in both forms („Deutschland“ and „DE“ both occur) — the portal is no stricter than the company's form.

**Spec** `375-tier631-kundenportal-eigene-daten.sh` (18 assertions; 6 fail on the code before — the twelve that hold are the isolation, which is now asserted).

### Read-only mode refuses every write; a re-verification is one company's (Tiers 629–630 — the roles inside a company, called; the SMTP password at rest

„继续找和做剩下的所有问题“ (09.10.2026). The check §9 item 24 named as not done: **roles inside one company.** A company with an admin, an accountant and a viewer (two extra users granted through `UserCompany` on the throwaway database); **every one of the 508 routes called as the viewer, as the accountant and as the admin in read-only mode — 477 requests each** (auth, health and public routes aside) — and **all 45 dashboard pages opened in a browser as viewer and as accountant**.

**What it found about permissions: nothing that gets through.** Viewer and read-only mode: 214 of 220 writing routes answer 403, the other six are the reads-by-POST and self-service routes the guard lists on purpose. The accountant reaches 152 writes, none of them administration (users, company, mail configuration, webhooks, backups, signing, storage, books closing, the rounding rule, filings are all 403). `GET /mail/config` returns the password to nobody.

**What it found about what a member sees (Tier 629):**
- A refused page said „Unzureichende Berechtigung: users.read“ — on the dunning-fee settings and the error list, where `users.read` is only the name used for "admin"; `company.update` on the invoice templates and on storage. **The 403 of the roles guard and of `UsersService.requireRole` now carries `action`, `requiredRole` and the caller's `role`** (the message is unchanged — specs and the read-only mode match on it). `lib/api.ts` turns a 403 with `requiredRole` into a sentence in the UI language — „Dafür reicht Ihre Rolle in dieser Firma nicht aus — erforderlich ist die Rolle „Administrator“.“ — which every page shows, because they all show `error.message`.
- **The dashboard offered every card to everyone.** It reads the role from `GET /auth/me` (as Tier 598 reads `operator`): the audit trail, the activity log and the import take an accountant; the company's settings, invoice templates and error list an administrator. Until the role is known nothing is hidden.
- Left as it is: `GET /reports/vat` and the UStVA take an accountant while the other reports take a viewer (a viewer's reports page has one tab that stays empty); a viewer's dashboard asks for the UStVA history and gets a 403 it ignores; `/dashboard/cashbook` asks for today's daily close and gets a 404 until there is one.

**Tier 630 — the SMTP password.** The known open item (§9 item 24: „`MailConfig.smtpPassword` in plain text“), plus one found while reading the controller:
- **`MailConfig.smtpPassword` is stored sealed** — `common/secret-crypto.ts`, AES-256-GCM under the installation's existing `FINTS_PIN_ENC_KEY` (no new variable; the same "never rotate" applies, SECURITY.md), as `enc:v1:<iv>:<tag>:<ct>` in the same column. Saved sealed; opened when a mail is sent; a value that cannot be opened (no key, another key) counts as "no password" and is logged. **Passwords stored before are sealed when the backend starts** with the key, or by the next save. Without the key an installation stores it as typed, as before — `GET /mail/config` says which (`passwordEncrypted`, `encryptionAvailable`) and the settings page shows it.
- **A company without a mail configuration was given the installation's SMTP host, account name and sender** by `GET /mail/config` „as initial values for the form“ — to every member of every company (`company.read`). Only the operator gets them now; a company learns `installationSender: true | false`.

**Specs** `374-tier629-rolle-im-403-smtp-passwort.sh` (15 assertions; 11 fail on the code before — with a ts-node probe of seal / open / wrong key / no key) and Playwright `member-roles-tier629.spec.ts` (five tests: the admin's, the accountant's and the viewer's dashboard; the sentence in de / en / zh). `scratchpad/env.sh` of the local harness got the CI's fixture `FINTS_PIN_ENC_KEY`.

**Found alongside:** spec 339 (migrations = schema) failed once here with "10 differences" — Prisma's „Update available“ box, which goes to stderr and was read as part of the diff. It appears about once a day outside CI; the spec sets `PRISMA_HIDE_UPDATE_MESSAGE=1`.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 626–628 — whose rounding rule; the pauses on the entry; the report as a file

The owner's fourth „都做“ of 09.10.2026, on the three things Tiers 621–625 still named as not built. Migration `20261009000007_rounding_per_customer_and_pauses` (additive).

- **626 — a rule of the customer's and of the project's own.** `Customer.timeRoundingMinutes / timeRoundingMode` and the same two on `TimeProject`: `null` = inherit, `0` = do not round, else 5 / 6 / 10 / 15 / 30 / 60 with `up` | `nearest`. `roundingFor`: **the project's rule goes before the customer's, the customer's before the company's** — a rule of 0 ends the search like any other. A changed duration is rounded by the rule of where the entry is after the change. In the customer DTOs and form („Rundung erfasster Zeiten“), in the project form and list.
- **627 — the pauses stay on the entry.** `RunningTimer.pauseCount` counts a pause when it **ends** (resume); stopping the timer hands `pauseCount` and `pausedSeconds` to the `TimeEntry` it writes. A stop during a pause ends the work at the pause — that pause is no break in it and is not counted. The list shows „2 Pause(n) · 0:40“ under the duration; a typed entry has none.
- **628 — `GET /time-entries/report.csv`** (same parameters as the report): a BOM, semicolons, hours as decimals, a „Summe“ line that equals the report's total; named `Zeitauswertung_<grouping>_<from>_<to>.csv`. **A name that begins like a formula** (a customer called `=SUMME(A1:A9)`) is written with a leading apostrophe; one with a semicolon is quoted. Button „CSV exportieren“ on the report card.

**Spec** `373-tier626-rundung-je-kunde-pausen-export.sh` (17 assertions; 14 fail on the code before). Playwright `rounding-per-customer-pauses-export-tier626.spec.ts` (customer form → 0:37 written as 0:45 → project rule → 0:30 → a timer's pause on its row → the downloaded file's header, row and sum).

**Found alongside:** spec 370 asserted the status of a customer creation that ran inside `$( )` — a subshell, so `$STATUS` was the one of an earlier call. It creates the customer directly now. (Spec 373 stopped on the same pattern with „unbound variable“, which is how it was seen.)

### Read-only mode refuses every write; a re-verification is one company's (Tiers 621–625 — five things Tiers 614–618 had listed as "not built"

The owner's third „都做“ of 09.10.2026, on the list that closed the report on Tiers 614–620.

- **621 — in a word, how far.** `GET /invoices/:id` and every row of `GET /invoices` carry `progress: { INV?, DN? }` = `none | partial | full` for a document that can be converted (quote, order confirmation, issued invoice; not a cancelled or declined one) — computed from the same open quantities as Tier 615, for a list page with one query. The document page shows „teilweise abgerechnet“ / „abgerechnet“ and „teilweise geliefert“ / „geliefert“; the lists of quotes and order confirmations show the invoicing badge next to the status. It is a derived word, not a status: the quote's own status stays `accepted`.
- **622 — the time sheet goes out with the invoice.** `sendInvoiceByEmail` attaches `Stundennachweis_<Nr>.pdf` as a second PDF when hours were billed with the invoice — also for bulk and recurring sends; `attachTimesheet: false` leaves it out (the e-mail dialog has the checkbox, shown only for such an invoice). `EmailSend.attachmentPaths` and the response (`attachments`) name what went out.
- **623 — the timer pauses.** `RunningTimer.pausedAt` / `pausedSeconds` (migration `20261009000006_timer_pause`, additive); `POST /time-entries/timer/pause | resume`. The clock counts up to the pause and without finished pauses; a stop while paused writes the time up to the pause.
- **624 — a rounding rule.** `Company.settings.timeRounding = { minutes: 0|5|6|10|15|30|60, mode: 'up'|'nearest' }` (in the settings JSON — no column; the other keys of `settings` are kept). `GET /time-entries/settings` (everyone who reads hours), `PUT` (`company.update`). **A duration is rounded when it is written** — a new entry, a changed duration, a stopped timer — so what is stored is what is billed and what every sum shows; entries from before the rule keep their minutes. `nearest` never rounds to nothing (5 min at 15 → 15); a day stays the most.
- **625 — who worked how much.** `GET /time-entries/report?groupBy=user|customer|project&from&to` → per row and in total: entries, minutes, billable, billed and open minutes, and the value of the billed and the open hours at their rates. Employees are named by profile name or e-mail — only users of this company. The time page has the card „Auswertung“ (period, defaulting to the current month; by employee / customer / project).

**Spec** `372-tier621-fortschritt-pause-rundung-auswertung.sh` (30 assertions; 28 fail on the code before). Playwright `progress-pause-rounding-report-tier621.spec.ts` (badges on page and list, 0:37 written as 0:45, a paused clock that does not move, the report by employee and by customer, the checkbox in the e-mail dialog).

**Found alongside:** at exactly 640 px the report table made the time page 80 px wider than the screen — the rule that lets a table scroll inside its card applies below 640 px only (Tier 596). The three tables of the time page scroll in their cards at every width now. (Found by the six-width measurement of Tier 620, before the push.)

**Not built in these tiers** — a rounding rule per customer or project, the pauses on the entry and the report's export followed in Tiers 626–628.

### Read-only mode refuses every write; a re-verification is one company's (Tier 620 — the dashboard at tablet width (CI red after Tiers 614–618)

**CI run 37933441777 (commit `50006c9`) failed in one Playwright test:** `mobile-responsive-tier121` — „tablet 768x1024: dashboard renders without horizontal overflow“, body 805 px wide. Backend e2e was green (370 passed / 1 skipped), Playwright 1028 passed / 1 failed. Cause: the dashboard card added in Tier 614 is titled „Auftragsbestätigungen“ — one word, wider than a column of the three-column grid at 768 px; a grid item is at least as wide as its content, so the grid grew. I had looked at the new screens at 1280 and 390 px only, and the spec that checks 768 px hard-codes port 3001 and is not run locally. Fix: the card grid's items get `min-w-0` and its titles `overflow-wrap: anywhere`. Then every new or changed page was measured at **375, 640, 768, 820, 1024 and 1280 px in de / en / zh**: none wider than its viewport. `mobile-width-tier596.spec.ts` (runs locally) now checks the dashboard at 768, 820 and 1024 px.

### Read-only mode refuses every write; a re-verification is one company's (Tier 619 — three buttons of the invoice page that were German in every language

Walking the screens of Tiers 614–618 in Chinese and English (list, document page, the quantity dialog, time page, dashboard — no raw key, no console error, nothing wider than 390 px) showed what Tier 602 had left on the invoice page's header: „Per E-Mail senden“, „Zahlungslink anzeigen“ / „Erstelle Link...“ and „Löschen“ were literals. They are `invoicePage.sendByEmail`, `.paymentLink`, `.paymentLinkCreating` and `.delete` now; the German texts are unchanged (specs match them). `invoice-detail-languages-tier602` asserts the first in all three languages.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 616–618 — time tracking: default rates and projects, the timer, the time sheet

The other four of the owner's „都做“ of 09.10.2026 (see Tiers 614–615). One migration, `20261009000005_time_projects_and_timer` (additive).

**Tier 616 — rates and projects.**
- **`Customer.defaultHourlyRate`** (net, two decimals; `null` takes it away) — in the customer DTOs and the customer form („Standard-Stundensatz“).
- **`TimeProject`** (`/time-projects`, module `time-tracking`): a name (once per customer, case-insensitive), a customer or none (internal), a rate of its own, a budget in hours, `active`. The list returns `effectiveRate` (its own, else the customer's), `minutes` and `openMinutes` — the budget is read against them (the page turns the figure red beyond it). A project with hours is **archived**, not deleted, and its customer cannot be changed. In the audit extension (it carries a rate).
- **`TimeEntry.projectId`**: the project must be the company's and — if it has a customer — the entry's customer; an entry without a customer takes the project's. **An entry written without `hourlyRate` takes the project's rate, else the customer's default; an explicit `null` stays "not priced"; a given rate stays.** Moving an entry to another customer drops a project that belongs to the first.
- `GET /time-entries?projectId=`, `POST /time-entries/bill { customerId, projectId? }` — and the invoice line reads „TT.MM.JJJJ Projekt: Tätigkeit“.
- Customer merge takes the projects along; a customer with a project is not deleted.

**Tier 617 — the timer.** `RunningTimer`, one per user and company (`@@unique`), on the server — it survives a closed page and another device. `GET /time-entries/timer`, `POST …/timer/start { customerId?, projectId?, description? }` (a second start: 400), `POST …/timer/stop { description?, customerId?, projectId?, hourlyRate?, billable? }` → writes the entry through the same `create` as a typed one (so the same checks and the same default rate): dated the German day the timer was **started**, the elapsed time in whole minutes, **at least one, at most 24 hours** (`capped: true` when it was cut — the page says so). Without an activity at start or stop the stop is refused and the timer keeps running. `DELETE …/timer` discards it.

**Tier 618 — the Stundennachweis.** `GET /time-entries/timesheet.pdf?customerId&projectId&from&to&state` or `?invoiceId=` → a PDF (`timesheet-pdf.ts`, pdfkit, the invoice PDF's rules): company, customer, project, period; date · project (or customer) · activity · duration h:mm · hours with two decimals; sums per project and in total (the hours as the invoice lines add up); pages numbered. No prices — they are on the invoice. `GET /invoices/:id` returns `timeEntryCount`, and the invoice page shows „Stundennachweis“ when it is above zero. Response headers `X-Timesheet-Entries` / `X-Timesheet-Minutes` say what is on the sheet.

**The page `/dashboard/time`** has the timer on top of the form (start, the running clock, „Stoppen und erfassen“, „Verwerfen“; a running timer brings its customer, project and note into the form after a reload), a project select in the form and in the filter, the rate prefilled from project / customer until one is typed, a card „Projekte“ (add, archive, delete without hours, logged against budget), and „Stundennachweis (PDF)“ for what is listed.

**Specs** `370-tier616-projekte-und-stundensaetze.sh` and `371-tier617-timer-und-stundennachweis.sh`; Playwright `time-projects-timer-tier616.spec.ts` (customer form → prefilled rate → project → own rate kept → over budget → timer through a reload → both time sheets as downloads).

**Not built in these tiers** — the time sheet in the invoice e-mail, a rounding rule, the report of hours per employee and the timer's pause followed in Tiers 622–625.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 614–615 — the order confirmation; a quote invoiced and delivered in parts

On 09.10.2026 the owner answered the list of what Tiers 610–611 had deliberately not built with „都做“: order confirmation, partial invoicing of a quote, a timer, projects, per-customer default rates, a time sheet PDF. These are the first two; the time-tracking four follow.

**Tier 614 — `OC`, the Auftragsbestätigung (`AB-YYYY-NNNNNN`).** A third non-fiscal type, in `NON_FISCAL_TYPES` — so everything Tiers 610 and 612 did for a quote holds for it without a further line (the literal `['QU', 'DN']` lists in eight files became that constant). Its life: draft → `confirmed` → cancelled. It is written directly or made from a quote (the offered quote becomes `accepted`, as when it is invoiced), and becomes an invoice and a delivery note: `CONVERTIBLE = { QU: [OC, INV, DN], OC: [INV, DN], INV: [DN] }`. The PDF is the invoice layout titled „AUFTRAGSBESTÄTIGUNG“, with prices and the agreed terms — the Skonto as a term („2% Skonto bei Zahlung binnen 10 Tagen nach Rechnungsdatum“), not as dates, and without a GiroCode. E-mail text of its own (de / en / zh); sending a draft confirms it. Frontend: type chip, list `?type=OC` with its statuses, dashboard card, „Auftragsbestätigung erstellen“ on the quote. **Checked by calling** (the lesson of Tier 612): 1 194 GET requests and the 18 by-id write routes with a confirmed order — it appears in the audit log and the search, nowhere else, and nothing was written.

**Tier 615 — in parts.** Tier 610 converted "each time in full": a second click made a second invoice over everything. Now:
- **`InvoiceItem.sourceItemId`** (migration `20261009000004_invoice_item_source`, additive): each line of a converted document names the line it was taken from. What is **still open** of a line, for a target type, is its quantity minus what the lines pointing at it in documents of that type have taken — cancelled documents aside (`openQuantities`). Invoiced and delivered are counted separately.
- **`POST /invoices/:id/convert { to, items?: [{ itemId, quantity }] }`**: without `items` all that is open (so the second conversion takes the rest, and a third answers 400 „bereits alles abgerechnet“); with `items` a part — not more than is open, the line's sign, at most four decimals, no line twice, only this document's lines. One conversion at a time per source (`withKeyLock`): two clicks make one invoice.
- **`GET /invoices/:id` → `conversion: { INV: { <itemId>: open }, DN: {…}, OC: {…} }`** for a document that can be converted.
- **What comes back:** cancelling (or deleting) the invoice opens its lines again. Editing the draft changes what it has taken — the form sends each line's `sourceItemId` back, and the backend keeps it only for a line of the document's own source (a plain `POST /invoices` cannot claim a quote's line at all).
- **A discount:** a percentage applies to every part; an absolute discount is divided by the share of the net value taken (100 € off 1 000 €: 40 € off the invoice over 4 of 10, 60 € off the rest — together the quote's sum to the cent, asserted).
- **Frontend:** „In Rechnung umwandeln“ and „Lieferschein erstellen“ open a dialog with every line — on the document, still open, now — prefilled with all that is open; „Alles Offene“ / „Nichts“; nothing open → it says so and offers no button.

**Found alongside — a late answer replaced the filtered list.** The invoice list reads `?type=` and `?status=` from the URL in an effect, so the page asks twice when it opens with a filter: first without it, then with it. Nothing told the two answers apart — when the first came later, **the list of order confirmations showed the invoices** (and, since Tier 239, the dashboard's „Überfällig“ link could show every invoice under a checked „Überfällig“ chip). Seen as one flaky run of the new browser spec; made deterministic there by delaying the unfiltered request (it then failed every time), fixed by ignoring an answer once a newer question is out. The time page's list got the same guard.

**Found alongside — the edit form dropped every line's product.** `prefillFromInvoice` on the invoice form copied description, number, quantity, unit, price and VAT of each line but not `productId`: **saving a draft unchanged cut every line loose from its product**, and with it from the stock it takes when the invoice is issued (Tier 520) and from the product's usage history. Measured in the browser: `product:false` after an edit; with the fix `product:true`. Cloning keeps the product too (it did not).

**Specs** `368-tier614-auftragsbestaetigung.sh` (18 assertions; 14 fail on the code before) and `369-tier615-angebot-in-teilen.sh` (20; 19 fail): what is open; a part; eleven parts that are none; the rest; a third invoice refused; cancelling and editing; a plain invoice claiming a line; both discounts; delivery in parts from a quote and from an invoice; one confirmation; two clicks at once. Playwright `order-confirmation-tier614` and `partial-conversion-tier615` (the dialog, the edited draft's links, the rest, nothing left); `quotes-delivery-notes-tier610` goes through the dialog now.

**Not built:** (the "partially invoiced" word on the quote followed in Tier 621;) a document converted before this tier has no line links, so its quantities are not counted; an order confirmation is not tracked against the invoice made directly from its quote (QU → OC → INV and QU → INV are two paths — use one).

### Read-only mode refuses every write; a re-verification is one company's (Tier 613 — a draft quote of another day; the type of a saved document

Two things from reading Tier 610 again:
- **A quote or delivery note draft dated on another day could be edited (Tier 610) but not deleted** — the page offered „Löschen“ and the backend answered 403 „nur am Ausstellungstag“. That rule protects an invoice's number circle on the day after; a non-fiscal draft has never left the house. It is deleted on any day now (still only the last number of its circle — otherwise it is cancelled), and its number goes to the next quote. An invoice draft of another day is not deleted, as before.
- **The invoice form let the type be switched while editing** — and cleared the customer on the click. The backend never changed the type of a saved document (measured: a `PUT` with another `type` returns 200 and keeps type and number), so the form pretended. In edit mode the other types are disabled now; the chosen one carries `aria-pressed`.

Spec 365 +5 (40 assertions): the old draft changed, not turned into an invoice by an edit, deleted, its number reused, the invoice draft kept. Playwright `quotes-delivery-notes-tier610` checks the disabled types on the edit form.

### Read-only mode refuses every write; a re-verification is one company's (Tier 612 — a quote is not booked, not dunned and not the customer's bill

Tier 610's check that no *figure* moves compared reports. This is the other half: every write route that names an invoice was called with an offered quote and a delivered delivery note (18 routes), and every GET route of a company holding both was searched for them (1 194 requests). The first scan of the code for untyped invoice queries had missed these — it treated any query mentioning `invoiceNumber` or `type: true` (a select) as filtered, and did not look at `findFirst` at all. **Lesson (§10): a new document type is checked by calling the routes, not by reading the queries.**

- **`POST /accounting/vouchers/generate/:invoiceId` never asked what it was booking.** It booked 1400 an 4200 / 2200 for the quote and the delivery note — and, long before Tier 610, for a **draft**, a **cancelled** invoice and a **Proforma** (201 each, measured). It now books issued sales documents only (`SALES_TYPES`, `ISSUED_STATUSES`); the message says which of the two is missing. A **credit note** was booked with a negative Soll and Haben (−59,50 / −50,00 / −9,50) — it is now the reversed booking with positive amounts („Gutschrift CN-…“). The frontend does not call this route; it exists for API use.
- **`POST /mahnungspausen`** with a quote's id created a dunning pause → 400.
- **`GET /reminders/:invoiceId/email-data`**: a reminder text for a quote → 400. And, for any invoice, a missing or unknown `level` answered **500** → 400.
- **`GET /customers/:id/summary`**: `lastInvoice` was the newest document of any type → the newest that is not a quote or delivery note. The template preview's "latest invoice" likewise.
- **The customer portal** (`/customer-portal/*`, the customer's own login): listed the quote and the delivery note among the invoices, opened their page and PDF, and **accepted „Ich habe bezahlt“ for a quote** (201 — a payment notice on a document that takes no payment). All four queries exclude the non-fiscal types now; by id they answer 404.

Looked at and left: the audit log shows quotes and delivery notes (it should); the global search finds them by number (it should); bulk e-mail by explicit ids sends a quote with the quote's text (Tier 610); a reminder, an instalment plan, a cashbook receipt and a payment on a quote were already refused by their status or by Tier 610.

**Spec** `367-tier612-angebot-wird-nicht-gebucht.sh` (16 assertions; 9 fail on the code before): the five documents that are not booked, the invoice's and the credit note's voucher lines, no negative line; pause and reminder text; the summary; the portal's list and the three by-id routes.

### Read-only mode refuses every write; a re-verification is one company's (Tier 611 — time tracking (Zeiterfassung)

The last of the four things the owner asked for on 09.10.2026 (§9 item 24). Hours worked had no place in the system; the invoice lines of a freelancer or an agency were typed by hand.

**`TimeEntry`** (migration `20261009000003_time_entries`, additive): a day, a duration in minutes (1–1440), a description — with or without a customer, an hourly rate (net, two decimals) and the flag „abrechenbar“. `invoiceId` is set once the entry is billed. Module `backend/src/modules/time-tracking/`:
- `GET /time-entries?customerId&from&to&state=open|billed|all` → the entries (newest first) and `summary { minutes, openBillableMinutes, openAmount }`;
- `POST` / `PUT /:id` / `DELETE /:id` — the body is checked by hand, strictly (a number is a number, a boolean a boolean; no day in the future; another company's customer is refused). **A billed entry is neither changed nor deleted**;
- **`POST /time-entries/bill { customerId, entryIds? }`** → an **invoice draft dated today, one line per entry**: „TT.MM.JJJJ Tätigkeit“, the hours, unit `Std`, the rate. With `entryIds` exactly those (each must be open, billable, this customer's and priced — else 400 and nothing invoiced); without, every such entry, and the ones without a rate stay open (`skipped`). One billing at a time per customer (`withKeyLock`): two clicks at once make one invoice, the second gets 400.
- **Opening again:** deleting the draft opens its entries (the FK is `ON DELETE SET NULL`); so does cancelling the invoice — draft or issued (`invoice.service.ts`, next to the status update). Note the existing rule that only the *last* invoice of today can be deleted: an older draft is cancelled instead, with the same effect on the hours.
- Reads need `invoice.read`, writes `invoice.write` — no new permission. `TimeEntry` is in the audit extension (it carries money). Merging two customers takes the hours along, and the merge preview and result count them (`timeEntries`, Tier 611b); a customer with hours on record is not deleted (archived instead), like one with invoices.

**How an hour is billed:** as hours with two decimals, times the rate — 50 min → 0,83 Std × 90 € = 74,70 € (not 75,00 €). The page, the summary and the invoice line compute the same way (`hoursOf` / `amountOf`), so what the page announces is what the draft shows. The VAT of the lines is the invoice's business: the draft is created through `InvoiceService.create`, which applies the company's and the customer's VAT treatment.

**Frontend** `/dashboard/time` (dashboard card „Zeiterfassung“): the form (duration as `1:30`, `1,5` or `50m`; after saving it keeps day, customer and rate for the next entry), a filter by customer and by open / billed / all, the sums, the list with edit and delete for open entries and the invoice number for billed ones, and — with a customer chosen — „N offene Einträge abrechnen (Betrag)“, which opens the draft. Namespace `time` in de / en / zh. Looked at on 1280 and 390 px: no overflow.

**Spec** `366-tier611-zeiterfassung.sh` (27 assertions; all but the fixture fail on the old code — there was no route): fourteen entries that are none; list and sums; change, delete; another company sees, changes, deletes and bills nothing; the three refused billings; the draft's lines to the cent; billed entries locked; two billings at once; reopening by deleting the draft, by cancelling an issued invoice and by cancelling a draft that is no longer the last; the customer that cannot be deleted; the audit rows. Playwright `time-tracking-tier611.spec.ts`: card → page → two entries → edit → sums → bill → the draft → billed list → English.

**Not built in this tier** — timer, projects, default rates and the time sheet followed in Tiers 616–618; still not built: a report of hours per employee (`userId` is stored), a rounding rule (e.g. to quarter hours). Lines removed from the draft by hand leave their entries marked as billed with that invoice.

**For the owner's dev database:** now three additive migrations of 09.10.2026 wait for the next `start.sh` (`…000001_books_closed_until`, `…000002_invoice_source_document`, `…000003_time_entries`).

### Read-only mode refuses every write; a re-verification is one company's (Tier 610 — quotes (Angebote) and delivery notes (Lieferscheine)

The second and third of the four things the owner asked for on 09.10.2026 (§9 item 24). There was the invoice, the credit note, the Proforma and the receipt — no quote before the order, no delivery note with the goods.

**Two document types in the `Invoice` table: `QU` (numbers `AN-YYYY-NNNNNN`) and `DN` (`LS-…`)**, each with its own number circle — the invoice numbers are untouched. They are **non-fiscal** (`document-scope.ts`: `NON_FISCAL_TYPES`, `isNonFiscal`); the reports select by allow-list (`SALES_TYPES`, `CLAIM_TYPES`), so neither type was in a figure to begin with. What had no type filter got one:
- **a life of their own** (`NON_FISCAL_TRANSITIONS`): quote draft → `offered` → `accepted` | `declined`, delivery note draft → `delivered`, both → `cancelled`. `sent` / `paid` / `overdue` do not exist for them, and an invoice cannot be `offered`. None of the invoice's issuing rules apply (period lock, § 14 details, books closing) — a quote is no booking; a draft of either can be edited on any day;
- **nothing an invoice has**: payment, credit note, XRechnung (both routes — the older `GET …/xrechnung` had no guard and answered 200 with an invoice XML of the quote, found while measuring), ZUGFeRD, validation, GiroCode and payment link answer 400; `…/pdf` always gives the plain PDF; GoBD export, GoBD archive, DATEV document images and the stock movements leave them out;
- **the PDF** (`invoice-pdf.service.ts`): title „ANGEBOT“ / „LIEFERSCHEIN“, the quote with „Dieses Angebot ist gültig bis …“ (its `dueDate`) and without a Leistungsdatum; the delivery note with „Lieferdatum“, **without prices, VAT and totals**; neither with payment terms, Skonto or GiroCode. Both read (rendered and looked at);
- **by e-mail**: a draft goes out as `offered` / `delivered` (it was set to `sent`, which a quote cannot be), with a text of its own in de / en / zh (the invoice text asked the customer to pay the quote by its validity date);
- **the list**: `GET /invoices` without `type` is the list of invoices — quotes and delivery notes are listed with `type=QU` / `type=DN`. Everything built on that list (CSV export, bulk send, the customer's document count, the dashboard's recent activity) stays about invoices.

**`POST /invoices/:id/convert {to}`** (`invoice.write`): quote → invoice (the offered quote becomes `accepted`), quote → delivery note, issued invoice → delivery note. The new document is a draft dated today with the same customer, lines and — for an invoice — discount, Skonto and VAT treatment; `Invoice.sourceDocumentId` (migration `20261009000002_invoice_source_document`, additive) links it back, and `GET /invoices/:id` returns `sourceDocument` and `derivedDocuments`. Not: delivery note → invoice, anything → quote, a cancelled or declined document, a draft invoice.

**Frontend.** Dashboard cards „Angebote“ / „Lieferscheine“ → `/dashboard/invoices?type=QU|DN`: the list with its own title, „Neues Angebot“, and the statuses of that type as filter chips. The invoice form takes both types (`?type=` presets it; „Gültig für“ instead of „Zahlungsbedingungen“) and opens the new document's page after saving. The detail page shows a type badge, the statuses of the type, „In Rechnung umwandeln“ / „Lieferschein erstellen“, links to the source and to what was made from it, „Gültig bis“ — and hides the e-invoice buttons, GiroCode, payment link, PDF signature, payments and instalments. Namespace `docs` in de / en / zh.

**Found alongside, fixed here:**
- **`GET /reports/customers` counted every document of a customer** — no status and no type filter, unlike its three siblings in the same file: a draft, a cancelled invoice and a Proforma were "pending" (measured with a quote: 3,57 Mio. € of open claims nobody owed). And a paid invoice *replaced* the customer's paid sum by its own total instead of adding to it (two paid invoices of 3 272 € showed 1 190 € paid). It now counts issued sales documents (`paid`, `sent`, `overdue` of `SALES_TYPES`), sums in Decimal, rounds to the cent.
- **„Zeige {shown} von {total} 2 / 2“** under the invoice list: the translation's placeholders were never filled. Now „Zeige 2 von 2“.

**Spec** `365-tier610-angebot-und-lieferschein.sh` (35 assertions, 40 since Tier 613; 29 fail on the old code): number circles; every allowed and refused status; the nine things refused; both PDFs plain; the three conversions, the four refused ones and another company's 404; **UStVA, aging, P&L, dashboard, customer report, reminders, EÜR, DATEV preview, invoice list and customer list byte-identical before and after a quote and a delivery note over 1 190 000 €**; e-mail status and text; the customer report's five figures. Playwright `quotes-delivery-notes-tier610.spec.ts`: dashboard card → list → form → quote page → offered → invoice → back (accepted, lists the invoice) → delivery note → lists by type → Chinese.

**Decisions taken (the owner may reverse them):**
- A delivery note moves **no stock** — the invoice does (Tier 520), and both moving it would count a delivery twice. A company that delivers before it invoices sees the stock fall only with the invoice.
- A quote's validity is its `dueDate`; there is no automatic "expired" status.
- ~~No order confirmation and no partial invoicing~~ — built in Tiers 614–615.
- The footer text of the PDF template („Vielen Dank für Ihren Auftrag.“) is the company's and prints on a quote as well.

**For the owner's dev database:** the two additive migrations of 09.10.2026 (`20261009000001_books_closed_until`, `20261009000002_invoice_source_document`) are applied by the next `start.sh` (`prisma migrate deploy`) — not by this session.

### Read-only mode refuses every write; a re-verification is one company's (Tier 609 — closing the books (Festschreibung)

The first of four things the owner asked for on 09.10.2026 („都做“: quotes, delivery notes, time tracking, closing of the books — §9 item 24). A submitted UStVA locked the documents of its period (Tier 537); nothing locked a manual voucher and nothing closed a year.

**`Company.booksClosedUntil`** (a date; migration `20261009000001_books_closed_until`, additive). Up to and including that day nothing is written, changed or deleted:
- everything that already asked `assertPeriodOpen` — invoices (issue, change, cancel, delete), credit notes, expenses (create, change, delete, e-invoice import, CSV import), cashbook entries, bank bookings — because `assertPeriodOpen` now asks `assertBooksOpen` first;
- **payments**, whatever the taxation (they were checked only under Ist-Versteuerung, where they move VAT): a receipt is a booking of its day;
- **manual vouchers**: create, the corrected voucher of a correction, the voucher generated from an invoice. A **Storno is dated today** and therefore goes through — that is how a closed period is corrected;
- the **depreciation bookings**: annual (31.12.), monthly (each month end) and their Storno. These ask only `assertBooksOpen`, not the UStVA lock — depreciation has no VAT, and it is booked after December's return is in.
The message names the day and both ways out (a correction in the open period, or lifting the closing).

**`GET / PUT /accounting/books-closing`** (`accounting.read` / `company.update`): a later day closes more; an earlier day or `null` lifts the closing and needs a `reason`; not beyond today. Both are written to the company's audit log (`books.closed` / `books.reopened`, with the previous day and the reason), next to the automatic `company.updated` row. On the accounting page a card „Bücher abschließen (Festschreibung)“ shows the state, closes, and lifts with a reason; texts in three languages.

**Spec** `364-tier609-buecher-abschliessen.sh` (29 assertions): what is refused in closed March — voucher, the closing day itself, expense create / change / delete, issuing a draft, cancelling, a payment, a correction dated into March, the depreciation of the year before; what works in April; a Storno and a credit note dated today; another company unaffected and unable to lift it; lifting without and with a reason; the audit rows. Playwright `books-closing-tier609.spec.ts`. *Not done:* no automatic closing (e.g. "close each month on the 10th"); the closing does not freeze master data (customers, accounts); `Mahnung` rows and customer-credit movements do not ask it. **The owner's development database gets the column the next time `start.sh` runs (`prisma migrate deploy`) — it was not touched.**

### Read-only mode refuses every write; a re-verification is one company's (Tier 608 — the error page without the operator's part

Tier 598's "left": `/dashboard/system-errors` is a company's own page (it lists the company's errors, Tier 550), but it asked for the operator's notification channels and alert threshold as every company — two 403s — and, on the 403, showed the threshold form with default values: a form a company could fill in and never save. The page asks `GET /auth/me` first and loads and shows those two cards for the operator only. The Playwright spec of Tier 598 now also opens the error page as another company: no 403, no threshold form, no test-notification button.

### Read-only mode refuses every write; a re-verification is one company's (Tier 607 — the environment variables are documented; three small things

- **Eleven variables read in `backend/src` were named in no `.env.example`** (§9 item 23). `backend/.env.example` now has `STORAGE_PATH`, `BACKUP_ROOT` (with the warning that a test backend must point it at scratch), `BACKUP_DOCKER_CONTAINER`, `HTTP_KEEPALIVE_TIMEOUT_MS` (it has to stay above the proxy's 30 s) and `DISABLE_VAT_REVERIFY_EMAIL`, and a block „Test switches — never in production“ for `THROTTLE_DISABLED`, `EXCHANGE_RATES_MOCK` and `ALLOW_HEADER_AUTH`. **Spec** `363-tier607-umgebungsvariablen-dokumentiert.sh` — static: every `process.env.X` in the backend source needs a line in `backend/.env.example` or `infra/prod/.env.example`, or a place in a short list of what the platform sets (NODE_ENV, PORT, HOME, JAVA_HOME, PG_CONTAINER, TZ, CI). Looked at on the way and found in order: the image sets `STORAGE_PATH=/data/invoice-system` (the volume), and the in-app backup job skips itself in the container (Tier 558).
- **`GET /reports/pnl` returned float differences** (`2642.8599999999997`): the monthly result and the year's sums are rounded to the cent (two assertions added to spec 354).
- **The dashboard's chart drew a bar of negative height** for a month whose total is negative (a credit note on its own): an SVG error in the console. Such a month gets no bar.
- **„KSt-Korrekturen (): 8“** on the accounting page: the label lost its bracket's content but not the bracket.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 605–606 — a supplier invoice entered by hand, with § 13b; the string "false" was read as true

**Tier 605 — „+ Eingangsrechnung“.** The expenses page could scan a receipt, read an e-invoice and import a CSV; it had no way to simply enter a supplier invoice — for that one went to the UStVA page. And neither place's edit form on the expenses page could say "§ 13b" or "innergemeinschaftlicher Erwerb" (seen in the month's reconciliation). `ExpenseEditForm` has a create mode now and a field „Steuerliche Behandlung“ (Vorsteuer laut Rechnung / § 13b / innergemeinschaftlicher Erwerb) in both modes: with one of the two the rate and the VAT lines disappear and the invoice is stored without VAT; the UStVA computes it. `POST /expenses` accepts `isReverseCharge` / `isIntraEU` — the service had handled them all along, the DTO refused the properties. **Spec** `361-tier605-eingangsrechnung-von-hand.sh` (9 assertions: both flags at creation with the UStVA's Kennzahlen 84 / 85 / 67 and 89 / 61, VAT lines with § 13b refused *for that reason*, an ordinary expense unchanged); Playwright `expense-create-tier605.spec.ts`.

**Tier 606 — a boolean in a request.** Writing spec 361's "a flag that is not a boolean: 400" gave 201 — and the expense was a § 13b one. The ValidationPipe runs with `enableImplicitConversion`; for a property typed `boolean` that is `Boolean(value)`, applied before any decorator sees the value: **every non-empty string and every number but 0 was `true`**. Measured: `{"taxExempt":"false"}` → a tax-exempt customer; `{"creditNote":"false"}` → a credit note with negative amounts; `{"isReverseCharge":"vielleicht"}` → § 13b. The handful of `@Transform(({ value }) => typeof value === "string" ? …)` decorators that were meant to parse strings never saw one. The application's own pages send real booleans, so nothing on screen was wrong; an integration posting strings got the opposite of what it sent. **Fixed in one place:** `common/strict-boolean.ts` — `@StrictBoolean()` reads the value as sent (`obj[key]`): true / "true" / "1" / 1 and false / "false" / "0" / 0 are what they say, anything else is handed on so that `@IsBoolean()` refuses it — on all 37 `@IsBoolean()` properties in 14 DTO files (the ineffective transforms removed). **Spec** `362-tier606-boolean-ist-boolean.sh`: static — every `@IsBoolean()` has `@StrictBoolean()` in front of it, so a new one cannot forget — and measured on three routes (14 assertions). The whole backend suite was run locally against the change. *Not covered:* handlers that read a flag from an untyped body (`body.mockMode`, `body.dryRun` …) do their own comparison; numbers have the same implicit conversion (`"abc"` → NaN is refused by `@IsNumber()`, `""` → 0 is not).

### Read-only mode refuses every write; a re-verification is one company's (Tier 604 — the Impressum shows the operator's own details

§9 item 23: `/impressum` had a made-up provider — „Musterstraße 1, 12345 Musterstadt“, `info@example.com`, „+49 (0) 000 000000“, the product name as the company — and a comment asking the operator to edit the source before going live ("via a deployment-time template (.env → Company settings)" — there was no such mechanism). Published like that it would have been a wrong Impressum.

**Now** the page shows the operator's own data. The operator is the installation's oldest company (`SystemAdminGuard`), and what it enters under Einstellungen → Firmeninformationen is what § 5 DDG wants published. `GET /companies/imprint` — **public**, added to spec 176's reviewed list — returns twelve fields of that company and nothing else: name (the legal name, else the name), street, postal code, city, country, e-mail, phone, website, register entry, managing director, VAT ID, and `configured` (name, street, city and e-mail present). The page renders them; where the essentials are missing it says so in a notice instead of inventing something; register entry and managing director appear when entered; the heading quotes § 5 DDG (the TMG was replaced in 2024). `HETZNER-DEPLOY.md` §7a tells the operator to complete the company's details after registering and to look at the page.

**Spec** `360-tier604-impressum-vom-betreiber.sh` (10 assertions: public, the exact fields, no tax number / bank details / ids, the values are the oldest company's, a newer company's details never appear, `/companies/<id>` still wants a session, no placeholder left in the page's markup); Playwright `impressum-operator-tier604.spec.ts`; the existing `legal-pages-tier170.spec.ts` still passes. *Not done:* `/datenschutz` is still a generic text that refers to the Impressum for the controller — an operator who hosts this for customers needs its own privacy policy and a processing agreement (Art. 28 GDPR); that is a legal text, not code. The product name and the dispute / liability paragraphs stay as they were.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 602–603 — the invoice page in three languages; the phone-width rules hold with other fonts

**Tier 602 — `/dashboard/invoices/[id]`.** A count of German words per page in the Chinese walk (`walk.js … zh`, now counting over the whole page) put the invoice page second after the reports page among the screens used daily: 69 texts without a key — the section headings, the line items' column heads, the totals, the download buttons, the payment form and its methods, the e-mail dialog. They are 68 keys in a new namespace `invoicePage`, in three languages, the German wording unchanged. Playwright `invoice-detail-languages-tier602.spec.ts`. *What the count leaves:* `/dashboard/accounting` with about 730 German words of 7 000 — the lines of the tax forms, largely official terms that come from the backend; the UStVA page's Kennzahl labels (the form's own wording); `/dashboard/v2`.

**Tier 603 — the phone-width test failed on CI, and the fix for it broke 23 pages until measured.** Run 37841024287: `mobile-width-tier596.spec.ts` failed, „/dashboard/invoices/create +12px“ — on the developer's Mac the same row had 5 px to spare; the CI machine's fonts are wider. A grid cell is as wide as its content unless told otherwise, and the notes column held a row (label, template select, buttons) that did not wrap. So: grid cells and inputs inside a flex row may shrink below 640 px, any `flex justify-between` row wraps (not only `items-center` ones — the scheduler and backup pages use `items-start`), headings break inside a word if they must, and a row of buttons wraps. **That last rule, as first written (`.flex:has(> button)`), matched `<body>`** — a flex *column* with the search button as a child — and a wrapping column lays its children out at their content width: 23 pages were suddenly up to 1 337 px too wide. Seen only because all 64 pages were measured again after the change; the rule now excludes columns. **Measured at 350 px** (40 px narrower than the test's phone, as a margin for fonts): 1 of 64 pages over, by 12 px (`/dashboard/accounting`); at 390 px none. The lesson is in §10.

### Read-only mode refuses every write; a re-verification is one company's (Tier 601 — the reports page speaks the chosen language

The page walk had `/dashboard/reports` as "German in every language". 116 texts on `reports/page.tsx` had no translation key — headings, tab names, table columns, the DATEV export's labels and button tooltips, month and quarter names — and its main component did not even call `useI18n`. They are 96 keys in a new namespace `reports` now, in German (the wording unchanged, so nothing that reads the German page sees a difference), English and Chinese; month names in the tables follow the language as well. Looked at in all three: no German left in the Chinese and English header, tabs and first tables, no raw key anywhere. Playwright `reports-languages-tier601.spec.ts`. *Still German in the other languages:* the tab „GuV (P&L)“, the activity page's action names, the reminder and note templates (texts the customer receives — arguably right), parts of the invoice detail and import pages.

### Read-only mode refuses every write; a re-verification is one company's (Tier 600 — a recurring run that does not commit gives its number back

Tier 585's "not changed": the recurring run takes its invoice number inside its own transaction, and a sequence does not roll back with it. A run that failed after that point left a hole. `runOne` now remembers the number it took and, when the transaction does not commit, hands it back (`releaseInvoiceNumber`, which steps back only while the number is still the newest). **Spec** `359-tier600-serienrechnung-gibt-nummer-zurueck.sh` makes such a failure happen: the run record of the next period is inserted beforehand — what a second server would have written, and the case the `@@unique([recurringInvoiceId, periodStart])` exists for — so the run creates its invoice, hits P2002 on the run record and rolls back. On the old code the next successful run got 000003; now 000002, and an invoice made by hand continues with 000003.

### Read-only mode refuses every write; a re-verification is one company's (Tier 599 — a public-sector customer's Leitweg-ID can be entered

§9 item 23 had it as "to confirm"; confirmed and closed. XRechnung's BuyerReference (BT-10) is the authority's Leitweg-ID. `transformToXRechnungData` has read `customer.address.leitwegId` since Tier 115 — and nothing could put it there: `CustomerAddressDto` knew four properties and the pipe refused the fifth („address.property leitwegId should not exist“), no form had a field (the translations `leitwegId.*` existed in all three languages, unused), and specs 139 / 140 wrote it with SQL. Through the product, an invoice to a public authority carried the customer's **name** as its buyer reference — formally an XRechnung, and not routable by the authority's portal.

**Now:** `address.leitwegId` is accepted (Grobadresse of 2–12 digits, an optional Feinadresse, two check digits; an empty value clears it; anything else is a 400 that says what a Leitweg-ID looks like), and the customer form has the field under the country, with the two explanatory lines that were waiting in the translations. The form sends the whole address, so it had to carry the value — otherwise every edit would have dropped it. **Spec** `358-tier599-leitweg-id-am-kunden.sh` (11 assertions: created, returned, in the XRechnung, changed, removed with the fallback to the name, four wrong values); Playwright `customer-leitweg-id-tier599.spec.ts`. *Not done:* the check digits are not verified (modulus 97-10 — the format is checked, not the arithmetic); no per-invoice buyer reference (an order number of the customer), which `transformToXRechnungData` would also read from `invoice.buyerReference` — the Invoice table has no such column.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 597–598 — a company's own row is in its own audit trail; the operator's pages are offered to the operator only

**Tier 597 — the Company row belongs to its company.** The audit extension takes a row's company from the request, else from the row's `companyId` (Tier 407). A row of the `Company` table has no `companyId` — it *is* the company — so one written without a request context (at registration, by a job) went onto the company-less chain: 2 694 `company.created` and 5 311 `company.updated` rows in the test database, each invisible to its company and, since Tier 589, to everyone but the operator. For `Company` the row's own id is used now. Measured on a fresh registration: `company.created` carries the company, appears in its audit log, and its chain verifies (2 rows, ok). **A correction to the note under Tier 589:** it said a company cannot see changes to its own master data — changes made by a signed-in user always carried the company (1 902 such rows); what was missing was the creation and the context-less updates. Spec 196 gained two assertions; spec 353's CSV assertion now expects B's own company row and nobody else's.

**Tier 598 — „Systemzustand“ and „Backups“ on every company's dashboard.** Both pages answer all but the operator with „Diese Funktion ist dem Betreiber der Installation vorbehalten“ (Tier 548); the cards that lead there were shown to everyone. `GET /auth/me` returns `operator` (the function behind `SystemAdminGuard`), the dashboard asks once and shows the two cards only to the operator. Loading the dashboard as another company no longer produces a 403. Spec 333 gained two assertions (`operator` false for a new company's admin, true for the operator); Playwright `operator-cards-tier598.spec.ts`. *Left:* „Systemfehler“ stays for everyone — a company sees its own errors there (Tier 550); only its notification settings are the operator's, and that part of the page still asks and gets 403.

### Read-only mode refuses every write; a re-verification is one company's (Tier 596 — no page is wider than a phone

The page walk (Tiers 589–590) had found 21 of 64 pages wider than a 390 px screen — the whole page scrolled sideways, by up to 543 px. Looked at element by element (`$S/review/ui/wide.js` names the outermost element that sticks out): on 17 of them it was the page header, a row `flex items-center justify-between` with the title on the left and a group of buttons on the right that never wraps; on the rest the invoice-type buttons on „Rechnung erstellen“, the filter row of the error list, the status chips of the scheduler page, and two tables (cashbook days, users).

**Fixed in one place:** `globals.css`, below 640 px only — a `flex items-center justify-between` row and the flex group inside it may wrap, and the parent of a table scrolls sideways itself. Plus `flex-wrap` on the two rows that are not of that shape. Nothing changes from 640 px upwards (the suite runs at desktop width). **Measured again over all 64 pages at 390 × 844: one page left, by 2 px** (`/dashboard/system-health`); no page blank, no errors. Screenshots of the reminders page, invoice creation and the cashbook looked at: the buttons wrap under the title, the forms are full width.

Playwright `mobile-width-tier596.spec.ts`: the twelve worst pages at 390 px must not be wider than the screen. **Not done:** tables still scroll sideways inside their box rather than becoming cards; touch-target sizes; a real device.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 594–595 — DISABLE_CRON switches off every scheduled job; the reminders page's amounts; the UStVA table's sum row

**Tier 594 — `DISABLE_CRON=1` means all ten jobs.** §9 item 22 / 23: `start.sh` tells the developer „To start without them: DISABLE_CRON=1 ./start.sh“; four of the ten scheduled jobs did not look at the variable — the webhook retry worker (every minute), the FinTS sync (every four hours), the ECB rate refresh (02:00) and the AfA auto-booker (the 1st of a month, 00:05), which writes depreciation into the books of every company that has not opted out. On the owner's development database (data up to 5 September) that last one would have booked on the next 1st with the application running, whatever the switch said. All four test the variable first now, like the other six. A manual run from the operator's page goes through the same method and is skipped as well — as it already was for the six. **Spec** `357-tier594-disable-cron-alle-jobs.sh` — static, like 176 / 177: every method under a `@Cron` / `@Interval` decorator must test `DISABLE_CRON` as its first statement (fails on the old code, naming the four); a new job that forgets it fails CI.

**Tier 595 — two things from the page walk.**
- `/dashboard/reminders`: amounts as `€2110.50` → `2.110,50 €`; the overdue line read „Fällig seit: Überfällig seit“ (the text has no `{days}` placeholder, and the key for one day does not exist) → „Überfällig seit: 32 Tage“.
- `/dashboard/accounting/ustva`: the Σ row under „Steuerpflichtige Umsätze“ added the two bases (19 % + 7 %) but showed `data.umsatzsteuer` — the whole output VAT including § 13b and intra-community acquisitions — as their tax, so the row did not add up (August of the reconciliation: 277,40 + 41,30 against 423,20). It is the sum of the table's rows now; the total stays on the card above.
Playwright `reminders-ustva-tier595.spec.ts` (reads `E2E_API_URL`).

### Read-only mode refuses every write; a re-verification is one company's (Tier 593 — a not-found is not an error event; an unknown bank code is a 400

The two small things seen in the cross-company test (Tier 592), asked for by the owner on 08.10.2026 („好，把那两个小问题也修了“).

**1. A 404 was stored as an "unhandled" error.** Prisma's P2025 has been answered 404 since Tier 378; the filter's rule for *storing* was still `!isHttp || status >= 500` — and a P2025 is not an HttpException. Every PUT / DELETE with an id that is not the caller's (`/webhooks/:id` is the plain case: its update is scoped `where: { id, companyId }`) left an ErrorEvent with the Prisma stack trace (without a company — so on the operator's error page, and counted towards the operator's notifications), an `errorevent.created` row in the caller's audit log, and a line at ERROR level in the server log: 28 such events in the test database. Now such a request is stored nowhere and logged as a warning; everything else that is not an HttpException is stored as before.

**2. `POST /fints/connections` with a bank code the server has no address for** threw a plain `Error` — 500 „Internal server error“, an error event, a notification to the operator. It is a 400 with the sentence that was meant for the user („Keine FinTS-URL für BLZ … bekannt. Bitte die FinTS-Adresse der Bank manuell eingeben.“). **A correction to Tier 592's note:** the 500 seen there was this, not a missing `FINTS_PIN_ENC_KEY` — the missing key has had its own clear 400 since Tier 568.

**Spec** `356-tier593-nicht-gefunden-ist-kein-fehlerereignis.sh` (9 assertions).

### Read-only mode refuses every write; a re-verification is one company's (Tier 592 — the cross-company test, redone: every route with another company's ids, and ids in request bodies; the bulk download named another company's invoices

Asked for by the owner on 08.10.2026 („好，做跨公司越权复测“), after the page walk had run into the activity-log leak (Tier 589) that the earlier sweeps had missed — they only tried GET routes *with* a path parameter.

**What was done** (scripts and results in `$S/review/xt/`; the throwaway backend only):
1. **Company A** — the company of the reconciliation — was given a record of 39 kinds (customers, invoices, credit notes, payments, expenses with VAT lines, supplier, product, recurring invoice, webhook and a delivery, asset, accounts, voucher, voucher template, cashbook entry and daily close, bank statement with transactions, reminder (Mahnung), dunning pauses, instalment plan, SEPA mandate, attachment, invoice template, note templates, internal notes, cost-centre budget, UStVA filing and payment, invitation, portal session, payment link, signing key): 224 ids.
2. **The sweep** (`xt.py`): the 484 routes the backend maps (from its start-up log), as a freshly registered **company B** with admin rights — every GET, and every POST / PUT / PATCH / DELETE that has a path parameter (operator, auth and system-wide routes left out), each path parameter filled with up to 14 of A's ids of the matching table, each request once with `companyId=B` and once with `companyId=A`: **2 198 requests**. A response counts as a leak if it is 2xx and contains any of A's 224 ids or A's marker text. Before and after, the number and an md5 of A's rows in every table with a `companyId` were compared.
3. **A positive control**: the same GET requests as A itself. Of the 74 GET routes with a path parameter, **48 answer A with data** — for those the refusal to B is proven against a live target. The other 26 were asked but had nothing to return even for A (an empty list, a missing query parameter, or a record kind without a fixture: adviser notes, FinTS connections, payment and direct-debit batches, the portal token, the logo file).
4. **Ids in bodies** (`xt2.py`): 33 requests in which B sends A's ids inside the JSON body.

**Result.** The sweep: **no leak, and not one of A's rows changed** — 1 978 requests refused (4xx), 220 answered with B's own or empty data. The body test: 32 of 33 refused or harmless — and **one leak:**

**`POST /invoices/bulk-download` named another company's invoices.** With A's invoice ids B got an archive without a single document („Enthalten: 0 / Angefragt: 2“) — whose `_manifest.txt` listed each of A's invoices with number, date, total and customer („INV-2026-000001 2026-08-03 1190.00 EUR Muster GmbH (K-00001)“). The documents come from `findOne(id, companyId)`; the manifest's own query was `where: { id: { in: ids } }`. It needs the invoice's UUID, which is not guessable — but that is the only thing it needs. **Fixed:** the company is in the query. Two writes of the same shape got the company as well, though their ids come from rows that were already checked: the SEPA batch's `invoice.updateMany` and the AfA storno's `expense.deleteMany`. A search for `id: { in: … }` without a company nearby finds 12 places; the other nine take their ids from rows already read for the company.

**Spec** `355-tier592-fremde-ids-im-request-body.sh` (30 assertions): the manifest, 22 body cases that must be 4xx, bulk reminders telling nothing, A unchanged, no row of B pointing at A.

**Seen on the way, not changed:**
- (fixed in Tier 593) A PUT / DELETE on `/webhooks/:id` with a foreign id is answered 404 — and recorded as an **"unhandled" error event** with a stack trace (Prisma P2025), visible on the company's own error page. Not a leak; noise, and a stack trace a customer does not need.
- ~~`POST /fints/connections` answers 500~~ — fixed in Tier 593 (and the cause was an unknown bank code, not a missing key).
- `POST /berater/notes` is for the role `berater` only — an admin cannot write one.
**Not covered:** roles *inside* one company (what a viewer or accountant may do), one customer reading another's documents through the customer portal (its own session mechanism; spec 148), the operator routes, FinTS connections and payment batches (no fixture), files addressed by storage key.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 589–590 — a walk through every page in a browser: the activity log showed every company's audit rows; two pages had no link; raw translation keys

Asked for by the owner on 08.10.2026 („好，先做全页面浏览器走查“). **What was done:** a headless Chromium (the Playwright library of the frontend, a script in `$S/review/ui/walk.js` — not the repository's suite) signed in as the company of the reconciliation (Tiers 585–587, so the pages have data) and opened all 64 routes of `frontend/src/app` five times: 1440 × 900, 390 × 844, Chinese, English, dark. Per page it recorded console errors, uncaught exceptions, failed and 4xx/5xx requests, visible raw translation keys, horizontal overflow, blank or still-loading pages, and a screenshot. Only ports 3100 and 3011.

**Overall:** no page is blank, none throws, none stays loading; no failed navigation in any pass.

**Tier 589 — the activity log had no company filter (the most serious finding of this review).** The activity page of a fresh company showed a row with another company's user. `AuditService.buildWhere` put the company filter into a top-level `OR` (`[{companyId}, {companyId: null}]`) and a few lines later assigned `where.OR = <action prefixes>` — which replaced it. `GET /audit-logs/activity` therefore returned the rows of **every** company, and `?actionPrefix=` is the caller's: `invoice.` gave a company without a single invoice 11 184 invoice rows of the others with their `newData`; `customer.` names, addresses and VAT IDs; `login` e-mail addresses; `p` payments. Anyone with `audit.read` in any company could do that (in production too — it needs a session, nothing else). Since Tier 202, i.e. since the endpoint exists; spec 336 (the static company-scope guard) sees a `companyId` in the filter and is satisfied. **Fixed:** the company filter sits inside `AND`. **And by design** rows without a company were shown to every company (Tier 202: "admins need to see them") — those are manual cron runs with the operator's address, failed logins, and every row of the `Company` table (the audit extension writes them with `companyId` null: 5 311 `company.updated` in the test database — other companies' master data). They are the operator's now (`isSystemAdmin`, the function behind `SystemAdminGuard`), in the feed and in `activity.csv`. **Spec** `353-tier589-aktivitaetsprotokoll-nur-eigene-firma.sh` (21 assertions; 16 fail on the old code). *Left (done and corrected in Tier 597):* rows of the `Company` table written without a request context carried no company.

**Tier 590 — the small things, fixed.**
- `/dashboard/assets` and `/dashboard/berater` had no link anywhere (§9 item 23) → a card each on the dashboard.
- Raw keys on screen: `common.invoices` twice on the accounting page, five `settings.datevAccount_…` on the settings page — missing in all three languages (the i18n guard does not see a key built from a template or called through `tRef.current`). Added; a scan of every literal key in `frontend/src` finds no other.
- The company form's placeholders were the first operator's own data (`www.shleder.de`, „Amtsgericht Offenbach am Main“, a 06181 number) → neutral.
- The dashboard's change figures read `130.0 %` → `130,0 %`.
Playwright `ui-walk-tier590.spec.ts` (3 tests; reads `E2E_API_URL`).

**Seen, not changed** (for §9):
- (**fixed in Tier 596**) **Phone width: 21 of 64 pages are wider than the screen** (the whole page scrolls sideways): system-errors +543 px, reminders +525, mahnungen/settings +356, products +349, invoices/create +279, v2 +252, accounting/ustva +190, reports/aging +181, settings +173, settings/users +165, cashbook +152, and ten more under 125 px. The cause is the same everywhere: a row of header buttons that does not wrap.
- **Languages:** (`/dashboard/reports` **done in Tier 601**) `/dashboard/reports` is German in every language; the activity page's action names, the reminder / note templates and parts of the invoice detail and import pages stay German in Chinese and English.
- **The cookie banner** offers "Analyse" and "Marketing" — the application contains no analytics or marketing code at all (the component's own comment says so), and nothing reads the stored choice. On a phone the banner covers about 70 % of the first screen. A banner that asks for a consent nothing uses: an owner decision (remove the two categories, or the banner).
- **Dashboard:** ~~„Gewinn YTD“ too high~~ — **fixed in Tier 591**: `ytd.net` was the invoices' *gross* total less the expenses' *net* amount (3 387,42 € on the tile; net revenue less net expenses is 2 935,72 €). It is now `revenue − ust − expenses`; the revenue tile says that it is gross and how much VAT is in it. Spec `354-tier591-dashboard-gewinn-netto.sh` (5 assertions; the profit assertion fails on the old code: 897 instead of 700). A month with a negative total draws a bar with a negative height (console error). The hub's cards are `div`s with a click handler — not reachable by keyboard.
- **UStVA page:** the Σ row of „Steuerpflichtige Umsätze“ adds the two bases (19 % + 7 %) but shows the total output VAT including § 13b and intra-community acquisitions — the row does not add up on screen (August: 277,40 + 41,30 ≠ 423,20). The figures themselves are right (Tiers 585–587).
- **Accounting page:** explanations name developer paths („Company.settings.hebesatz“, „Company.settings.renten[year]“); „KSt-Korrekturen (): 8“ with empty brackets; the private annexes (Kind, R, SO, AUS) are offered to a GmbH.
- **A company that is not the operator** opens `/dashboard/backups`, `/system-health`, `/system-errors` from the dashboard and gets „Diese Funktion ist dem Betreiber der Installation vorbehalten“; its settings page requests `storage/config` and `storage/health` and gets 403 twice. The entries could be hidden from it.
- `/dashboard/cashbook` asks for today's daily close and takes a 404 as "none" (console noise); 72 form fields on the 64 pages have no label, placeholder or title (19 on the accounting page, 12 on invoice creation).
**Not covered:** clicking through a task in the browser (the suite's 1 012 tests do that), Safari / Firefox, real devices, screen readers.

### Read-only mode refuses every write; a re-verification is one company's (Tier 588 — the official validator knows a UBL credit note

Left open by Tier 586: `infra/kosit/scenarios.xml` matched `/ubl:Invoice` and CII only, so a UBL `CreditNote` — the project's own since Tier 586, and any supplier's — was answered with REJECT and no finding. The owner allowed the download on 08.10.2026 („好，下载吧“): **`UBL-CreditNote-2.1.xsd`**, OASIS UBL 2.1 OS, from `docs.oasis-open.org/ubl/os-UBL-2.1/xsd/maindoc/`, 57 697 bytes, sha256 `a54651b1…7b7b1a`, unchanged, next to the invoice schema (its three imports are the `common/` files already there). A second scenario `XRechnung-UBL-CreditNote-3.0` (`/cn:CreditNote`) runs the same three steps as the invoice one: the schema, the CEN EN 16931 schematron, the XRechnung schematron — both schematrons address both document types.

**Measured:** the project's UBL credit note of a complete issuer is **ACCEPTABLE** (schema Y, schematron Y, no finding) — Tier 586 had written it by the UBL sequence without an XSD to check against; it was right. The same file with a negative unit price is REJECT with BR-27, so the scenario does check. The two workarounds of Tier 586 are gone again: `engine=kosit` validates the credit note itself (not its CII twin), and `POST /expenses/e-invoice/validate` no longer answers "not available" for a UBL credit note. Spec 352 section 3 rewritten (17 assertions); 140, 201, 203, 204, 341, 344 pass. The Docker image takes `infra/kosit` as a build context, so the file is in the production image without a change to the Dockerfile.

### Read-only mode refuses every write; a re-verification is one company's (Tiers 585–587 — a month reconciled by hand: the figures agree; a refused create no longer uses up an invoice number; a credit note is a valid e-invoice; § 13b and several VAT rates exclude each other both ways

Asked for by the owner on 08.10.2026 („好，先做整月对账“) after the status review (§9 item 23). **What was done:** on the throwaway backend a fresh GmbH with August 2026 entered through the API — eight invoices (19 %, 7 %, two rates with a 10 % document discount, § 13b service and intra-community supply to a French customer, an export to Switzerland, one paid with 2 % Skonto, one part-paid, one cancelled by a credit note), five expenses (one rate, two rates, § 13b, intra-community acquisition, a supplier credit note) — then every report was pulled and compared with a calculation done independently (scripts and outputs: `$S/review/month/`).

**The figures agree, everywhere they were compared.**

| Report | Checked against the hand calculation |
|---|---|
| UStVA 08/2026 | Kz 81 1 460 / 277,40 · Kz 86 590 / 41,30 · Kz 41 600 · Kz 43 400 · Kz 21 800 · Kz 84/85 250 / 47,50 · Kz 89 300 / 57 · Kz 66 112 · Kz 61 57 · Kz 67 47,50 · Kz 83 206,70 — all as computed by hand |
| DATEV 08/2026 | 18 rows; 8400 = 1 737,40 gross (= 1 460 net), 8300 = 631,30 (= 590), 8336 800, 8125 600, 8120 400; BU keys 3 / 2 / 9 / 8 / 94 / 19; debtors 692,00 + 1 400 + 400 + 310,50 = the open items; bank 890,20; creditors −843,14 |
| ZM | FR…: L 600, S 800 — and its own cross-check against Kz 41 / Kz 21 says „stimmt“ |
| Open items (aging) | 2 445,50 = the debtor balances less the October credit note; the buckets by due date are right |
| P&L, BWA 08, GuV 2026 | revenue 3 850 (GuV 3 550 after the October credit note), other expenses 1 207,14 |
| EÜR 2026 (cash) | receipts 1 166,92 net + 199,28 VAT (the two payments, split at their rates); paid expense 400 + 76 |
| UStVA 10/2026 | −300 / −57 — the credit note, dated the day it was issued |
| September | an overpayment (335 open, 400 paid) → invoice paid, 65,00 customer credit, debtor account −65 in DATEV, EÜR receipts by rate |

**Three defects came out of it.**

**Tier 585 — a refused create used up an invoice number.** `InvoiceService.create()` took the number first and checked the request afterwards (the comment above it said a failed create "rolls back the sequence bump" — a Postgres sequence never does). No customer (400), an unknown customer (404), § 13b together with § 1a (400): each left a hole. Seen in the reconciliation as a missing INV-2026-000003; reproduced: 000008, two refused creates, 000010 … 000012. Now the number is the last thing taken before the insert, and if the insert (or a credit note's transaction) fails it goes back (`giveBackNumber` → `releaseInvoiceNumber`, which steps back only while the number is still the newest). **Spec** `351-tier585-abgelehnte-rechnung-verbraucht-keine-nummer.sh` (13 assertions; 4 fail on the old code): three refused creates and the next number, six creates at once, three good and three refused at once (9–11, nothing twice, nothing missing), the credit-note series. *Not changed here (done in Tier 600):* the recurring run takes its number inside its own transaction — a run that fails after that point could still leave a hole.

**Tier 586 — every credit note was an invalid e-invoice.** Both generators wrote type 380; a credit note is stored negative, so its XRechnung / ZUGFeRD carried a negative unit price (EN 16931 BR-27 — and the project's own check said so: „Einzelpreis darf nicht negativ sein“). That held for every Storno credit note and for the one a Skonto payment creates. Now `transformToXRechnungData` turns a `CN` into type **381 with positive amounts** and names the corrected invoice (BG-3); UBL writes a `CreditNote` document (`CreditNoteTypeCode`, `CreditNoteLine`, `CreditedQuantity`, no `DueDate`), CII `TypeCode 381` + `InvoiceReferencedDocument`. **Measured with the official validator** (KoSIT, installed locally): the ZUGFeRD credit note is ACCEPTABLE (schema Y, schematron Y). **The UBL credit note cannot be checked by it:** `infra/kosit/scenarios.xml` matches `/ubl:Invoice` and CII only and the repository holds no `UBL-CreditNote-2.1.xsd` ("a separate scenario for the future") — so it answered REJECT without a finding, which is also what a supplier's valid UBL credit note got from „Offiziell prüfen“. Until that file is added (a download — to ask the owner for): `GET /invoices/:id/xrechnung/validate?engine=kosit` checks a credit note in its CII form and says so (warning `BT-ENGINE`), and `POST /expenses/e-invoice/validate` answers `available: false` for a UBL credit note instead of "invalid". The UBL structure is by the UBL 2.1 CreditNote sequence and reads back through the project's own importer; it has **not** been through an XSD. **Spec** `352-tier586-gutschrift-als-e-rechnung.sh` (15 assertions; 10 fail on the old code).

**Tier 587 — § 13b on an expense with VAT lines.** Lines on a § 13b / intra-community expense were refused (Tier 581); the other order was not: `PUT /expenses/:id {isReverseCharge:true}` on an expense with two VAT lines answered 200 and left a reverse-charge expense with 45,50 of VAT lines. Refused now, unless the lines are removed in the same request. Found because spec 349's assertion "lines on a § 13b expense: 400" turned out to prove nothing — it sent `isReverseCharge` to `POST /expenses`, which does not know the property, so the 400 came from the DTO. That line is gone; section 7d of spec 349 has the real cases (4 assertions).

**Seen and left** (none of it wrong figures): Skonto is booked as a credit note against 8400 with the VAT key, not on 8736 „Gewährte Skonti“ — the tax result is the same, a Steuerberater may prefer the account (goes with §9 item 18); a fully credited invoice shows as `paid`; a credit note cannot be dated (it is the day it is issued); `POST /expenses` does not take `isReverseCharge` / `isIntraEU` — on the expenses page a § 13b expense is made by editing, or on the UStVA page; `GET /reports/pnl` returns unrounded floats (`2642.8599999999997`); the vouchers list of such a company is empty — invoices and expenses are not posted as vouchers, the reports and the DATEV export derive from the documents. **Not covered by this reconciliation:** a real exchange rate (the test backend's mock rate is 1), Ist-Versteuerung, a Kleinunternehmer company, the balance sheet, OSS, the bank-statement import, dunning.

### Read-only mode refuses every write; a re-verification is one company's (Tier 584 — one production path; the deploy script no longer leaves the installation without an operator; `start.sh` no longer endangers the developer's machine

The open item "two production paths, stale deploy documents" (§9 item 22), agreed with the owner on 08.10.2026 („好“). Going through the files turned up three defects that would have bitten at the first deployment or at the next `./start.sh`.

**1. `HETZNER-DEPLOY.sh` made the installation inoperable.** Its step 5 ("seed the first company") inserted a company row by hand; `infra/prod/README.md` §8 and `HETZNER-DEPLOY.md` said the same ("the app has no register flow" — it has). That row has no user and is the **oldest** company, whose admins are the operators (`SystemAdminGuard`, Tiers 548 / 565). **Measured** (`$S/opcheck.sh`, a scratch database built from the migrations): with the seed row, the first person to register gets a company of their own and **403** on `/admin/backups`, `/storage/config`, `/admin/cron-health`; without it, 200. Nobody could have operated the installation. The step is gone; script and guides tell the operator to register the first account at once (registration is open — whoever is first owns the installation; `SYSTEM_ADMIN_EMAILS` narrows it). `SystemAdminGuard` is unchanged on purpose: letting the role fall to "the oldest company that has an admin" would hand it to another tenant the day the first company loses its admin.

**2. `./start.sh` / `./stop.sh`** (what the owner runs after a restart of the computer):
- ran `prisma db push --accept-data-loss` against the development database on every start, after dropping two columns "to make it pass" → now `prisma migrate deploy` (a database without a migration history is refused with the way out: `scripts/baseline-migrations.sh`);
- `kill -9`ed whatever listened on :3001 and :3000, and every `next dev` on the machine — on this computer :3001 is the owner's other project → now only processes whose working directory is inside this checkout are stopped (TERM, then KILL); a port held by anything else stops the script: „Port 3001 is in use by another program (pid …, started in …). It is left alone. … `BACKEND_PORT=3011 ./start.sh`“;
- created a missing database container with `docker run … -p 5432:5432` on the old volume → `docker compose up -d postgres` (Tier 571's file: localhost only, `devdb_data`);
- printed „Login: info@shleder.de / Test1234!“ → gone; it now says whether the scheduled jobs are on and how to start without them (`DISABLE_CRON=1 ./start.sh`).
Ports and database are parameters (`BACKEND_PORT`, `FRONTEND_PORT`, `DB_PORT`, `DB_NAME`). **Run in a sandbox** (`$S/startsh-test.sh`: a scratch database on the throwaway server, ports 3013 / 3103): 48 migrations → 69 tables, backend and frontend up, registration works, a second run restarts its own processes, `BACKEND_PORT=3001` is refused while the other project's server keeps running, `stop.sh` stops only its own. It was **not** run against the owner's database.

**3. `infra/prod/.env.example` named the mail settings wrongly** — `SMTP_PASS` and `SMTP_FROM`, where the compose file hands on `SMTP_PASSWORD`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`: a password set as the example says never reached the backend. Nine variables the compose file reads were not in the example at all (`SYSTEM_ADMIN_EMAILS`, `METRICS_TOKEN`, `APP_ORIGIN`, `OCR_ENGINE`, `FINTS_ALLOW_MOCK`, the `SMTP_*` ones); `COMPANY_SEED_DATA`, which nothing reads, was documented as a feature. Corrected; spec 124 now compares the two files.

**The second path is gone:** root `docker-compose.prod.yml` (host nginx, `TRUST_PROXY: 0`, no `FRONTEND_URL`, never run) and its overlay `infra/prod/docker-compose.dryrun.yml` are deleted. Moved to `docs/history/` with a "superseded — do not use" notice: root `RUNBOOK.md` (June), `DEPLOY-WALKTHROUGH.md`, `DEPLOY-READY-SUMMARY.md` ("ready to deploy", 07.09.), `infra/prod/TIER127-DEPLOY-CHECKLIST.md`, `MIGRATION-nginx-to-caddy.md`, `nginx.conf`, `infra/cloudflare/` (all nginx-era). `DEPLOY.md` is now a short entry page (where to look, local development, status "not deployed"). Root `README.md`: the status block ("100 % deploy-ready", a commit of September), both quickstarts (commands that do not exist, a seed that does not exist, a printed login) and the production section are rewritten; it now says that `HANDOFF.md` wins where they differ. The rest of the README is still old.

**Corrected in `infra/prod/` docs:** `HETZNER-DEPLOY.md` told the operator to apply the schema with `prisma db push --accept-data-loss` plus a raw SQL file (the Tier 330 hybrid, superseded in Tier 559) → `migrate deploy`; `RUNBOOK.md` — wrong login answers 400 (not 401 "Invalid credentials"), rate limits are the backend's (the text pointed at a Caddy `rate_limit` directive that does not exist), and the "locked-out admin" recipe inserted a user row with a role name (`ADMIN`) and a company id that do not exist → a recipe that sets a new hash on the existing account and ends its sessions; `DR-TEST.md` — `db push`, Caddy rate limit; `README.md` — the diagram's "rate limit" on Caddy, "install nginx + certbot" in the recovery steps, Grafana at `http://<vps>:3001` (localhost only since Tier 576); `HETZNER-DEPLOY.sh --check` asked for the checklist that is now history.

**4. (584a) Caddy held idle upstream connections longer than the servers do.** CI failed on spec 194 after `nginx.conf` moved — and that was the useful part: Tier 405 had set the backend's keep-alive to 65 s "to outlast nginx's 60 s" and the spec kept comparing with the nginx file, while the proxy had long been Caddy, whose default idle time for upstream connections is **2 minutes**. Between second 65 and 120 Caddy would send a request down a connection the backend is closing: an intermittent 502 for everything it cannot retry (a POST). The frontend was worse — Next's server closes after Node's default 5 s. Now `keepalive 30s` in the `transport http` of both upstreams in both Caddyfiles (checked with `caddy adapt`: `idle_timeout` 30 s), and `KEEP_ALIVE_TIMEOUT: "65000"` for the frontend in the compose file. Spec 194 reads the Caddyfiles and the compose file (8 assertions, 5 fail without the fix). Not reproduced under load — the pairing is by configuration.

**Spec 124** rewritten for the one path (38 assertions; 8 fail against the old scripts and guides): the compose file lints with five services, required variables, no document tells anyone to use the removed file, the example env file names every variable the compose file reads, no guide inserts a company or pushes the schema, `start.sh` / `stop.sh` kill nothing by port or name.

**Not done:** none of the guides has been followed on a real server (there is none). `DIGITALOCEAN-DEPLOY.md`, `SECURITY.md` and the rest of `RUNBOOK.md` were only searched for the stale items above, not read line by line. `USER-GUIDE.md` and the phase / Playwright reports at the root are historical and untouched.

### Read-only mode refuses every write; a re-verification is one company's (Tier 583 — a PDF signature is really verified

Found while going through §9 item 22 ("PDF signature verification — structural only"). It was worse than that sounds. `SigningService.verifyPdf` returned `valid: true` whenever the container held a 32-byte `messageDigest` attribute: the digest was computed and deliberately not compared (`_digestMatches`, "a v2 improvement"), and no signature was ever checked. **Measured** on a PDF signed by this application:
- the visible amount changed after signing („Betrag 100,00“ → „900,00“) → `valid: true`;
- the signature value itself overwritten → `valid: true`;
- bytes appended after the signed range → `valid: true`;
- and a PDF signed by *another company registered under the same name* → „✓ gültig, signiert von <name>“.
The invoice page's „Signatur prüfen“ showed the green tick for all of them.

**Now** (`signing/pdf-signature-verify.ts`, Node's `crypto` — not node-forge, whose RSA verification has the open advisory noted in Tier 572): for every signature in the file
1. the `/ByteRange` starts at 0 and its gap is exactly the hex string of `/Contents`;
2. the hash of the signed bytes (SHA-256/384/512) equals the `messageDigest` in the signed attributes;
3. the signature over the signed attributes verifies with the public key of a certificate in the container (a small DER reader takes the attributes' original bytes; RSA and EC);
and the **last** signature must reach the end of the file. `valid` only if all of that holds. Reasons in German („Das Dokument wurde nach dem Signieren verändert.“, „Die Signatur passt nicht zum enthaltenen Zertifikat …“, „Nach der letzten Signatur wurde dem Dokument etwas hinzugefügt.“).

**Whose certificate:** the certificates are self-signed, so a valid signature proves "unchanged since signed by the holder of this key", not who that is. `POST /signing/verify` now answers with `trusted` (valid, and every signature's certificate is this company's or one of its members') and per signature `knownSigner: company | user | null`, `signedAt`, validity dates, `coversWholeDocument`. The page shows three states: green (intact, own certificate), amber (intact, foreign certificate — „Wer unterschrieben hat, ist damit nicht belegt“), red (the reason).

**Specs:** `350-tier583-signaturpruefung.sh` (14 assertions, 12 fail on the old code: the three manipulations, an emptied container, a ByteRange that leaves the amount out, unsigned, another company's view, a same-name company's signature, company + member signatures and one changed byte in the second revision, the application's own invoice PDF); Playwright `pdf-signature-verify-tier583.spec.ts`. Specs 98 / 168 / 186 pass unchanged.

**Limits:** after a certificate is rotated (`/signing/regenerate`), documents signed with the old one are intact-but-unknown (only the current fingerprint is kept). No revocation, no timestamp authority — `signedAt` is what the signer claimed. RSA-PSS signatures are not recognised (reported as not matching).

### Read-only mode refuses every write; a re-verification is one company's (Tier 582 — several VAT rates on the UStVA page; the owner's database migrated

**The development database** (`de-invoice-postgres`): after the owner's „继续“ to the offer in the Tier 581 report, the one pending migration (`20261007000001_expense_tax_lines`, additive) was applied with `prisma migrate deploy` — checked first that it was the only pending one; 68 → 69 tables, 33 expenses and 318 invoices as before, no difference to the schema left. Script: `$S/dev-migrate.sh`.

**The UStVA page** is where an expense is entered by hand, and its form had one rate (Tier 581 left that open: a second rate had to be added afterwards on the expenses page, and the page sent the correction of a multi-rate expense elsewhere). Now:
- `POST /ustva/expenses` takes `taxLines` like `POST /expenses` (`CreateUstvaExpenseDto`, `ustva.controller.ts` → `checkTaxLines`; before, the field was stripped by the validation pipe and the invoice stored with one rate). Not with § 13b / igE.
- the form has „+ weiterer Steuersatz“: further lines of rate and net (VAT = net × rate, as the form's main line); it sends the lines with their sums, loads the lines of an expense being corrected, and sends `taxLines: []` when the last extra rate is removed.

Spec 349 section 7c; Playwright `ustva-expense-rates-tier582.spec.ts`.

**Still one rate:** the CSV import of expenses and the OCR scan's proposal.

### Read-only mode refuses every write; a re-verification is one company's (Tier 581 — one expense for an invoice with several VAT rates

Agreed with the owner on 07.10.2026 („好，都做“) — the schema change that Tiers 573 and 577 had worked around. An `Expense` had one rate; an invoice with 19 % and 7 % was two expenses under one number.

**The model** (`prisma/schema.prisma`, migration `20261007000001_expense_tax_lines`, `expense/tax-lines.ts`): `ExpenseTaxLine { expenseId, companyId, position, vatRate, netAmount, vatAmount }`. The rule that leaves every existing row and reader valid:
- **no rows** → the expense's own `netAmount` / `vatRate` / `vatAmount` are its one line (every expense from before, every one-rate expense since);
- **rows** (at least two, one per rate) → the expense's three amounts are their sums, its `vatRate` the rate of the largest line (what a list shows).
Whoever needs the split reads `expenseTaxLines(exp)`; whoever needs totals keeps reading the expense — EÜR, GuV, BWA, payments, SEPA, the dashboards and the lock rules are untouched.

**What reads the lines now**
- `POST /expenses` and `PUT /expenses/:id` (also `PUT /ustva/expenses/:id`) take `taxLines: [{ vatRate, netAmount, vatAmount }]` (entered positive, at most 8, each rate once, each line checked like an expense's amounts; totals sent alongside must be the sums; not with § 13b / igE). One line is stored as an ordinary expense. On update: lines replace lines; `[]` plus amounts makes it one rate again; a scalar amount for an expense with lines is refused (400); `creditNote` turns every line.
- **UStVA** (`ustva.service.ts`): Vorsteuer by each line's rate — before, the whole VAT of an invoice counted under the expense's one rate.
- **DATEV** (`datev.service.ts`): one row per line with its own BU-Schlüssel (9 / 8), all under the invoice's number.
- **Bank booking** (`bank-import.service.ts`): the payment's voucher has a cost and a Vorsteuer line per rate, from the expense itself (the request's `vatRate` / `vatAmount` can describe one rate); a **Skonto** is shared out over the rates — the payment's Vorsteuer and the credit note (which gets the same lines). The Tier 577 path (several expenses, one debit) uses the same code and stays for invoices entered as two expenses.
- **E-invoice import**: **one** expense with a line per rate (zero-rated categories are a 0 % line). Only § 13b (AE) and the intra-community acquisition (K) remain expenses of their own beside a taxed part — they are flags of the whole expense.
- **GoBD archive**: the lines are in the expense's record.
- **Audit trail** (581a): the lines are written nested in their expense and have no audit rows of their own; the expense's rows carry them — after a write through the `include`, before it through `PRE_IMAGE_INCLUDE` in `audit-log.extension.ts`. Spec 196 ("no money-bearing model without a trail") exempts `ExpenseTaxLine` with that reason — it failed in CI on the first push, which is what it is for; spec 349 asserts the lines in `oldData` / `newData`.
- **Frontend**: the expenses list names the rates („19 % / 7 %“); `ExpenseEditForm` edits the lines (rate · net · VAT, add / remove, the VAT follows net × rate until typed) and gives an ordinary expense a second rate; the UStVA page shows the rates and sends the correction of such an expense to the expenses page (its inline form has one rate); the import dialog shows the lines of what will be booked.

**Specs:** `349-tier581-ausgabe-mit-mehreren-steuersaetzen.sh` (45 assertions, 24 fail on the old code: create / refuse / read, UStVA 19 % and 7 %, DATEV rows and keys, the bank voucher, Skonto 7,05 split 4,76 / 2,29 with its credit note, the refund of a two-rate credit note, corrections, delete, tenant); spec 344 now expects one expense with lines; Playwright `expense-tax-lines-tier581.spec.ts` and the updated `e-invoice-import-tier573.spec.ts`.

**For the owner's own database:** the migration is additive (one new table). It was applied to `de-invoice-postgres` on 08.10.2026 (Tier 582).

**Not done:** the CSV import of expenses is one rate per row; the OCR scan path proposes one rate. (`POST /ustva/expenses` and the UStVA page's form: done in Tier 582.)

### Read-only mode refuses every write; a re-verification is one company's (Tier 580 — the production image runs the compiled backend, and CI builds the images

Both agreed with the owner on 07.10.2026 („好，都做“).

**The backend image** (`backend/Dockerfile`) started `npx ts-node --transpile-only src/main.ts`: the TypeScript compiler inside the production process, a compilation at every start, and no type check anywhere in the image build. Now a `build` stage runs `npx tsc` (a type error fails the image build) and `npm prune --omit=dev`; the runtime stage takes `node_modules` and `dist/` from it and starts `node --enable-source-maps dist/main.js`. `src/`, `tsconfig.json`, `ts-node`, `typescript`, eslint and the test tools are no longer in the image. The `__dirname`-relative paths keep their depth (`/app/dist/invoices` → `/infra/kosit` as before).

**Verified by running it** — the whole production compose locally as its own project (`$S/fulldry/`, images and volumes removed afterwards): the image builds; the backend is healthy within seconds at **about 210 MB** in the container; `prisma migrate deploy` on an empty database; through the proxy with a session: register, company, customer, invoice, PDF, ZUGFeRD, the XRechnung check with `engine=kosit` (the validator answers from inside the image), e-invoice preview / validate (`ACCEPTABLE`) / import, the kept invoice, change-password (old session 401, new one 200), search, frontend pages; header auth without a session → 401; no ERROR line in the log. (The session cookie is `Secure` in production and the dry run speaks plain http, so the script sends the session as `Authorization: Bearer`.)

**`.github/workflows/docker-build.yml`** builds both images — without pushing — when one of the files they are made of changes (`Dockerfile`, `.dockerignore`, `package*.json`, `tsconfig.json`, `schema.prisma`, `next.config.*`, `infra/kosit/**`, the workflow itself) or by hand, and then looks inside the backend image (compiled entry point, no `ts-node`/`tsc`, Prisma client, validator, Java, the CMD). Path-triggered on purpose: the account has hit its Actions spending limit once, and most pushes touch none of these files. `release.yml` (tags only) is unchanged and still has never run.

Spec 341 holds the Dockerfile's CMD / build step and the workflow's shape. Development is unchanged: `scripts/start-backend.sh` and CI still run `ts-node`.

### Read-only mode refuses every write; a re-verification is one company's (Tier 579 — Skonto in an e-invoice's payment terms is read

XRechnung writes a cash discount into the payment terms as `#SKONTO#TAGE=14#PROZENT=2.00#` (optionally `BASISBETRAG=…#`). It was shown as that raw text. `e-invoice-parser.ts` now reads every such entry into `invoice.skonto` (days, percent, the amount that may be deducted from the amount due or the given base), leaves the readable rest in `payment.terms`, says it in the preview and writes it into the expense's notes („Skonto 2 % innerhalb von 14 Tagen (7,05)“); the dialog shows it under the payment details. Spec 344, section 8b. Paying with the discount is the bank import's existing Skonto path (one expense; not for a multi-part invoice).

### Read-only mode refuses every write; a re-verification is one company's (Tier 578 — the official validator from the e-invoice dialog

`POST /expenses/e-invoice/validate` (Tier 573) had no button. The import dialog now has „Offiziell prüfen (KoSIT)“: accepted, or rejected with every finding and its rule, or — where Java / the validator files are missing (this machine) — the sentence that it is not installed. The import does not depend on it. Playwright `e-invoice-import-tier573.spec.ts` clicks it (CI has the validator, a developer machine usually not — both branches are accepted). Not offered when looking at a stored invoice (the route takes a file).

### Read-only mode refuses every write; a re-verification is one company's (Tier 577 — one bank debit pays an invoice entered as several expenses

The first open point of Tier 573, solved without the schema change. An `Expense` has one VAT rate, so an invoice with 19 % and 7 % is two expenses under the same supplier and number — entered by hand or by the e-invoice import. The bank shows one payment. **Measured before:** `book-expense` with that debit → 400 „Die Abbuchung (352.64) entspricht nicht dem Betrag der Eingangsrechnung (238.00)“ for either part, and the page offered no payment button: such an invoice could not be settled through the bank import at all.

**Now** (`bank-import.service.ts` `invoiceParts`): when the debit is not the named expense's amount (and no Skonto), it is accepted if it is exactly the sum of that supplier's open expenses with that invoice number (at least two; a part already paid from the cash book or by another bank booking does not count). Then
- one voucher: each part's cost line on its own account and its Vorsteuer line (from the expense itself — the request's `vatRate` / `vatAmount` describe one part), one bank line; tagged `[expense:<id>]` once per part;
- every part gets `paidAt`; the answer lists `expenseIds`;
- a Storno frees every part (`voucher.service.ts` read only the first tag);
- DATEV exports one payment „Kreditor an Bank“ of the whole amount (`datev.service.ts` took only the first tag for "already booked by a bank voucher" — the second part would have been exported as paid a second time: Kreditor balance −51,86 instead of −166,50 in the spec's case).
- The bank import page offers „Zahlung <nr> (2 Teilbeträge)“.

Unchanged on purpose: a SEPA run still makes one transfer per expense — each then matches its own debit.

**Specs:** `348-tier577-eine-zahlung-mehrere-steuersaetze.sh` (19 assertions, 10 fail on the old code; the DATEV one fails with only the DATEV change taken out) and Playwright `bank-payment-parts-tier577.spec.ts`. All 66 bank / DATEV / Skonto / expense specs pass locally (116 fails locally as always).

**Open at the time, done in Tier 581:** VAT lines on the expense itself (one row per invoice, and Skonto on an invoice with several rates). For an invoice entered as *two expenses* the Skonto path still takes one expense.

### Read-only mode refuses every write; a re-verification is one company's (Tier 576 — the monitoring overlays can be added without stopping the stack, and are not open to the internet

From the open list (§9 item 22). Pre-launch hardening — nothing is deployed. **Measured with `docker compose config`** (nothing started, nothing downloaded):

- `infra/prod/monitoring.yml` and `docker-compose.observability.yml` both declared `networks.deinvoicenet` as `name: deinvoicenet` + `external: true`. Used as documented (`-f docker-compose.yml -f <overlay>`) that is merged into the main file's network: the **app's own network** became an external one that nothing creates — `up` would have failed for the whole stack, app included. Now `deinvoicenet: {}`.
- `docker-compose.observability.yml` published **Prometheus on `9090` and Grafana on `3001` on every interface**. Prometheus has no login; a port published by Docker is not held back by ufw. Now `127.0.0.1:` like the newer overlay (reach them through an SSH tunnel).
- **Grafana's admin password defaulted to `admin`** in both (the file's own comment called admin/admin "acceptable"). Now `${GRAFANA_ADMIN_PASSWORD:?…}`: the overlay does not resolve without it. The main stack is unaffected.

**Spec** `347-tier576-monitoring-overlay.sh` (16 assertions, 7 fail on the old files; skips where `docker compose` is missing): each overlay and both together resolve with the main file; the network is `de-invoice-prod_deinvoicenet` and not external; no service but the proxy is published beyond localhost; without the Grafana password the overlay refuses, the plain stack does not.

**Not done:** the overlays were resolved, not run (their images — Prometheus, Grafana, Loki, exporters — are not on this machine; that is a download to ask for). `--web.enable-lifecycle` on Prometheus and the privileged cAdvisor are as they were. When the backend runs with `METRICS_TOKEN`, the token has to be put into `prometheus/prometheus.yml` by hand (commented there).

### Read-only mode refuses every write; a re-verification is one company's (Tier 575 — a signed-in user can change the password

From the open list (§9 item 22, "account self-service"). **Measured before:** `POST /auth/change-password` → 404; nothing on the security page. The only way to a new password was „Passwort vergessen“ — which needs a working mail server (none is configured on this installation) and the mailbox.

**Now:** `POST /auth/change-password` `{ currentPassword, newPassword }` (`auth.controller.ts`, `AuthService.changePassword`):
- the current password is asked for again — a borrowed session is not enough to take the account. Wrong → **400** (not 401: the frontend signs out on a 401), and an audit entry `password_change_failed`;
- the new one follows the rule of the reset (`assertPasswordStrength`: 8–200 characters, letters and digits) and must differ from the current one;
- every session of the user ends (`revokeAllForUser`, as after a reset) and the caller gets a new one — cookie, and `sessionToken` in the answer as login does; audit entry `password_changed` with the number of sessions ended;
- 5 attempts a minute.
- `components/ChangePasswordCard.tsx` on `/dashboard/security` („Passwort ändern“, de / en / zh).

**Specs:** `346-tier575-passwort-aendern.sh` (20 assertions, 16 fail on the old code) and Playwright `change-password-tier575.spec.ts`. The route is in spec 177's reviewed list of routes without a role check (it acts on the caller's own account) — **575a**: that list was forgotten at first and CI failed on it; when adding a route that takes no `@Require`, run spec 177.

The same rule holds everywhere a password is set: registration (`auth.controller.ts`), invitation (`users.service.ts`), reset and change. (The `@MinLength(6)` in `auth.dto.ts` is only the first gate.) E-mail verification and account deletion stay open.

### Read-only mode refuses every write; a re-verification is one company's (Tier 574 — a scanned receipt: nothing created before it is confirmed, and the scan is kept

Seen while building Tier 573, in the path next to it („Scan hochladen“ with a picture or an ordinary PDF). **Measured before:**

- Picking a scan called `POST /ocr/match-supplier`, which is "find **or create**": the supplier existed before the preview was even shown. Cancelling left it behind (named after whatever the OCR read in the first line); a name corrected in the preview never reached it.
- The picture was read and thrown away — the expense it produced had no Beleg (GoBD: the receipt is what has to be kept).
- The three requests were raw `fetch()` calls with hand-set headers, against the rule in `backend/AGENTS.md`.

**Now:** `match-supplier` takes `lookupOnly` (also as the form text `"true"`) and then only answers. The page asks with it for the preview („+ Der Lieferant wird mit der Ausgabe neu angelegt“), and on confirmation creates the supplier under the name as edited, then the expense, then stores the scan as the expense's attachment (`POST /attachments`); if only that last step fails the page says that the expense exists and its Beleg is missing. All through `apiFetch` / `apiPost`.

**Specs:** `345-tier574-scan-lieferant-erst-bei-bestaetigung.sh` (8 assertions, 5 fail on the old code) and Playwright `ocr-scan-keeps-file-tier574.spec.ts` (cancel → no supplier; confirm with a corrected name → one supplier under that name, one expense, the PNG attached with its SHA-256; fails on the old code at "no supplier before the confirmation").

### Read-only mode refuses every write; a re-verification is one company's (Tier 573 — incoming e-invoices are read, booked and kept

The first item of the open list in §9 item 22, agreed with the owner on 07.10.2026. Receiving e-invoices is mandatory since 01.01.2025 (§ 27 Abs. 38 UStG). **Measured before:** an `.xml` upload → 400 „Dateityp nicht erlaubt“; a ZUGFeRD PDF went through OCR like a photographed receipt, the invoice inside it unread.

**What there is now** (`backend/src/modules/expense/e-invoice/`):

- `xml-reader.ts` — a strict reader for the subset an invoice needs. The XML library in the project (xmlbuilder2) is a builder: measured, it accepts `<a><b></a>` and the word "hello" as documents and dies of a stack overflow after 5 s on 20 000 nested elements. The reader refuses any DOCTYPE (no entity definitions → no XXE, no "billion laughs"), unmatched tags, more than 64 levels / 200 000 elements, unknown entities; resolves namespaces (`cbc:ID`, `ns3:ID` and a default-namespace `ID` are the same); reads UTF-8, UTF-16 and Latin-1 as declared.
- `e-invoice-parser.ts` — UBL `Invoice` / `CreditNote` and UN/CEFACT `CrossIndustryInvoice` into one shape (number, dates, parties with VAT ID / tax number, payment, totals, VAT lines BG-23, invoice lines). Names the profile (XRechnung n.n, Peppol BIS, ZUGFeRD MINIMUM … EXTENDED). Checks what must agree: BT-1/2/27/109/112 present, VAT lines add up to the totals, a tax-free category carries no tax. A credit note (UBL `CreditNote`, type 381, or negative totals) is given positive and flagged.
- `pdf-embedded-xml.ts` — the XML inside a ZUGFeRD / Factur-X PDF (pdf-lib; name tree and `/AF`), inflated with a 10 MB ceiling (a 400 KB PDF whose attachment expands to 400 MB: answered in 16 ms as "no invoice").
- `e-invoice-import.service.ts` + `e-invoice.controller.ts`:
  - `POST /expenses/e-invoice/preview` (file) → what is in it and what an import would do; writes nothing. `{ eInvoice: false }` for a PDF without an invoice (the page then sends it to OCR).
  - `POST /expenses/e-invoice/import` (file, `supplierId?`, `confirmDuplicate?`, `confirmRecipient?`, `exchangeRate?`, `paidAt?`, `category?`, `accountNumber?`) → the supplier (found by VAT ID, then by name, else created from the invoice), **one expense per VAT line** through `ExpenseService.create` (so every rule of a hand-entered expense holds), and the received file **byte for byte** as each expense's attachment, with its SHA-256 and the invoice's text for the search.
  - `POST /expenses/e-invoice/validate` → the KoSIT validator on a received file (`available: false` where it is not installed).
  - `GET /expenses/:id/e-invoice` → the kept invoice read again for display (`{ eInvoice: false }` when the expense has none).
- Decisions built in: the seller being this company → refused (an outgoing invoice); addressed to another name → 409 until `confirmRecipient`; same file (hash) or same supplier + number → 409 until `confirmDuplicate`; another currency → refused until an `exchangeRate` (1 EUR = x) is given, the original amount goes into the notes; category AE → `isReverseCharge`, K → `isIntraEU` (the UStVA assumes 19 % — said in the preview); **an existing supplier's bank account is never changed** — an invoice naming another IBAN gets a warning at the top of the preview (the classic payment fraud).
- Storage: `.xml` is an allowed attachment type (content must be markup). `common/content-disposition.ts`: only PDFs and pictures are ever shown in place; an XML is always a download with `nosniff` — an XHTML page with script named `.xml`, shown on the API's origin, would have run with the viewer's session.
- Frontend: `components/EInvoiceDialog.tsx`; the expenses page has „E-Rechnung einlesen“, and „Scan hochladen“ sends an XML — or a PDF that carries one — to the same dialog instead of OCR. The expense's detail view offers „E-Rechnung anzeigen“. `eInvoice.*` keys in de / en / zh.

**Found on the way and fixed — the same supplier invoice entered several times at once.** Six simultaneous `POST /expenses` (or `/ustva/expenses`) with one supplier and number → six rows: the Tier 489 duplicate check looked before any request had written (a double click is two requests). `withExpenseNumberLock` (`expense-duplicate.ts`) makes check and insert one step; an import is serialised per company. Now 1 × 201, 5 × 409.

**Spec** `344-tier573-eingangs-e-rechnung.sh` (82 assertions; 68 fail on the old code): UBL with unusual prefixes / entities / CDATA / two VAT rates; the supplier and both expenses; the file returned identical; duplicates by file and by number; another IBAN; the app's own ZUGFeRD PDF imported by a second company (and refused for the sender itself); a CII credit note with reverse charge from Austria; another recipient; USD; DOCTYPE, external entity, unmatched tags, a cut-off file, a bank statement, ZUGFeRD 1.0, 5000 nested elements, sums that do not add up, no number, 30 February, a future date, a PNG named `.xml`, a damaged PDF, an empty file; an XHTML-with-script attachment only as a download; the validate route; the simultaneous requests. Playwright `e-invoice-import-tier573.spec.ts` (2 tests; it reads `E2E_API_URL`, so unlike the older specs it can run locally against port 3011).

**Not done — for the owner to decide (also in §9 item 22):**
- **An invoice with two VAT rates becomes two expenses** (an `Expense` has one rate and no lines). The books and the UStVA are right; but the bank shows *one* payment, so the bank-import match and the SEPA run see two amounts. A clean solution is VAT lines on the expense — a schema change touching UStVA, EÜR, DATEV and payments.
- **No automatic check against the EN 16931 rule set on import** — the reader checks what it needs to book; the official validator is a button (and knows only the XRechnung scenarios).
- **Files are uploaded by hand.** No mailbox polling, no Peppol access point.
- Skonto in the payment terms (`#SKONTO#…`) is kept as text, not evaluated. ZUGFeRD 1.0 is not read. MINIMUM / BASIC WL are imported with the notice that they are no e-invoices in the sense of § 14 UStG.
- For § 13b / intra-community invoices the rate is not in the file; 19 % is assumed as everywhere else in the app.
- Seen in passing: the OCR path („Scan hochladen“ with a picture) created the supplier *before* the user had confirmed anything, and did not attach the scanned file to the expense — **fixed in Tier 574**.

### Read-only mode refuses every write; a re-verification is one company's (Tier 572 — dependencies with known vulnerabilities updated

Agreed with the owner on 07.10.2026 ("按你的做"). `npm audit --omit=dev` before: backend 12 (1 critical), frontend 5 (1 critical). After: **backend 3, frontend 0.**

**Backend** (`backend/package.json`): `@nestjs/common|core|platform-express` 11.1 → `^11.2.7` (brings `multer` 2 and `proxy-addr` 2.0.8), `multer` 1.4.5-lts → `^2.4.0` (+ `@types/multer` 2), `nodemailer` 8 → `^10.0.16` (ships its own types — `@types/nodemailer` removed; **needs Node ≥ 20**; the images and CI use 22), `overrides.fints.isomorphic-fetch ^3` (replaces the library's `node-fetch` 1.x), plus `npm audit fix` (`qs`, `body-parser`, `brace-expansion`). No source change was needed; `tsc` and eslint are clean.

- The critical one was `proxy-addr`: an address written as IPv4-mapped IPv6 was matched against the trusted ranges in a way that let a visitor pose as a trusted proxy — relevant here since Tier 555 trusts the private ranges. Checked by hand on the updated library with `TRUST_PROXY=true` and throttling on: five wrong logins from one forwarded address → 400, the sixth and seventh → 429; a second address is unaffected; a chain claiming `::ffff:10.0.0.1` gets its own counter.
- Ran every upload, mail, FinTS, signing and OCR spec locally afterwards: all pass except the known local ones (133, 188) and 49, which fails locally only because the local seed company has lost its `taxId` (`Steuernummer im Firmenprofil fehlt`) — CI builds its database fresh.

**Frontend** (`frontend/package.json`): `next` 15.5.7 → **15.5.27** (still pinned exactly; the critical advisory), `eslint-config-next` to match, `npm audit fix` (`nanoid`, `sharp`, `source-map-js`, the top-level `postcss`), and `overrides.next.postcss ^8.5.29` because Next pins its own older PostCSS (build-time only, our own CSS — done so the audit stays readable). `tsc`, eslint and a full `next build` pass.

**What is left, and why:**
- `node-forge` (high, *no fixed version exists*): the advisory is about RSA signature **verification**. `signing.service.ts` uses forge to create keys/certificates and to sign, never `verify` — not reachable. Re-check when a fix is published.
- `fast-xml-parser` inside the `fints` library (moderate; the only "fix" npm offers is downgrading `fints` to 0.1.1). It parses what the bank's server answers. Goes away when the FinTS library is replaced (§9 item 22, stubs).
- Frontend dev-only: `braces` → `micromatch` → `fast-glob` → `eslint-config-next` (high, no fixed version) — lint tooling, not in the image.

**Spec** `343-tier572-abhaengigkeiten-untergrenze.sh`: an audit needs the network and changes daily, so the spec only holds the floor — every copy of `proxy-addr`, `multer`, `nodemailer`, `@nestjs/platform-express`, `qs` in the backend lockfile and of `next`, `postcss` in the frontend lockfile is at least the fixing version, and no `node-fetch` 1.x is left. 7 of its 8 assertions fail on the old lockfiles.

**Local note:** the Playwright specs address the backend as `http://localhost:3001`, which on this machine is the owner's other project — they cannot run here and are left to CI. (Three of them were started by mistake during this tier and sent a few requests to that other frontend, which answered 404; nothing else happened.) `$S/fe-up.sh` restarts this checkout's own dev frontend on 3100.

### Read-only mode refuses every write; a re-verification is one company's (Tier 571 — the owner's development database is back; the catch-up migration meets real data

Agreed with the owner on 07.10.2026 ("按你的做") after the status review.

**The three test-made backup directories** (`backup-2026-09-24-101352`, `-10-02-101709`, `-10-07-040000`) were moved to the macOS Trash with `/usr/bin/trash` after re-checking each one's tar root — not deleted; "Put Back" works. `~/data/backups/de-invoice` holds the seven real backups again.

**The development database.** What was found, read-only, before anything was changed:
- `de-invoice-postgres` (made by hand on 01.09., bind mount `/tmp/pgdata`) had been dead since 10.09.; the directory is gone.
- The volume the dev compose file named, `de-invoice_postgres_data`, holds a *different* cluster — database `deinvoice_dryrun`, no role `de_invoice` (looked at on a copy; the volume itself was mounted read-only). `docker compose up` would have started Postgres on that and the backend could not have logged in.
- `backup-2026-09-05-224235` is a `pg_dump --format=custom` file despite its name `db.sql.gz`; it restores cleanly: 1 company (SH Leder GmbH, the seed company), 1 user, 220 customers, 318 invoices, 84 payments, 33 expenses, 103 vouchers, 1 315 audit rows, 22 recorded migrations (last: `20260905000001`). By its content it is the database the e2e suite used to run against (customers "Cust 19", `example.com`, webhooks to httpbin.org).

What was done: the dead container was renamed to `de-invoice-postgres-dead-20260910` (kept); `docker-compose.yml` got a volume of its own (`devdb_data` → `de-invoice_devdb_data`) and publishes 5432 on 127.0.0.1 only (it was every interface, with the password in the file); `docker compose up -d postgres`; `pg_restore`; `prisma migrate deploy` (25 pending migrations). Result: schema identical to today's, history complete, every row count as in the backup, full-text columns present. A backend started on it for a minute with the scheduled jobs off answered invoices (318), customers (220), search, EÜR, UStVA and `/auth/me` with no error in its log and no row changed. The files: all 693 of the backup's are still in `~/data/invoice-system` — nothing to restore. The old volume `de-invoice_postgres_data` was not touched.

**The rehearsal (on the throwaway server first) found a defect of Tier 559:** the catch-up migration failed on this data — `CustomerCreditTransaction_customerId_fkey` cannot be added while rows point at customers that no longer exist (error 23503; the migration is one implicit transaction, so nothing was applied and `migrate deploy` stopped). All 24 foreign keys of that migration are now added `NOT VALID` and validated right after; one that cannot be validated stays in force for new rows and says so in a WARNING. Editing an already-published migration is safe here only because no persistent database had applied it (nothing is deployed; CI databases are thrown away). Spec 339 has the case (5 assertions fail with the old file).

**Things in that data the owner should know before starting the app on it** (none changed):
- three constraints are unvalidated because of old rows: 35 of 35 credit transactions belong to customers that are gone, 91 of 210 voucher lines to accounts that are gone, some webhook deliveries to deleted webhooks — leftovers of test clean-ups;
- `GET /audit-logs/verify` says `ok: false` (hash mismatch) — §9 item 5, the re-hash decision;
- the scheduled jobs will act on a month-old database: 3 active recurring templates (2 due in the past, all three set to e-mail the customer), 111 open invoices past their due date with the auto-reminder not switched off. No mail settings are stored in the database; whether `backend/.env` has SMTP was not looked at (credential file). `DISABLE_CRON=1` holds back the recurring, reminder, backup, VAT and session jobs — **not** the webhook retries, the bank sync, the exchange rates and the AfA booker, which do not read it.
- `MailConfig.smtpPassword` is stored in plain text (its own comment says so) — so it is in every dump.

An unrequested download happened while inspecting the volume: `alpine:latest` (≈4 MB) was pulled because I used it for a read-only `ls`; the local `postgres:16-alpine` would have done.

### Read-only mode refuses every write; a re-verification is one company's (Tier 570 — a test backend keeps away from the real backup directory

Found during a status review on 07.10.2026. `BackupService` defaulted to `~/data/backups/de-invoice` — the installation's real backups — for every backend, including one started for tests against a throwaway database. Each run of `scripts/backup.sh` also **rotates** that directory. The local test backend had been left running overnight; its 04:00 tick wrote `backup-2026-10-07-040000` there (a dump of the test database, a tar of `/tmp/de-invoice-storage`). Two more of the same kind were already there from earlier sessions' spec runs (`backup-2026-09-24-101352`, `backup-2026-10-02-101709` — tar root `de-invoice-storage/`; the real ones have `invoice-system/`).

Checked against a listing taken on 06.10.2026: **no real backup was deleted** — the seven real ones (08-01, 08-16, 08-23, 08-30, 09-01 ×2, 09-05; each checked: tar root `invoice-system/`) are all still there. But rotation keeps "the 7 most recent days": every further test-made backup would have pushed a real one closer to deletion.

Now `defaultBackupRoot()`: a backend with `NODE_ENV=test`, or with `PG_CONTAINER` naming anything but the installation's database, defaults to `<tmpdir>/de-invoice-test-backups`; `BACKUP_ROOT` still decides when set. Spec 144 asserts that the suite's backend does not report the real directory. Measured with `BACKUP_ROOT` unset: `backupRoot` = `/var/folders/…/T/de-invoice-test-backups`, the real directory unchanged.

**Left for the owner (nothing was deleted by me):** the three test-made directories named above are still in `~/data/backups/de-invoice`. They are not backups of anything real, and the newest of them is what "the latest backup" now means there.

### Read-only mode refuses every write; a re-verification is one company's (Tier 569 — the official XRechnung validator, in production and on the invoice page

Asked for by the owner on 07.10.2026. Until now the KoSIT validator ran in CI (spec 140, on the runner's Java) and on a developer's machine; the production image had neither Java nor the validator's files, the API fell back to the in-process check there, and no page offered the check at all.

- **Image.** `backend/Dockerfile` installs `openjdk-17-jre-headless` and copies the validator to `/infra/kosit` (where `kosIT-validator.service.ts` resolves it from `/app/src/invoices`). The files (18 MB, in git under `infra/kosit`) are outside the build context, so they come in as a named context `kosit` that replaces an empty `FROM scratch AS kosit` stage: `additional_contexts` in both compose files, `build-contexts` in `release.yml`. Built without the context the image has no validator and behaves as before — both ways were built and inspected.
- **Findings.** The result carried one error: the first line of the CLI's table, cut at 60 characters, no rule id. `parseReportInput()` now reads the report input the CLI serialises (`input-reportInput.xml`): every failed assertion with rule id, severity (fatal/error → errors, warning/information → notes), location and full text, plus schema errors. The table line remains the fallback.
- **Page.** "XRechnung prüfen" on the invoice page (next to the download): valid / not valid, which engine checked it (and, if the official one is not there, that the built-in check covers only part of the rules), the findings.

Measured on the production stack (dry run): `engine: kosit`, ~2 s per check; a seller without tax number → REJECT with 12 findings (BR-S-02, BR-CO-26, BR-DE-1 … in full) and 2 notes; the same invoice after completing the company → ACCEPTABLE, schema Y, schematron Y; both shown on the page in a real browser. Spec 140 section 3b (fails on the old parser), Playwright `xrechnung-check-tier569.spec.ts` (accepts either engine), spec 341 (image and compose wiring).

Costs: the backend image grows by the JRE (~200 MB; 1.7 GB in total here). **Not done:** a check of the ZUGFeRD/CII file from the page (the API validates UBL only on this route); the 30-second timeout of a check was not load-tested.

### Read-only mode refuses every write; a re-verification is one company's (Tier 568 — the demo bank is not for a production installation

Decided by the owner on 07.10.2026 ("按你的建议改"). A mock bank connection ("Demo-Modus") writes three invented `MOCK-…` transactions as a `fints-mock` statement; from then on they are bank transactions like any other — matched to open invoices and, once confirmed, booked as payments. The checkbox was ticked by default in the form and the API defaulted to it (`mockMode ?? true`) in every environment.

- `fints/mock-mode.ts` `mockBankAllowed()`: on outside production (specs, demos), in production only with `FINTS_ALLOW_MOCK=1`; the compose file sets it to `0`.
- `POST /fints/connections`: the default is the demo bank only where it is allowed; asked for explicitly where it is not → 400 with a sentence. A sync of a demo connection is refused there as well, and the 4-hourly auto-sync leaves such connections alone.
- A **real** connection without `FINTS_PIN_ENC_KEY` is refused at creation (400). It used to be created with nothing but a hash of the PIN and failed on its first sync.
- New `GET /fints/capabilities` → `{ mockAllowed, realAvailable }`; the form shows the demo checkbox only when allowed, does not default to it otherwise, and says so when neither kind of connection is possible.

**Correction to the note in Tier 567:** real mode is not a stub as a whole. Fetching accounts and statements goes through the `fints` library (`fints-real.ts`, Tier 22); what is stubbed is submitting a TAN and sending transfers. Whether it works against a real bank was not tested here (no bank access).

Spec 191: with `NODE_ENV=production` an explicit demo connection → 400 (was 201), the default creates no demo connection (was mock), with `FINTS_ALLOW_MOCK=1` → 201. Four assertions fail on the old code. Specs 31/32/37/48/55 (demo and real mode outside production) unchanged and passing.

### Read-only mode refuses every write; a re-verification is one company's (Tier 567 — the all-pages spec opens the pages with a parameter too

`all-pages-quiet-tier564.spec.ts` gained one test that creates a customer and an issued invoice and opens `/dashboard/customers/:id` (+ `/credit`, `/statement`), `/dashboard/invoices/:id`, both cost-center-report pages, `/dashboard/system-health/:name`, and — when the company has a voucher — the two voucher pages, with the same four checks. First real run (37611166946): quiet. (The run before it opened `/dashboard/invoices/undefined`: the fixture had put `costCenter` on the line item, where the DTO does not take it; the fixture now asserts its own ids.) Not opened: `/pay/:token`, `/portal/invoice/:id`.

`cost-center-crud` "Create form shows cost-center + cost-object inputs" failed once and passed on retry in the same run: it typed 1 s after `domcontentloaded`. It now waits for network idle (which means something since Tier 562) and `readyState` first. Its own comment blames a re-render wiping the typed value; whether a real user typing in the first instant can lose input was not established.

**Open, a product decision:** the bank connection (FinTS). Real mode is a documented stub ("Real-mode is a stub in this build"); the "Demo-Modus" checkbox is on by default in the form and in the API (`mockMode ?? true`); a mock connection writes three invented `MOCK-…` transactions as a `fints-mock` statement, and nothing keeps them from being matched and confirmed as payments on real invoices. Suggested: refuse mock connections in production unless a flag allows them. Asked 07.10.2026; decided the same day — see Tier 568.

### Read-only mode refuses every write; a re-verification is one company's (Tier 566 — a receipt that cannot be read is a 400, not the end of the server

Found by feeding damaged files to every upload route with the **real** OCR engine (the specs run the mock; production runs tesseract since Tier 557).

- **One upload ended the backend process.** A job tesseract rejects ("Error attempting to read image") made tesseract.js `throw` inside the worker thread's message handler — it does that when `createWorker` was given no `errorHandler`. An uncaught exception: exit 1, the API gone for every company until something restarts the container. Any user who may scan a receipt could do it with a text file renamed `.png`. Now the worker has an `errorHandler`, a file is checked for PDF/image magic bytes before it reaches the worker, a failed worker start is not cached for good, and whatever cannot be read answers 400 (a damaged PDF was 500). Re-measured with 24 damaged files: all 400, process alive, a good image scans afterwards.
- `main.ts`: an `unhandledRejection` handler that logs. Node's default ends the process on a rejected promise nobody awaits; a type-aware lint run (`no-floating-promises`, not part of CI — too slow, see eslint.config.mjs) found four un-awaited promises outside tests, two of them `doc.destroy()` in `pdf-text.service.ts` inside a `try` that cannot catch a rejection. `bootstrap()` failing now exits 1 with a message.
- `POST /exchange-rates/refresh` answered 500 when the ECB could not be reached (`fetch` rejects); now 503 with a sentence. `ECB_API_URL`, which the production compose file sets and nothing read, replaces the address when set (that is how the 503 was measured).
- Also fed damaged files to `bank-statements/preview` (MT940, CAMT incl. entity expansion and an external entity — nothing read from disk), `signing/verify` and `signing/sign`: all answered 400/2xx quickly, the process lived.

Spec `342-tier566-kaputter-beleg-stuerzt-nicht-ab.sh` restarts the backend with `OCR_ENGINE=tesseract` (as spec 191 does for the auth mode). On the old code its first upload kills the process: 11 assertions fail. **Not covered:** attachments/storage uploads are stored, not parsed, and were not fuzzed further; XRechnung validation (needs Java) was not exercised.

### Read-only mode refuses every write; a re-verification is one company's (Tier 565 — the review of Tiers 545–564, and what it found in them

A code review of this stretch's own diff (`56ad788..HEAD`, 112 files) reported eight findings, all in code written in these tiers. Seven were real and are fixed; one was wrong.

1. **`req.user.companyId` was the user's home company; `req.user.role` the active company's role.** `HeaderAuthGuard` spread the User row and overrode only the role. For a user with grants in two companies the pair described two different companies; for a user without a home company (`User.companyId` is nullable) there was none. Now `companyId` is the verified `x-company-id` (`homeCompanyId` keeps the other). Reproduced on the old code: a viewer at home in the operator's company who is admin elsewhere passed `SystemAdminGuard` (200); with a null home company `POST /system/errors/prune` deleted another company's rows. Specs 333 and 335. (No UI path creates a second grant today — latent, but the null case needs no second grant.)
2. `prune` additionally refuses to run without a company; `vat-validation/reverify-now` takes the active company.
3. **`SYSTEM_ADMIN_EMAILS` was sufficient on its own, and nobody verifies an e-mail address.** Whoever registered a new company with a listed address that had no account yet was the operator (measured: 200). The operator is now always an admin of the oldest company acting in it; the list only narrows that circle. Measured with the variable set: a freshly registered listed address → 403, the oldest company's admin not on the list → 403, on the list → 200.
4. Create-invoice: the company's default VAT mode is not applied to a **clone** (it carries its source's treatment). Since Tier 562 that request succeeds, and a standard invoice cloned in a company defaulting to Reverse-Charge could become a § 13b invoice, depending on which response arrived last. Kleinunternehmer still applies. **Not covered by a spec.**
5. `scripts/baseline-migrations.sh` now diffs the database against the schema before recording anything and stops if they differ — it used to mark every migration applied on whatever database it was given. Tested: a database missing `Payment.eurAmount` → refused, nothing recorded; a current one → 47 recorded.
6. `infra/prod/restore.sh`: a dump that does not load no longer leaves the app stopped on a half-filled database. `gunzip -t` first; on failure the new database is dropped and the previous one renamed back; an EXIT trap starts the app in every case. Tested on the dry-run stack with a truncated dump and with one that fails halfway: data unchanged, no `_before_restore` left, backend healthy; the good dump still restores.
7. Customer page: a tab whose request failed shows an error with "Erneut versuchen" (Tier 562 had made it an empty list, indistinguishable from "none"). Playwright `no-request-loops-tier562` asserts the banner and the retry.

**Withdrawn:** the review claimed Tier 547's read-only allow-list had newly blocked `POST /signing/verify`, the template/statement/merge previews. They carry write actions (`company.update`, `customer.update`) and were already refused by Tier 71's check further down the same guard — not a regression. An allow-list entry added for them had no effect and was removed again. Whether a read-only Berater should be able to use them is a product question, open.

### Read-only mode refuses every write; a re-verification is one company's (Tier 564 — a spec that opens every page

Tier 562's page bugs (three pages fetching in a loop, one calling a route that never existed) were found by opening pages by hand against the production stack; every existing spec tests its own feature and none looks at a page from that side. Playwright `all-pages-quiet-tier564.spec.ts` opens all 44 static dashboard routes as a fresh company and, per page, fails on: an API request repeated more than 6 times in 5 s, a 404 from `/api/v1` (allow-list: `GET /cashbook/close`, where 404 means "no close today"), any 5xx, an uncaught page error, an error screen. First run: all 44 pass (run 37593102675) — after Tier 562's fixes nothing else turned up. Also checked statically: every `/api/v1/...` path in `frontend/src` against the backend's 478 mapped routes; apart from the `/bank-import` call fixed in Tier 562 the few non-matches are paths with a dynamic last segment (`…/${action}`), verified by hand. Not covered by this spec: the 11 routes with a parameter (`[id]` pages) and anything that happens only after a click.

### Read-only mode refuses every write; a re-verification is one company's (Tier 563 — a backup is worth what its restore is worth

Tier 562 made the backup container write dumps; this rehearsed getting one back (scratch databases on the throwaway server, then the whole thing on the isolated dry-run stack).

1. **The documented restore restored nothing.** README: "pipe the dump into the postgres container". The dumps have no `DROP` statements, so into a database that is in use every `CREATE` and `COPY` collides: measured **424 errors, `psql` exit 0, the damaged row and the row created after the backup both still there.** The RUNBOOK described something else again (`pg_restore` of a custom-format archive over `host.docker.internal:5432`) — not this container's format, and the port is not published.
2. **The backup image was two major versions ahead of the server.** Untagged, `prodrigestivill/postgres-backup-local` ships pg_dump 18; the server is `postgres:16`. The dump starts with `SET transaction_timeout`, which 16 rejects, so a restore that stops at the first error (the only safe kind) stopped on line one. Pinned to `:16` (pulled 07.10.2026); spec 341 checks the tag equals the server's version.
3. New `infra/prod/restore.sh`: confirms, stops backend + frontend, **renames** the current database to `<db>_before_restore` (kept, never dropped), loads the dump into a fresh one with `ON_ERROR_STOP`, starts the app. `--list` shows the dumps. Tested end to end on the dry-run stack: register → backup → damage → restore → the original row is back, the damaged database is kept aside, the app answers with the old session; a second restore is refused **before** anything is stopped while `<db>_before_restore` exists. A restored database matches the Prisma schema (0 lines of difference) and its migration history is intact.
4. The compose project has a fixed `name: de-invoice-prod`, so the volumes have one name; the docs used `de-invoice_…`, `deinvoicenet_…`, and the real default was `prod_…`. README and RUNBOOK rewritten around the script; the RUNBOOK's "verify a backup is restorable" snippet was run as written (4084 invoices counted in a scratch database, then dropped).

**Not covered:** `scripts/backup-prod.sh` (rclone/gpg), which the RUNBOOK still mentions for off-site copies — it is not part of the compose stack and was not looked at; the files in `storage` (no backup exists to restore from — Tier 558).

### Read-only mode refuses every write; a re-verification is one company's (Tier 562 — the production stack, run once from end to end

On 07.10.2026 `infra/prod/docker-compose.yml` was run locally for the first time (own compose project `deinv-fulldry`, own container names and volumes, proxy on :18080 without TLS, dummy secrets; the compose file and the production site block of the Caddyfile unchanged). What held: both images build; `prisma migrate deploy` builds the database; register → session cookie (`HttpOnly; SameSite=Lax; Secure`); `x-user-id` → 401, cookie → 200; company, customer, invoice, issue, PDF, XRechnung, search (full-text columns present); logo upload → in the volume, served, still there after the backend container was recreated; receipt scan with the real engine (blank image → nulls); a forged `X-Forwarded-For` did not dodge the login limit and the lockout named the visitor's address, not the proxy's; a forged `X-Forwarded-Host` did not reach the portal link; `/metrics` → 404; sign-in in a real browser and 37 pages opened.

What it found:

1. **The backup container never ran.** It was configured with `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`; `prodrigestivill/postgres-backup-local` reads `POSTGRES_HOST`/`_USER`/`_PASSWORD`/`_DB` and stopped at start. Production would have had **no database backups at all.** Fixed; verified by running one backup (dump with 68 tables and the test invoice). `BACKUP_COMPRESS`, `BACKUP_FILE_PREFIX`, `HEALTHCHECK_URL`, `HEALTHCHECK_PING_URL` are not read by the image either — removed, and the docs that promised a Healthchecks.io ping corrected. The comment that 30 days of dumps "meets § 147 AO" was wrong and is gone.
2. **Pages that fetch in a loop** — invisible in dev and CI, where the rate limit is off. `useI18n()` returned a new `t`, `getDateLocale` and `switchLocale` on every render, and the toast context a new object whenever a toast appeared; all sit in dependency lists of `useCallback(load)` + `useEffect(load)`. Measured in 6 s: settings page — the dunning card's config hundreds of times, then 429 for everything; create-invoice — 232 requests (five lists × 46); customer page — 232, because a tab whose request failed stayed `null` = "not loaded" and was asked for again without end. Now: the i18n functions are stable per locale, the toast API is memoised, a failed customer tab becomes an empty list. After the fix: 14 / 6 / 4 requests.
3. The create-invoice page fetched the company's defaults with a bare `fetch` that sent no `x-company-id` → 401, silently: payment term, VAT mode and the Kleinunternehmer default never reached the form in cookie mode. Through `apiGet` now.
4. The banking page asked `GET /bank-import`, a route that does not exist (404): its list of recent mock transactions was always empty. It uses `/bank-statements` now.

Playwright `no-request-loops-tier562.spec.ts` (settings, create-invoice, a failing customer tab) — **not run against the old code** (no local Playwright stack on this machine: port 3001 belongs to another project); the before/after numbers above are from the browser against the dry-run stack. Spec 341 also asserts the backup variables.

**Still not exercised:** TLS/ACME (needs the domain), the observability overlay, a restore from a dump, SMTP (none configured — mails were logged).

Tier 562b (CI): Playwright `invoice-tax-treatment` "picking Reverse-Charge zeros item VAT" looked for "the first select with an option 0" — that is the payment-term select, not a VAT select. It passed only because the company's default term never loaded (point 3) and that select stood on 0; with the default loading it read 30. The item VAT selects have a test id now (`invoice-item-vat-<n>`) and the test reads that. In the same run backend spec 283 failed once on its archive assertion (`0/0`: the PDF was not in the unzipped archive); it passes locally 3/3 and nothing in this tier touches it — watched on the next run. (It passed on the next run, 37586224922; cause of the one failure unknown.)

### Read-only mode refuses every write; a re-verification is one company's (Tier 561 — the proxy configuration is one Caddy accepts

`infra/prod/Caddyfile` (and `.staging`) had never been run through Caddy. With the image the compose file names (`caddy:2-alpine`, v2.11.7 — pulled on 06.10.2026 with the owner's permission): `caddy validate` → `unrecognized subdirective timeout`. Behind that first error: a `rate_limit` directive stock Caddy does not have, a `reverse_proxy` with three matchers (the 2nd and 3rd would have been read as upstreams), a `{path.1}` placeholder, `/storage/*` and `/uploads/*` routes nothing uses, and in the staging file `on_demand_tls { ask "<a sentence>" }`. Caddy would not have started: the first deployment would have had no site.

Rewritten as three `handle` blocks: `/metrics` → 404 at the proxy (Prometheus scrapes `backend:3001` inside the network; this also settles the open point from Tier 549 — to expose it, set `METRICS_TOKEN` and proxy it), `/api/*` → backend (streaming, `response_header_timeout 60s`), the rest → frontend; security headers and compression as before. No `header_up X-Forwarded-*`: Caddy sets those itself from the connection and drops what a client sends. No rate limit in the proxy — the backend's is per visitor since Tier 555; README and SECURITY.md said otherwise and are corrected.

Verified: `caddy validate` for both files (also with the compose file's own arguments); the production block run in a throwaway container against the local backend — `/metrics` 404, `/api/v1/health` and `/health/deep` 200, the headers present. **Not verified:** TLS/ACME (needs the real domain), the frontend upstream, and the whole stack together — nobody has run `docker compose up` on this file yet. Spec `341-tier561-caddyfile-gueltig.sh` (5 assertions fail on the old files; skips where the image cannot be had).

Tier 561a (CI, a late effect of Tier 553): Playwright `webhook-deliveries-csv-tier203` expects today's date in the export's file name and computed it as the UTC day; the backend names the file by the German day since Tier 553. The run at 22:xx UTC — already the next day in Germany — failed. All 15 places in `frontend/e2e/` that took today from `toISOString()` now use the German day, as the app does.

### Read-only mode refuses every write; a re-verification is one company's (Tier 560 — a company's logo is kept with the other uploaded files

`POST /companies/upload-logo` wrote to `frontend/public/images/` beside the source tree, and the frontend showed `/images/<name>` from its own public directory. That only works where both run from one checkout. In the compose deployment the path is `/frontend/public/images` inside the **backend** container: not a volume — every logo was gone after the next `docker compose up`, and the invoice PDFs lost it — and not the frontend container's directory, so the settings page and the invoice preview never showed a logo at all.

Now `modules/company/logo-store.ts`: `<STORAGE_PATH>/_logos/` (the `storage` volume), found by `findLogo()` (the PDF uses it too; files in the old directory are still found), served by the public `GET /companies/logo/:name` — only names the upload wrote (`logo-<8 hex>-<timestamp>.<ext>`), `nosniff`. Public because an `<img>` cannot send the auth headers and it replaces a file that was public. The two frontend places use it. **After deploying:** logos uploaded before are not in the volume — upload them once more. Spec `340-tier560-logo-im-speicher.sh` (5 assertions fail on old code); specs 23/328/329 look in the new directory.

### Read-only mode refuses every write; a re-verification is one company's (Tier 559 — the migrations build the schema the app runs on

CI and `infra/prod/HETZNER-DEPLOY.sh` created the database with `prisma db push`; `infra/prod/README.md` installs and updates with `prisma migrate deploy`. Nothing compared the two. Measured on a scratch database: the migrations alone left it **fourteen tables short** (UserSession, CustomerPortalSession, Webhook, WebhookDelivery, NoteTemplate, the four SEPA tables, CronHealth, NotificationConfig, CompanySigningKey, the two internal-note tables) **and eleven columns** (AuditLog's hash chain, the Kassenbuch signature, `Expense.paidAt`, `RecurringInvoice.pausedUntil` …) — sign-in cannot work on it. The other way round, a `db push` database has no `_prisma_migrations` table, so `migrate deploy` refuses it (P3005), and no `search_tsv` columns, which only a raw-SQL migration creates.

- `prisma/migrations/20261006000005_catch_up_with_schema`: generated with `prisma migrate diff`, then made repeatable (IF NOT EXISTS / IF EXISTS, guarded constraints; `search_tsv` left alone). Verified on scratch databases: fresh + `migrate deploy` → no difference to the schema; `db push` database + the SQL twice → no error, no difference.
- `backend/scripts/baseline-migrations.sh`: one-time, for a `db push` database — applies the two repeatable migrations and records all as applied; verified (P3005 before, "No pending migrations" after, a second run is a no-op). The image now contains `scripts/`.
- `HETZNER-DEPLOY.sh` uses `migrate deploy`; README says how to bring an older database over.
- Spec `339-tier559-migrationen-ergeben-das-schema.sh` builds a scratch database from the migrations and diffs it against the schema — **from now on a schema change without its migration fails CI.** (Without the catch-up migration: 258 lines of difference.)

**Not known to me:** how the running production database was created. If by `HETZNER-DEPLOY.sh`: run the baseline script once before the next `migrate deploy`; and check that the search works there (it needs `search_tsv`; the baseline script adds it).

### Read-only mode refuses every write; a re-verification is one company's (Tier 558 — the nightly in-app backup does not fail where it cannot run; the files' backup is the operator's

The app's own backup (`scripts/backup.sh` via `docker exec`) belongs to the single-host setup. The production image contains `backend/src` only — no script, no docker CLI — so `daily-auto-backup` failed there every night at 04:00: a red scheduler, an ErrorEvent, a notification, although the compose file's backup container had dumped the database at 03:00. `BackupService.scriptAvailable()`; the scheduler skips with a log line when the script is not there. (The Backups page still lists nothing in that deployment — its backups are in the `backups` volume, outside the app's view.)

**Open, for the operator — not something code fixes:** the production stack backs up the database only. The `storage` volume (receipts, attachments, logos, archived PDFs) is copied by nothing that ships here; `infra/prod/README.md` told the operator to restore it "from offsite" without ever saying how it gets there. The README now says so plainly and gives an rsync example. No spec (deployment-dependent; typecheck only).

### Read-only mode refuses every write; a re-verification is one company's (Tier 557 — production does not scan every receipt as "Musterfirma GmbH, 119,00 EUR"

`OcrModule` chose the engine by `OCR_ENGINE === 'tesseract'`, else the mock — which answers every scan with one invented receipt (supplier, VAT id, IBAN, 100 + 19 = 119). The production compose file never set the variable, so that was production's receipt scanner: the expense form was prefilled with the fixture whatever was uploaded. Now `realOcr()`: tesseract when asked for, the mock when asked for, and in production the real engine by default; the compose file sets `OCR_ENGINE: ${OCR_ENGINE:-tesseract}`. Measured with `NODE_ENV=production` and no variable: log `OCR engine: tesseract (real)`, a blank image → all fields null (was the fixture). **Not verified:** the container image at runtime — tesseract.js fetches the `deu` language data on first use, which needs outbound network from the backend container (or the data baked into the image).

The compose file also passes through, empty unless set in `.env`: `APP_ORIGIN`, `FINTS_PIN_ENC_KEY` (without it a bank connection cannot be created), `SMTP_*` (the environment fallback of the mail settings). Static assertions in spec 191.

### Read-only mode refuses every write; a re-verification is one company's (Tier 556 — a mailed link carries the installation's address, not the request's

The customer portal mails a login link whose token opens the customer's invoices. Both routes that create one — the public `POST /customer-portal/request-session` and the admin's `…/admin/create-session` — built it from `X-Forwarded-Host` / `Host`. Measured: `X-Forwarded-Host: evil.example` → the customer was mailed `https://evil.example/portal?token=<real token>`. (The shipped Caddy config overwrites that header and only serves its own host names, so this needed a different proxy setup or direct access to the backend to exploit — but nothing in the app stopped it.) Password-reset and invitation links took the request's `Origin` (allow-listed by the CORS middleware) and fell back to `http://localhost:<port>` — in production, where `APP_ORIGIN` is not passed to the container, a reset requested without an `Origin` header mailed a localhost link.

New `common/public-origin.ts` `publicOrigin(req)`: the request's origin/host only if it is in `FRONTEND_URL`, else `APP_ORIGIN`, else the first `FRONTEND_URL` entry. Used by all three. Spec `338-tier556-link-adresse.sh` (3 assertions fail on old code). Tier 555a: spec 190's static grep for the old flag expression.

### Read-only mode refuses every write; a re-verification is one company's (Tier 555 — production does not take `x-user-id` for an answer, and knows its visitors apart

Two things the production compose file never told the backend. `infra/prod/docker-compose.yml` gives the backend an explicit `environment:` list; a variable that is only in `infra/prod/.env` is used for `${…}` substitution and does **not** reach the container.

1. `ALLOW_HEADER_AUTH` was not in the list, and the code's default was "on unless `0`" (Tier 400). So a production backend started from this compose file accepted the legacy `x-user-id` header: whoever knew a user's id — every colleague's is in `GET /users` — was that user, without a password. `legacyHeaderAuthAllowed()` is now off by default when `NODE_ENV=production` (on only with `ALLOW_HEADER_AUTH=1`), and the compose file sets `ALLOW_HEADER_AUTH: "0"`. Outside production the default is unchanged (specs authenticate by header).
2. `TRUST_PROXY` was not in the list, and `true` meant `loopback` only — but the proxy is another container. `req.ip` was the proxy's address for every visitor, so the throttler counted the installation as one client: five logins a minute for everyone together, and five requests a minute kept everyone out. `TRUST_PROXY=true` now trusts `loopback, linklocal, uniquelocal` (the backend's port is not published; Caddy overwrites `X-Forwarded-For`), and the compose file sets it. Measured with throttling on: 5×400 then 429 for one forwarded address, a second address unaffected.

Also passed through now: `SYSTEM_ADMIN_EMAILS` (Tier 548), `METRICS_TOKEN` (Tier 549). Still **not** in the list and therefore without effect in that deployment unless added: `SMTP_*` (if mail is configured by environment rather than in the app), `FINTS_PIN_ENC_KEY`, `APP_ORIGIN`, `BACKUP_ROOT`. **I could not look at the running production system** — whether it runs this compose file unchanged is for the operator to check (`docker exec de-invoice-backend env`). After the next deploy sign-in goes by session cookie only; `infra/prod/smoke-test.sh` step 15 accepts the resulting 401.

Spec `191-tier402-production-auth-mode.sh` section 3b (the 401 assertion fails on old code).

### Read-only mode refuses every write; a re-verification is one company's (Tier 554 — the browser's today is the German day as well

The frontend took today as `new Date().toISOString().slice(0, 10)` in 37 places (default issue/payment/booking dates, `max=` of date fields, export file names): the UTC day, i.e. yesterday between 00:00 and 02:00 German time — a form opened then proposed yesterday, and a `max={today}` field refused today although the backend (German day, Tier 478/515) accepts it. New `frontend/src/lib/today.ts` `todayIso()` (Europe/Berlin); all 37 replaced. Also: the dashboard's "last 12 months" start was the local first-of-month written as ISO — the last day of the month before in a German browser; the journal's default range. No new spec (clock-dependent; frontend typecheck + lint, and the existing Playwright suite); `invoice-clone-as-draft-tier160` now computes its expected date the same way.

### Read-only mode refuses every write; a re-verification is one company's (Tier 553 — "today" is the German calendar day, on any server clock

Production runs with `TZ: Europe/Berlin` (infra/prod/docker-compose.yml). Local midnight written with `toISOString()` is 22:00/23:00 UTC of the day before. Measured on a machine in that zone: `GET /recurring-invoices/from-invoice/:id` prefilled `startDate` with yesterday; `GET /reports/datev-preview` and `/datev-export` without dates reported/named the period from 31 December of the previous year (the selection itself was right — date-only values are midnight UTC). And `new Date().toISOString().slice(0,10)` is yesterday between 00:00 and 02:00 German time: the Schlussrechnung's default issue date, ELSTER `Eingangsdatum`, the SEPA files' creation date, the VAT re-verification's day key, export file stamps. All now go through `common/business-date` (`businessTodayIso()`, `businessDayIso(date)`); the instalment proposal's first due date too.

Reviewed and left: the remaining `setHours(0,0,0,0)` sites compare date-only values (`< today`) or bound instants, which is right in both zones. Spec `337-tier553-heute-ist-der-deutsche-tag.sh` — 3 assertions fail on old code **on a server in Germany's zone**; on CI (UTC) the old code passed by accident, so CI does not prove this one.

### Read-only mode refuses every write; a re-verification is one company's (Tier 552 — the error-rate list is the company's too

`GET /system/errors/top-rate` grouped `ErrorEvent` by fingerprint with no company in the where clause (no key at all, so Tier 551's check does not see it): a new company's admin read the messages of every company's recent errors. Now scoped to the caller's company, both the grouping and the row lookup. Found while reviewing the raw-SQL sites after Tier 551 (audit text search, invoice numbers, recurring lock, error timeline: all carry the company). Asserted in spec 335 (2 more assertions fail on old code).

### Read-only mode refuses every write; a re-verification is one company's (Tier 551 — a request without `?companyId=` is not a request for every company

Prisma drops an undefined filter: `where: { companyId: undefined }` selects every row. The auth guard compares a companyId that is present in path/query/body; a missing one passed. Measured as a freshly registered company's admin, leaving the parameter out: `GET /invoices`, `/webhooks`, `/reports/sales`, `/reports/customers`, `/reminders/overdue` → 200 with every company's rows. Found by a marker sweep over the parameterless GET routes (the earlier cross-tenant sweeps only covered routes with an `:id`).

Fix, for every model and operation at once: `prisma/company-scope.extension.ts` refuses a where clause (nested, up to 6 levels) that names `companyId` with the value `undefined` → 400 `companyId ist erforderlich`. It sits under the audit extension. **Rule for new code:** a query that really means all companies (scheduler) leaves the key out — `...(companyId ? { companyId } : {})` — instead of passing `undefined`. Raw SQL (`$queryRaw`) is not covered by the extension. Spec `336-tier551-ohne-companyid-ist-nicht-alle.sh` (10 assertions fail on old code).

Tier 551a (CI): the admin's portal-session route re-read the session with `companyId: body.companyId`, which the body may omit — 4 portal specs got 400; it now uses the caller's company. Playwright `sales-customers-tier189` tests 2 and 6 asserted "missing companyId → 200 with empty result" (their comment believed an undefined filter matches nothing); they now expect 400.

### Read-only mode refuses every write; a re-verification is one company's (Tier 550 — "resolve all" is all of the company's, not all of everyone's

The error list (`GET /system/errors`) shows a company its own rows; its bulk actions did not stop there. Measured as a freshly registered company's admin: `POST /system/errors/mute-all` → `{"count":209}` (every company's open rows), `resolve-all` the same, `prune` deleted every company's resolved/muted/old rows. And `ErrorTrackingService.capture` deduplicated by fingerprint alone, so the same crash reported by a second company was counted on the first company's row and never appeared in its own list. Now all three bulk actions and the dedupe are per company (`prune(days, companyId?)`). Rows without a company (unauthenticated reports) are still shown to nobody and pruned by nobody — open. Spec `335-tier550-fehlerliste-je-firma.sh` (11 assertions fail on old code).

### Read-only mode refuses every write; a re-verification is one company's (Tier 549 — the probes that need no login say that it works, not where

`GET /api/v1/health/deep` is public and forwarded by the proxy. Its `checks.storage.detail` was the storage directory's path on the server, and a failing database check returned the driver's message (host and port). Now `writable` / an error code. `GET /metrics` (also forwarded to the internet by the Caddyfile) counts companies, users, invoices and customers: it stays open by default so the existing scraper keeps working, and needs `Authorization: Bearer` once `METRICS_TOKEN` is set (measured: 401 / 401 / 200). **Open for the operator:** set `METRICS_TOKEN` (and the `authorization` block in `infra/prod/prometheus/prometheus.yml`) or stop forwarding `/metrics` in the Caddyfile. Spec `334-tier549-probes-sagen-nicht-wo.sh` (2 assertions fail on old code).

Tier 549a: spec `38-health.sh` expected the path in `checks.storage.detail` (CI failure) — it now expects `writable`. `infra/prod/smoke-test.sh` step 6 read `database.status`, a field the answer never had (`checks.db.status`), so the step failed on a healthy installation; corrected, not run against production.

### Read-only mode refuses every write; a re-verification is one company's (Tier 548 — the installation's operator, not every company's admin

Registration is public and makes the registrant admin of a new company. The routes that act on the whole installation only asked for a company-level action: a freshly registered admin got 200 on `GET /admin/backups` (server paths), could run/delete backups and restore drills, read and trigger every scheduler (`/admin/cron-health`), read/write the storage configuration, the operator's notification settings, and `POST /fints/auto-run`.

Fix: `auth/system-admin.guard.ts` (`SystemAdminGuard`, `@SystemAuth()`). Operator = e-mails in `SYSTEM_ADMIN_EMAILS` (comma-separated) when set; otherwise admins of the oldest company. Everyone else gets 403. **Production with more than one company should set `SYSTEM_ADMIN_EMAILS`.** Spec `333-tier548-betreiber.sh` (old code: the four GET routes measured 200 for a new tenant; the writing routes were not exercised on old code locally because they would run real backups).

Tier 548c (frontend): the settings page loaded stats, health and the file list in one `Promise.all`, so the operator-only `storage/health` (403) left every other company without its file list — caught by Playwright `storage-download-tier453`. A 403 on `storage/health` / `storage/config` now means "the operator's": no error, and the storage-location form and its save button are not shown.

### Read-only mode refuses every write; a re-verification is one company's (Tier 547)

Read-Only Modus (`x-readonly: 1`, the Berater's view) was checked by the
route's action name. A sweep of every writing route in read-only mode found
six that went through, because their action ends in `.read` or they carry
none (spec 332, 9 assertions fail before): `PATCH /users/:id/role` (200 — a
viewer made admin), `POST /users/invitations` (201 — an admin invited),
`POST /reminders/auto-run` (201 — dunning mails), `PUT
/reminders/mahnungen/fees-config`, `POST /admin/cron-health/clean`, `POST
/vat-validation/reverify-now`.

- `RolesGuard`: in read-only mode the request decides — GET / HEAD / OPTIONS,
  and the POSTs that only read (`invoices/bulk-download`,
  `note-templates/:id/preview`, `ocr/scan`, the browser's error report) or
  belong to the session (`users/me/switch-company`, `auth/…`); anything else
  is 403 "Read-Only Modus aktiv — Schreibvorgang … ist gesperrt". A new
  writing route is refused without anyone listing it.
- `POST /vat-validation/reverify-now` ran the re-verification for **every**
  company and answered with their counts (a fresh company's admin got
  "customers: 255"); it runs for the caller's company. The nightly job is
  unchanged.

The header is set by the client — read-only mode is a guard against
accidents in the Berater's view, not a permission; the role is.

### The bank connection's writing routes need a writing role (Tier 546) — security

A sweep with a `viewer` of the company against every writing route (scratch)
found one 2xx: `POST /fints/auto-match` — it confirms bank matches, i.e.
records payments. The FinTS controller guarded five writing routes with
`reports.read`, which every viewer has: starting a sync, answering its TAN,
the auto-match, **initiating a SEPA transfer** and answering its TAN (spec
331: all five were let through to the handler).

Now sync / TAN / auto-match need `accounting.create`, a transfer and its TAN
`payment.write` — accountant and above. Reading connections, sync runs and
transfers stays `reports.read`.

The other writing routes whose `@Require` ends in `.read` are admin-level
names (`users.read`, `admin.read`: dunning settings, backups, cron health) or
read-like (bulk download, note preview, OCR scan); the routes without a
`@Require` check the role in their handler or are public by design
(customer portal, 2FA of the own account). The viewer sweep confirmed none of
them answers 2xx.

### The customer portal shows the invoice, not the company's record of it (Tier 545)

`GET /customer-portal/invoice/:id` (public, by the customer's session token)
returned the whole Invoice row with its payments. Measured (spec 330, 4
assertions fail before): the customer received the cost centre and cost
object, the internal-notes column, the creating user's id, the stored PDF's
path, the voucher / SEPA batch / recurring-template ids, each line's product
id, and each payment's internal note ("Auto-matched from bank statement <id>
…", or whatever the bookkeeper typed).

`getInvoice` now selects its fields: what is on the invoice, its lines, the
payments with amount, date, method and reference, the open payment reports.
The portal's list and profile, and the payment link (`GET /portal/:token`),
were named field by field already. The customer's scope itself was right:
another customer's invoice, a draft, an amount above what is open — all
refused (probe).

### A logo path is a file name of the company's own, not a path (Tier 544) — security

`Company.logoPath` can be set with `PUT /companies/:id`, and
`resolveLogoPath` (invoice PDF) used an absolute path as it came, then tried
the value relative to the working directory. Measured (spec 329, 7
assertions fail before): logoPath "/tmp/<file>.png" → 200, and the
company's invoice PDF carried that image — any image the server can read,
e.g. another tenant's uploaded receipt scan (attachments are stored as files)
or logo.

- `resolveLogoPath`: only `frontend/public/images/<base name>` with an image
  extension — no absolute path, no working-directory fallback.
- `CompanyService.update`: a changed `logoPath` is a bare image file name
  and, when it has the upload's `logo-<8 hex>-…` form, this company's own. An
  unchanged value passes (the settings form sends the whole record back; an
  older row may hold `images/<name>`), and `""` clears it.

### A logo is an image, whatever its name says (Tier 543) — security

`POST /companies/upload-logo` checked the *declared* type (image/png) and
took the extension from the file's *name*. Measured (spec 328, 8 assertions
fail before): "x.html", declared as image/png, was written as
`logo-<id>-<time>.html` into `frontend/public/images/` — a page with a
script, served from the app's own origin (stored XSS: anyone who opens the
link runs it in their session), and stored as the company's logo. An SVG
with `onload` went the same way.

Now the extension comes from the file's first bytes; only a real PNG, JPEG,
GIF or WebP is accepted, and a PNG named "evil.html" is stored as `.png`.

**On a running installation:** look once for files in
`frontend/public/images/` named `logo-*` that do not end in
.png / .jpg / .jpeg / .gif / .webp and remove them (not done by a migration —
that is a deletion on a server's disk).

### An uploaded Beleg is the file it says it is (Tier 542)

After the cross-tenant sweeps (below) the uploads were probed. Measured (spec
327, 9 assertions fail before): an HTML page uploaded as "beleg.pdf" was
stored and served as application/pdf — `StorageService.saveFile` looked at
the extension only; a 400-character file name was ENAMETOOLONG on disk →
500; an empty file was stored.

- `saveFile`: the first bytes fit the extension (PDF, PNG, JPEG, GIF, WebP,
  TIFF, the Office containers; a .txt has no NUL byte), an empty file is
  refused, and the name on disk keeps its extension and at most 100
  characters before it (`Attachment.originalName` keeps the full one).
- Already right: disallowed types (HTML, SVG, executables) by extension, a
  path in the file name (reduced to its base name), 10 MB.

**Cross-tenant sweeps (scratch, no finding):** company B called every GET
route with the ids of company A's invoice, expense, product, supplier,
recurring template, webhook, asset, payment, customer, company and user —
with its own and with A's `companyId` — and no 2xx carried anything of A's;
the same for every writing route with three bodies: no 2xx, and A's rows
were unchanged afterwards. The UStVA's months, quarters and year add up to
the same figures on a mixed set of documents.

### A company car's trips between home and the business (Tier 541)

The "not covered" of Tier 502 (spec 326). With the 1 % rule the trips between
home and the business premises are not a business expense beyond the
Entfernungspauschale (§ 4 Abs. 5 Satz 1 Nr. 6 EStG): per month 0,03 % of the
list price (a quarter / half of it for an electric car) per kilometre of the
one-way distance, less 0,30 € per km for the first 20 km and 0,38 € from the
21st, per day with the trip — never below 0.

- `CompanyCar.commuteKm` / `commuteDays` (migration
  `20261006000004_company_car_commute`; 15 days a month unless given). Set
  when the car is recorded, changed with `PUT /company-cars/:id` — which now
  touches `untilDate` only when the request carries it.
- `private-use.ts` `monthlyCommute`; `privateCarUse` adds it to each month's
  `income` and reports it as `commute`. It reaches the profit with the
  private use — EÜR / Anlage S 4180, Anlage G 2180 (labels now name both),
  DATEV with the non-VAT part (1800 an 8924). No VAT: the UStVA is unchanged.
- Settings card: "Wohnung–Betrieb (km)", "Tage / Monat" (de / en / zh).

Example (spec): list price 45 678 €, 25 km, 15 days → 342,00 − 118,50 =
223,50 € a month.

Not covered: the Fahrtenbuch method, the Kostendeckelung, the 0,002 % per
trip for fewer than 15 trips a month, a second household.

### Exchange differences are booked (Tier 540)

The "not covered" of Tier 505. An invoice over 1 085 USD is in the books at
the rate of its day: 1 000 €. The customer's bank sends 990 € or 1 010 €.
Measured (spec 325, 13 assertions fail before): the EÜR counted 1 000 €
either way, the DATEV file booked 1 000 € on the bank, the payment kept no
trace of what arrived.

- `Payment.eurAmount` (migration `20261006000003_payment_eur_amount`): the
  euros received for a payment of a foreign-currency invoice. Set by
  `confirmMatch` from a EUR bank entry (all that is left of the entry when it
  settles the invoice or is a part payment), or entered with the payment
  (`eurAmount`; the invoice page shows "In Euro eingegangen (optional)" for a
  foreign-currency invoice). Refused on a EUR invoice. Without it the reports
  use the invoice's rate, as before.
- `accounting/kursdifferenzen.ts`: per payment `eurAmount − amount at the
  invoice's rate`. A gain is income, a loss a cost — EÜR 4190 / 5900 (and
  `kursdifferenzen { gewinn, verlust }`), Anlage S 4190 / 4720, Anlage G
  2190 / 2890; no line of their own on the forms.
- DATEV: beside "Bank an Debitor" at the invoice's rate, the difference
  "Bank an 2660" (gain) / "2150 an Bank" (loss) — the bank account shows what
  the statement shows. Account map: `kursgewinn`, `kursverlust`.
- No VAT moves (§ 16 Abs. 6 UStG: the rate of the supply).

Not done: the GuV / Bilanz of a balance-sheet company (open foreign-currency
receivables are not revalued at year end either); expenses in a foreign
currency; a bank entry that settles a foreign-currency invoice within the 2 %
tolerance counts against the entry at the invoice's rate (Tier 529), so up to
that difference can stay "unmatched" on it.

### The Bewirtungsbeleg's occasion and participants (Tier 539)

An entertainment expense is deductible (70 %, Tier 485) only with its record:
place, day, participants, occasion, amount (§ 4 Abs. 5 Nr. 2 Satz 2 EStG).
The app had no place for the two things the taxpayer adds — the occasion and
the participants — and said nothing about Bewirtungen without them (spec 324;
before: `bewirtungAnlass` → 400 "should not exist").

- `Expense.bewirtungAnlass` / `bewirtungTeilnehmer` (migration
  `20261006000002_expense_bewirtung_nachweis`), accepted by both expense
  routes and the edit.
- `expense-cost.ts` `bewirtungNachweisFehlt`: category "Bewirtung…", not a
  credit note, one of the two empty. Carried by `GET /ustva/expenses` and
  `GET /expenses`; the EÜR has `bewirtungOhneNachweis { count, betrag }`.
- **A hint, not a rule**: the EÜR / Anlage S / G still count such an expense
  at 70 % — the paper Beleg may carry the record, and striking it would move
  every existing company's profit.
- UI (UStVA page's expense form): the two fields appear for a category
  starting with "Bewirtung"; a badge "⚠ Anlass / Teilnehmer fehlen" in the
  list (de / en / zh). No Playwright spec of its own.

### A supplier's Skonto is not booked into a submitted period (Tier 538)

The "not locked" of Tier 537: a bank debit booked against a bill with Skonto
(`bookExpense`) creates a supplier credit note dated with the bank entry.
Measured (spec 323): with June submitted, the debit of 08.06. was booked and
June's Vorsteuer fell by 3,80 € behind the return. `assertPeriodOpen` at the
point where the Skonto is recognised; a payment of the full amount moves no
VAT and is booked either way.

### A submitted UStVA locks its period (Tier 537)

Decided by the user (see Tier 535) — the "Not done" of Tier 443 / 448 / 449.
Until now a return sent to the Finanzamt locked nothing; the history said
"Berichtigung nötig" afterwards. Measured (spec 322, 15 assertions fail
before): after June was submitted, an invoice was issued into June, the June
invoice cancelled, an expense of June entered, changed and deleted, a June
row imported, a cash sale with VAT booked on 15.06. — all 2xx.

- `reports/filed-period.ts` `filedPeriodOf` / `assertPeriodOpen`: a date that
  lies in a period with a **submitted** (or accepted) filing that is not
  released — the month's, the quarter's, or one saved for the whole year — is
  refused with 400: "Die Umsatzsteuer-Voranmeldung 2026-06 wurde am …
  übermittelt — … ist gesperrt. Buchen Sie die Korrektur im laufenden Zeitraum
  (Gutschrift, Storno), oder geben Sie den Zeitraum … frei und übermitteln Sie
  danach eine berichtigte Voranmeldung."
- The date is the one the UStVA assigns by: an invoice's / credit note's
  issue date (issuing, changing or deleting an issued one, cancelling), an
  expense's invoice date (create, both routes; update — old and new date;
  delete; import row → reported), the day of a Kassenbuch entry with VAT that
  belongs to no invoice / expense (create, update, delete, Storno), and the
  payment date of a payment where the tax is owed on receipt — a company with
  Ist-Versteuerung, and the advance on a Proforma. A draft filing locks
  nothing; a payment under Soll-Versteuerung moves no VAT and is not locked.
- Release: `UStvaFiling.releasedAt` (migration
  `20261006000001_ustva_filing_release`), `PUT /ustva/filings/:id/release
  {released}` (permission `ustva.submit`; the audit log keeps who). A
  (re-)submitted return clears it — the corrected return locks the period
  again. `GET /ustva/filings` carries `locked`.
- UI: "🔒 Zeitraum freigeben" / "🔓 Wieder sperren" in the UStVA history
  (de / en / zh), with a confirmation.
- Fixtures: specs 237, 238 and Playwright `ustva-berichtigung-noetig-tier449`
  release the period before they correct it.

Not locked: AfA rows (no VAT), a change of
the company's Besteuerungsart or Kleinunternehmer status. A late supplier
bill dated into a submitted month needs the release (the app assigns input
tax by invoice date; there is no "received on" date).

### The same payment submitted twice within 10 seconds (Tier 536)

Decided by the user (see Tier 535). Measured (spec 321): the payment form's
request sent six times at once recorded six payments of 119 € on an invoice
of 119 € — five became customer credit (595 €).

- `PaymentService.createFromForm` (the route `POST /invoices/:id/payments`
  only): under the invoice's lock, a payment equal to one recorded on this
  invoice in the last 10 seconds — amount, date, method, reference — is a
  409 ("…gerade eben schon erfasst…"). Another amount, date, method or
  reference is another payment; the same one again after 10 seconds too.
  Bank matches, Raten, "Zahlung verteilen" and the system's own bookings go
  to `create` directly.
- Fixture: spec 149 paid 300 € three times with one reference — numbered now.

### A template entered with a start in the past does not bill the time since (Tier 535)

**Decided by the user on 06.10.2026** (three questions asked after Tier 534):

1. The first invoice of a recurring template stays one interval after its
   start date (start 01.11. → first invoice 01.12.) — *keep as it is*.
2. A new template whose start lies in the past: *do not bill the time since,
   start from today* — this tier.
3. The same payment submitted twice: *refuse within 10 seconds* — Tier 536.
4. Of the feature gaps, the *lock on a filed UStVA period* comes first —
   Tier 537. (Exchange differences and the Bewirtungsbeleg fields stay open.)

Measured (spec 320, fails before): a monthly subscription that began on
01.01.2024, entered today — next run 01.02.2024, and the scheduler made one
invoice each morning (February 2024, March 2024, …) until it had caught up,
e-mailed if the template says so.

- `RecurringService.notBeforeToday`: the next run of a template that is
  created, cloned or re-scheduled (an edit of start / interval / day) is the
  first date of its schedule from today on. An existing template keeps its
  date (Tier 519 covers pauses); a back period is billed with "Jetzt
  generieren".
- Fixtures: specs 217 and 279 start their templates in 2030; spec 304 writes
  the 2024 run date to the row.

### Spec 145 and the broken pipe (Tier 533a)

CI run 37392109488 failed spec 145 on `echo "$X" | grep -q …` under
`set -o pipefail`: grep -q left at the first match, the echo got "Broken
pipe" and the assertion failed although the answer was right. Those two
lines use a here-string now. The idiom is in many other specs — if one of
them fails the same way ("write error: Broken pipe" just above the ✗),
that is the cause, not the backend.

### The same request, several times at once (Tier 534)

The services read, decide and write in separate statements. Measured with one
request sent in parallel — a double click, a client's retry, two users (spec
319, 10 assertions fail before):

| | before | now |
|---|---|---|
| an invoice issued 6× at once | its stock taken 5× over (10 → −5; `syncInvoiceStock` of Tier 520 compared and booked without a lock) | once |
| two invoices selling one product at once | one sale lost (read-modify-write) | both — decremented in the database |
| 6 credit notes for one invoice | 1 created, **5 × 500** (voucher number collided) | 1 created, 5 × 400 |
| one bank credit of 119 € matched to two invoices in parallel | both paid (238 €), one 500 | one booked, one 400 |
| 6 Ratenpläne for one invoice | 6 active plans (Tier 522 removed the unique key) | 1 |
| 81 € of customer credit applied 6× | 486 € applied | 81 € |
| 4 opening balances / 4 × 80 € out of a till of 100 € | all booked | 1 each |

- `common/key-lock.ts` `withKeyLock(key, fn)`: one at a time per key,
  re-entrant within a request (AsyncLocalStorage), at most 30 s of waiting —
  then 409, so two requests taking two keys in opposite order end in an
  answer.
- Keys: `invoice:<id>` (InvoiceService `updateStatus` / `update` / `delete` /
  `createCreditNote`, PaymentService `create`, InstallmentPlanService
  `create`), `banktxn:<id>` (`confirmMatch`), `customer:<id>`
  (`applyToInvoice`), `voucher:<companyId>` (VoucherService `create` — the
  number), `cashbook:<companyId>` (entries, close, reopen). Order where two
  are taken: bank entry → invoice → Kassenbuch → voucher; customer → invoice.
  A Kassenbuch entry that belongs to an invoice takes the invoice's lock first.
- **In-process**: the backend runs as one instance (infra/prod). A second
  instance would need the lock in the database (`pg_advisory_xact_lock`, as
  the audit chain uses).

Not covered: the same *valid* payment sent several times (six payments of
119 € on one invoice are six payments — five become customer credit); the
form disables its button, the API has no idempotency key.

### More answers that were a 500 (Tier 533)

The third sweep: all 453 routes with path parameters that are no ids (`x`,
`';--`, 3 000 characters, `../../etc`, `null`) and, for writing routes, `{}`,
`[]` and a body of wrong types. 500 on three routes, plus one found by
reading the remaining `throw new Error(…)` (spec 318, 11 assertions fail
before):

- `POST /fints/connections/:id/sync` for any unknown connection, and the TAN
  route for an unknown run — the service threw a plain Error. Now 404 / 400.
- `PATCH /webhooks/:id` with a list as name or a number as status (inline
  body type); an unknown status and `events` as a text were stored. Now 400.
- `POST /ocr/match-supplier` with a non-string name / vatId. Now 400.
- `POST /invoices/:id/send-email` when the customer has no e-mail address —
  a plain Error. Now 400 with the reason.

The plain Errors that remain are internal (a company that vanished
mid-request, a scheduler's own failures, the DATEV column lookup) or are
mapped by their caller (`'Mahnung not found'` → 404 in the controller).
After this tier the three sweeps return no 5xx.

### A malformed query parameter is a 400; no NUL reaches the database (Tier 532)

The same sweep for the 251 GET routes (scratch fuzz): dates that are none
(`abc`, `2026-02-30`, `2026-13-45`), page numbers below 1 or not numbers, a
year of 99999, array / object parameters, a NUL in a search. 500 on 17 routes
(spec 317, 29 assertions fail before): the Kassenbuch (entries, day, close,
closes, month, export, Kassenabschluss PDF), the voucher list, the customer /
invoice / product lists, the mail log, stock history, the sales / customer
reports, DATEV export and preview, the UStVA expenses — `new Date('abc')`,
`parseInt('abc')`, `skip: -1` or a date in the year 100007 went into Prisma.
And `"\u0000"` in any JSON body or `%00` in any search was a 500 on every
route (PostgreSQL cannot store it).

- `common/query.ts`: `queryDate` / `requiredQueryDate` (a real calendar day
  between 1900 and 2200), `queryInt` / `requiredQueryInt` (whole number in a
  range) — 400 naming the parameter. Used in the routes above; every
  `x ? new Date(x) : …` on a query string in a controller goes through
  `queryDate` now.
- `common/no-nul.ts` + `main.ts`: a request with a NUL character in its URL
  or JSON body is refused as a whole (400).

After the change both sweeps (35 bodies × 6 shapes, 251 GET routes × 4 query
sets) return no 5xx.

### A malformed body is a 400, not a 500 (Tier 531)

35 routes take a body typed by an interface or an inline type, which the
validation pipe does not check. Each was sent `{}`, `[]`, a string, `null`
and bodies with fields of the wrong type (scratch fuzz, not in the repo).
500s on six of them (spec 316, 25 assertions fail before):

- `POST /auth/forgot-password` `{"email": {…}}` and `POST /auth/reset-password`
  `{"token": 5, "password": []}` — both public; `.trim()` on a non-string.
- `POST /users/me/switch-company` `{"companyId": 123}`.
- `POST /customers|expenses|products/import` with a field holding an object
  (500), or a row that is `null` / a number / a string (500, or 201 with the
  row reported as "empty").

Fixed where they are: `typeof` checks in the three controllers, and
`common/import-rows.ts` `assertImportRows` — every row is a record of plain
values (a list of plain values counts: a customer's `tags`), else a 400 that
names the row. The other 29 routes answered 4xx to every body.

### The structured :86: of a German bank statement is read (Tier 530)

German banks write field 86 of an MT940 as a Geschäftsvorfallcode plus
sub-fields (`166?00GUTSCHRIFT?20SVWZ+Rechnung INV-2026-0?21000012?30BIC
?31IBAN?32Name`). The parser read that line as "sub-tag 16" plus text.
Measured (spec 315, 6 assertions fail before): the purpose came out as
`6?00GUTSCHRIFT?20Zahlung A`, the payer's name and IBAN were never found,
and an invoice number broken over two sub-fields was not recognised — of two
open invoices of 119 € the wrong one was suggested first.

- `mt940.ts` `parseStructured86`: ?20–?29 / ?60–?63 joined to the
  Verwendungszweck (continuation lines without a separator), the purpose is
  what follows `SVWZ+`, `EREF+` → `endToEndId`, ?31 → IBAN, ?32 ?33 → name,
  ?00 (Buchungstext) only when there is no purpose. A field 86 that does not
  start with `NNN?NN` is read as before.

Not verified against a real bank's file — the format follows the DK
specification ("MT940, Feld 86"); the specs' own statements use it.

### A bank entry pays once; a statement that bookings rest on stays (Tier 529)

Measured (spec 314, 10 assertions fail before): one credit of 119 € on a
statement, matched to an invoice of 119 € and then to a second one — 201 both
times: two invoices paid, 238 € received on paper from 119 € on the account.
A credit of 300 € matched to three invoices of 119 € paid all three in full
(357 €). `confirmMatch` applied `min(entry, invoice total)` each time and
never looked at the entry's other matches. And `DELETE /bank-statements/:id`
removed a statement with confirmed matches: the payments and their vouchers
stayed, resting on a statement that no longer existed.

- `confirmMatch`: the entry's other confirmed matches count against it (a
  foreign-currency invoice's part back in the entry's currency at that
  invoice's rate); the match takes what is left — the last invoice gets the
  rest as a part payment — and nothing left is a 400. A match taken back
  (`reopen`) frees its amount.
- `deleteStatement`: refused while a match is confirmed or an expense is
  booked from one of its entries (`BankTransaction.voucherId`; a Storno
  clears it).

### One count of the days an invoice is overdue (Tier 528)

Found while checking the other day computations after Tier 519a. Production
(and CI) run with `TZ=Europe/Berlin`. Measured (spec 313, 5 assertions fail
before): an invoice due 40 days ago stood in the dunning list with **39**
days, its Mahnung was stored and printed with 39 — the fee preview said 40.
Due yesterday was "0 Tage überfällig". The list and `sendOne` subtracted the
due date (midnight UTC) from the server's *local* midnight (22:00 / 23:00 UTC
of the day before); two more places used `Date.now()` (a day short between
midnight and 02:00). The auto-dunning's escalation thresholds read the list's
value, so each level went out a day late.

- `reminder/days-overdue.ts` `daysOverdue(dueDate)`: calendar days in Germany.
  Used by the dunning list, `sendOne` (the stored Mahnung, the PDF), the
  letter's data and the fee preview.
- `findOverdueInvoices` / `getReminderStats` compare with `businessTodayDate()`.

Left as they are: the installment checks ("erste Fälligkeit nicht in der
Vergangenheit", the nightly overdue flag) and the Mahnung-per-day idempotency
use the server's local midnight — right with TZ=Europe/Berlin, up to two
hours late on a UTC server.

Tier 528a: the Aging report and the customer portal use `daysOverdue` too
(they counted from the instant / the UTC day — a day short between midnight
and 02:00 in Germany).

### A pause "until yesterday" ended at 02:00 (Tier 519a)

CI run 37380210509 (Tier 525, 22:15 UTC = 00:15 in Germany) failed spec 304:
a date-only `pausedUntil` was stored as 23:59:59.999 **UTC** of that day —
01:59 of the next day in Germany in summer. A pause "until yesterday" was
still running between midnight and 02:00, so the scheduler skipped the
template as paused. `common/business-date.ts` `businessDayEndInstant` gives
the last millisecond of the German day; the controller uses it. (The earlier
runs passed because they ran before midnight.)

### What every invoice prints can be what it claims to be (Tier 527)

Measured (spec 312, 14 assertions fail before), `PUT /companies/:id`: the
IBAN took "DE00 1234" and a German IBAN with a wrong check digit — it is
printed on every invoice and goes into the GiroCode, the XRechnung / ZUGFeRD
payment means and the SEPA files; the Steuernummer took "abc" (§ 14 Abs. 4
Nr. 2 UStG); the name took "   " (issuing was then refused for a missing
name). A supplier's IBAN — where the SEPA transfer goes — took a wrong check
digit (the DTO only asked for 15–34 characters).

- `common/iban.ts` `ibanProblem` / `assertIban` (MOD 97-10; 22 characters for
  a German one; spaces allowed, stored as entered): `CompanyService.update`,
  `SupplierService.create` / `update`. SEPA mandates and batch IBANs were
  checked already (Tier 380, `fints.service.ts`).
- `CompanyService.update`: the Steuernummer is 10–13 digits with `/` or
  spaces; the name is not blank and is trimmed. Empty IBAN / Steuernummer
  stay allowed (the mandatory-details check at issue asks for one of
  Steuernummer / USt-IdNr.).

Not checked: the Steuernummer against a Bundesland's format, the BIC against
the IBAN.

### A Mahnung needs an overdue invoice, and the levels only go up (Tier 526)

Measured (spec 311, 12 assertions fail before): an invoice issued today and
due in 30 days — "Mahnung senden" on the invoice page: 201, a
Zahlungserinnerung with a 5 € fee e-mailed to the customer (0 days overdue).
The cron selects by due date; `sendOne` — the invoice page's button and the
bulk send — took any open invoice. And on an overdue invoice the "letzte
Mahnung", then a "Zahlungserinnerung", then the "1. Mahnung" all went out.

- `BulkReminderService.sendOne`: refused until the day after the due date
  ("Die Rechnung ist noch nicht überfällig (fällig am …)"), and when a higher
  level has already been sent ("…bereits eine Letzte Mahnung versendet — eine
  frühere Mahnstufe kann nicht mehr folgen"). A cancelled Mahnung does not
  count. Starting with a higher level stays the operator's choice.

### The reserved payment methods are reserved on every route (Tier 525)

Left by Tier 514, which refused 'Gutschrift' / 'Guthaben' on
`POST /invoices/:id/payments` only. Measured (spec 310, 10 assertions fail
before): the customer's "Zahlung verteilen" took "Gutschrift" — 201, an
invoice of 1 190 € paid by a "Gutschrift" with no credit note (no money in
the reports) and 810 € booked as the customer's credit; a Rate of a
Ratenplan and a booked Zahlungsmeldung took the two as well.

- `invoice/payment-methods.ts` `assertManualPaymentMethod` — called on every
  route where a person names the method: the invoice's payments,
  `CustomerService.allocatePayment`, `InstallmentPlanService.payInstallment`,
  `PaymentService.bookNotice`. The system's own bookings (a credit note
  settling its invoice, applied credit) go to `PaymentService.create`
  directly and are untouched.

### CI for Tiers 516–524 (one run)

GitHub's hosted runners were short on 05./06.10.2026: jobs were "not acquired
by Runner of type hosted" or the runner was shut down mid-suite, and a newer
push cancels the run before it. Tiers 516–524 therefore share one green run —
37371502075 on `fd32cec`, the Playwright job on its 4th attempt (the earlier
attempts were cancelled by GitHub, none had a failing test). The one real
failure on the way was the Playwright fixture fixed in Tier 523a.

### The Kassenbuch is kept in order of time (Tier 524)

Measured (spec 309, 13 assertions fail before): 16.09. closed with an
Endbestand of 170 €, then a receipt of 5 € booked on the 12.09. (an open,
earlier day) — 201, and the closed day opened and ended 5 € higher than its
signed Tagesabschluss says. `assertDaysOpen` looked at the day itself only.
Receipts were also booked on days before the Anfangsbestand's day, and an
Anfangsbestand after existing entries.

- `assertDaysOpen` (create, update, delete): also refused when a *later* day
  is closed — "Der 16.09.2026 ist bereits abgeschlossen — davor kann nicht
  mehr gebucht oder geändert werden. Buchen Sie am ersten offenen Tag oder
  öffnen Sie die Tagesabschlüsse seit diesem Datum wieder." This also holds
  for a cash payment of an invoice / expense dated before a closed day (they
  book through `createEntry`).
- `assertNotBeforeEroeffnung` / `assertEroeffnung`: nothing before the day of
  the Anfangsbestand; the Anfangsbestand not after the first entry.
- A Storno of an earlier entry stays possible (it is the correction) and
  marks every close from that day on as amended (was: that day's only).

Local: the 60-odd specs that touch the Kassenbuch or cash payments singly —
none refused by this rule (77, 78, 83 fail on the reused database's plans /
templates).

### The three amounts of an expense belong together (Tier 523)

Measured (spec 308, 13 assertions fail before): net 100 + VAT 19 with gross
500 was stored — the EÜR and the UStVA read net and VAT, the payment and the
Kreditor the gross; net 100 at 19 % with 90 € VAT was stored and the 90 € went
into the Vorsteuer; 19 € VAT at 0 % too. On `POST /ustva/expenses`,
`POST /expenses`, the edit and the CSV import.

- `expense/amounts.ts` `expenseAmountsError` / `assertExpenseAmounts`:
  gross = net + VAT (to the cent); the VAT is not more than the rate yields on
  the net (+2 %, at least 10 cents, for a bill that rounds per line); net and
  VAT have the same sign.
- **Less** VAT stays allowed: a reverse-charge or Kleinunternehmer bill has
  none (specs 206, 212, 267 enter those at "19 %, 0 €"), and a part that is
  not deductible is entered as cost.
- The edit checks only when an amount is changed (a row from before stays
  editable otherwise); the import reports the row instead of importing it.

Local: every backend spec singly — 294 pass, none refused by this rule (13
fail on the reused database / the missing frontend, as before).

### A new Ratenplan after the old one; none on a draft (Tier 522)

Measured (probe before the change; spec 307 afterwards — the old code cannot
run against the new schema): an invoice whose Ratenplan had been cancelled
(the customer stopped paying, a new agreement was made) answered "Für diese
Rechnung existiert bereits ein Ratenplan" for good — `InstallmentPlan.invoiceId`
was unique and the cancelled row stays. The same after a plan over a part of
the invoice was completed. And `POST /installment-plans` took a draft (201).

- Schema + migration `20261005000002_installment_plan_per_invoice_many`:
  `invoiceId` is indexed, not unique; `Invoice.installmentPlans` is a list.
- `InstallmentPlanService.create`: one **active** plan per invoice ("läuft
  bereits ein Ratenplan. Stornieren Sie ihn …"); a draft is refused. The new
  plan covers at most what is still open (Tier 429), so the Raten paid under
  the old plan are not asked for again; `syncInstallments` already counts the
  payments since the plan was created.
- `findByInvoice` / the suggestion: the running plan, else the latest.
- Invoice page: "Ratenplan anlegen" and the suggestion banner show whenever no
  plan is *running* (not on a draft). Playwright `installment-plan.spec.ts`
  issues its invoice first.

### A skipped run does not take the period it did not bill (Tier 521)

Found with the unique keys of the schema (after Tier 517). `RecurringRun` is
unique on `(recurringInvoiceId, periodStart)`, and a *skipped* run (paused,
or past the end date) was stored under the period it did not bill. Measured
(spec 306, 10 assertions fail before), a monthly template paused until 2099,
"Jetzt generieren":

- 400 "End date reached; auto-disabled" — it is paused, not ended;
- a second click: **500** (P2002);
- the pause lifted, the same period run: 400 "Already ran for period … (race)"
  — the skipped row held the period, so it was never billed; the scheduler
  would have failed on it every morning. The subscription had stopped.

Now: a skipped row records the moment of the skip (`periodStart = now`, as
the scheduler's own failure rows always did); `RecurringSkip` (a
BadRequestException) says what happened — "Die Vorlage ist bis 01.01.2099
pausiert.", "Das Enddatum ist erreicht — die Vorlage wurde deaktiviert.",
Tier 519's "Die Perioden der Pause werden nicht nachberechnet; nächste
Ausführung am …" — and `runDueTemplates` counts a skip by that class, not by
words in the message ("End date reached" contained neither word it looked
for and counted as failed).

The other unique keys without a company (session / link tokens,
`Invoice.voucherRefId`, `CashBookEntry.paymentId` / `reversesId`,
`InstallmentPlan.invoiceId`, `SepaDirectDebitCollection.invoiceId`,
`PaymentNotice.paymentId`, `UserSigningKey.userId`) each hang on a row that
belongs to one company.

### The stock follows the issued invoice, and only its own company's (Tier 520)

The inventory had never been looked at together with the invoice. Measured
(spec 305, 20 assertions fail before), a tracked product with 10 in stock:

| | before | now |
|---|---|---|
| a draft over 3 | 7 | 10 — a draft takes nothing |
| the draft changed to 1, then deleted | 7, 7 | 10 |
| issued over 3, edited on its day to 5, cancelled | 4 (taken twice), 4, 4 | 7, 5, 10 |
| issued and deleted on its day | stays taken | comes back |
| 50 sold of 10 | stock 0, history "sale 50" | −40 (oversold, and by how much); cancelled → 10 |
| another company's invoice with this product's id | 201; **this company's stock reduced**; the stock warning showed the product's name and quantity; the line stored pointing at the foreign product | 400 "Produkt nicht gefunden." (create and update) |

- `invoice/stock.ts` `syncInvoiceStock`: what an issued INV should hold
  (quantity per tracked product of this company) against what the history
  rows of this invoice say it holds (`previousQty − newQty`, right for the
  clamped rows of before too); the difference is booked as `sale` / `return`.
  Called after `updateStatus`, `update` and `delete` — idempotent, and a draft
  from before this tier gives its stock back the next time it is touched
  (issuing it takes nothing a second time).
- `productsOfItems`: the lines' products are looked up with the company.
- A credit note does not move stock (it may correct a price); goods that came
  back are a "return" on the inventory page. Recurring invoices carry no
  product ids and never moved stock.

### A paused subscription is not billed for the pause afterwards (Tier 519)

Measured (spec 304, 12 assertions fail before): a monthly template with its
next run on 01.06., paused until 30.09. — after the pause the scheduler
billed June, then July, August and September, one each morning (the pause
never moved `nextRunAt`; the manual run and the preview showed June too).
Switching a template off for months and on again did the same. Setting the
pause with a date (`"2026-09-30"`, valid for `@IsDateString`) answered 500 —
the string went to Prisma as it came.

- `RecurringService.nextRunAfterPause` / `firstRunAfter`: once a pause is
  over, the run date is the first one after it. `runOne` stores it; the
  scheduled run stops there when that date has not come ("…skipped (paused)"
  → counted as skipped); `previewNext` shows it.
- `update`: switching on again (`isActive` false → true) or lifting a running
  pause (`pausedUntil: null`) moves `nextRunAt` to the first run date from
  today on.
- A template that was never paused still makes up a missed run (the server
  was down at 06:00) — one period per run, as before.
- Controller: `pausedUntil` becomes a Date; a date-only value means through
  that day. Test-only route `POST recurring-invoices/:id/_test/scheduled-run`
  (not in production) runs one template as the scheduler does.

Not changed: a template created with a start date in the past is billed for
the periods since then, one per morning (the user entered that date; the
preview shows the period).

### Due before the invoice exists; a subscription that ends before it starts (Tier 518)

Measured (spec 303, 9 assertions fail before): an invoice created today with
"fällig 01.01.2020" was stored, and once issued stood in the dunning list
2 468 days overdue — Verzugszinsen since 2020 on a claim that did not exist
then. A draft's due date could be edited to before its issue date. A
recurring template with an end date before its start was stored and never ran.

- `invoice/due-date.ts` `assertDueNotBeforeIssue` (calendar days; due on the
  issue day is a term) in `InvoiceService.create` and `update`.
- `RecurringService.create` / `update` (only when start or end is changed):
  "Das Enddatum liegt vor dem Startdatum."
- Fixtures: specs 82 and 84 made an invoice "overdue with its Skonto window
  open" by dating it today and due in the past — now issued 20 days ago, due
  10 days ago, Skonto 30 days. Spec 79's edit fixture is due in 2030.

### The Tagesabschluss belongs to one company (Tier 517)

Found by spec 301 on a database other specs had used (it closes *today*):
`CashBookDailyClose.businessDate` was `@unique` on its own — across all
companies. Once any company had closed a day, every other company's close of
that day failed with P2002 → **500**; the service looks the close up per
company and found none. In production: one tenant per calendar day.

- Schema + migration `20261005000001_daily_close_per_company`: the key is
  `(companyId, businessDate)` (replaces the global unique and the plain index).
- Spec `302-tier517-tagesabschluss-je-firma.sh` (7 assertions fail before):
  two fresh companies close the same day, each with its own balance; the same
  company a second time stays a 400.

Tier 516's own CI run may show spec 301 red for this reason (whether another
spec closed "today" first); this tier is the fix.

### The Kassenbuch and the Anlagenverzeichnis take no day in the future (Tier 516)

Left by Tier 515 (spec 301, 12 assertions fail on the old code): the
Kassenbuch booked an opening balance and a receipt in 2030 (§ 146 Abs. 1 AO —
a day that has not come has no cash movement; the future row also blocked
closing today), and the Anlagenverzeichnis took an acquisition and a sale in
2030.

- `KassenbuchService.createEntry` / `closeDay` and `AssetsService.create` /
  `update` / `dispose`: `assertNotFuture`. The cashbook and assets pages' date
  inputs have `max` = today.
- Fixtures: spec 175's "day of its own" and spec 183's entry moved from 2031
  to 2021; spec 109's sale on 01.01.2027 is written to the row (the API
  refuses it until then).

### Nothing has happened on a date in the future (Tier 515)

Tier 514 refused a customer payment dated after today; the other dates
still took 2030 (spec 300, 8 assertions fail on the old code): an expense's
invoice date and payment date (cost and input tax in the EÜR / UStVA of
2030), a payment to the Finanzamt, and an invoice issued with a date in the
future (§ 14 Abs. 4 Nr. 3 UStG — revenue and output tax in a period that has
not begun).

- `common/business-date.ts` `assertNotFuture(date, label)` (German calendar
  day): expense create (both paths) and update — `invoiceDate`, `paidAt`;
  `createUstPayment` and `recordFilingPayment` — `paidAt`.
- `updateStatus`: issuing an invoice whose `issueDate` is after today is
  refused, saying to issue it on that day or create it anew with today's
  date (a draft's date is not editable). A draft may carry a later date.

Local verification: every backend spec singly on BACKEND_PORT=3011 with a
restart guard — 291 pass; 8 fail on the reused database's seed-company state
(assets / AfA, a paid seed invoice, the backup check), none on a date; the
full suites on CI's fresh database.

### Reserved payment methods and a payment date in the future (Tier 514)

'Gutschrift' and 'Guthaben' are payment methods the system books — a credit
note settling its invoice, customer credit applied to an invoice — and they
count as "no money arrived" (`NON_CASH_PAYMENT_METHODS`). Measured (spec
299, 7 assertions fail on the old code): `POST /invoices/:id/payments` took
them by hand — an invoice "paid" with no credit note and without touching
the customer's credit —, and a payment dated 2030 was booked (paid today,
income in the EÜR of 2030).

- The payments endpoint refuses 'Gutschrift' / 'Guthaben' (400, pointing to
  the right function); the system's own bookings do not go through it
  ('Anzahlung' was already refused in the service, Tier 472).
- `PaymentService.create`: a payment date after today (German calendar day)
  is refused; the invoice page's date input has `max` = today.
- An overpayment was already right: the excess becomes customer credit.
- Fixtures that dated payments in the future: spec 211 (late Skonto payment
  — the invoice is backdated 30 days for that check), 215 (the Bilanz year
  is last year), 243 (the whole timeline one year earlier).

Local runs: the full backend suite on BACKEND_PORT=3011 lost its backend
twice at specs 201–203 (the Java validations) without any error in its log
— those specs pass singly, and the suite completed on 3011 for Tier 513; it
looks like memory building up in a long run on this machine. Verified
instead: specs 1–200 in the two aborted runs, 203–299 singly with a backend
restart guard (the three fixtures above fixed), the rest on CI.

### A recurring invoice follows the company's VAT treatment (Tier 513)

Tier 480 / 487 put the company's VAT treatment into `InvoiceService.create`
(no VAT for a Kleinunternehmer, 0 % and the flag under the default "reverse
charge" / "igL"). The recurring run builds its invoice itself and took the
template's rates as they were. Measured (spec 298): a Kleinunternehmer's
template with a 19 % line produced 100 € + 19 € VAT (a tax shown without
being owed, § 14c UStG); a reverse-charge company's recurring invoice was a
plain 19 % invoice without the flag.

- `RecurringService.vatTreatment`: from `Company.defaultVatMode` — rates 0
  for kleinunternehmer / reverseCharge / igL, `reverseCharge` /
  `euTransaction` set on the invoice; for igL the customer needs a foreign EU
  USt-IdNr. (`igLVatIdProblem`, as Tier 486) or the run fails with the
  reason. The preview shows the same amounts.

### The backend suite runs on any port (Tier 512)

43 backend specs hard-coded `http://localhost:3001` (153 places) instead of
`$API`, and `local-ci-stack.sh`, `run-all.sh`, `start-backend.sh` and
`kill_backend` knew only :3001. With another program on that port (another
project's server, Tier 510) the suite could not run locally, and single
specs sent part of their requests to that other server.

- Specs: the hard-coded URLs are `$API` (the `HOST` defaults fall back to
  `$API`, then :3001).
- `BACKEND_PORT` (default 3001 — CI unchanged): `local-ci-stack.sh` sets
  `API` from it and guards that port, `start-backend.sh` takes it as PORT,
  `run-all.sh` probes `$API`, `kill_backend` looks at that port. The
  Playwright part still needs :3001 (the frontend build and its specs
  address it) and says so.
- Verified: `BACKEND_PORT=3011 bash scripts/local-ci-stack.sh run` —
  296 / 0 / 1 with a foreign server on :3001, which stayed up.

### The invoice form's credit note, and unknown document types (Tier 511)

`POST /invoices` takes a `type`. Measured (spec 297, 7 assertions fail on
the old code):

- "FOO" was stored as it came — numbered as an INV and then in no report
  (they all filter by type);
- type CN — the create form's credit note, as opposed to the "Gutschrift"
  button's `POST /invoices/:id/credit-note` — took no reference at all, or a
  draft, and any amount: −119 € of revenue with no invoice behind it (§ 31
  Abs. 5 UStDV);
- issuing such a draft was only a status change: its invoice stayed open in
  full although the revenue was taken back.

Now:

- `create`: the type must be INV / RCV / PI / CN. A CN needs
  `referenceInvoiceId` — an INV / RCV of the company, issued and not
  cancelled (`creditableInvoice`) —, takes that invoice's customer (the
  DTO's `customerId` is optional now; other types still get "Kunde ist
  erforderlich"), and may not exceed what the invoice has left to credit
  (`assertCreditable`, other credit notes counted).
- `updateStatus` (issuing a draft CN): the same checks again, then
  `settleIssuedCreditNote` — a 'Gutschrift' payment capped at what is open,
  the invoice paid when that covers it, the rest as customer credit — as
  createCreditNote does.
- Specs 193 (numbering) and 52 (customer statement, Tier 511a — CI run
  37314054283 failed on it) refer their credit notes to an issued invoice.

Local verification: single specs on PORT=3011 (see Tier 510). 43 backend
specs hard-code `http://localhost:3001` instead of `$API`; with another
server on that port they fail locally for that reason alone (11, 81, 82 in
this run) — CI is unaffected.

### A Mahnungspause holds manual and bulk reminders too (Tier 510)

A Mahnungspause (Tier 64) is set when dunning must stop — a dispute, an
agreed delay. `findOverdueInvoices` (the list, the automatic run) respected
it; the send paths did not (spec 296, 6 assertions fail on the old code):
"Mahnung senden" on the invoice page and `POST /reminders/bulk-send` dunned a
paused invoice and a paused customer's invoice, with fees.

- `reminder/pause-hold.ts` (`activePause`, `pauseHoldMessage`): the active
  pause on the invoice or its customer (not a pause an installment plan set
  — Tier 500). `sendOne` refuses it: manual 400 naming the pause and its
  reason, bulk a "failed" row; ending the pause frees the invoice.

**Local test stack and port 3001.** `kill_backend` (e2e/_lib.sh) killed
whatever listened on :3001. On 05.10.2026 that was another project's server
on this machine (`next start -p 3001`). It now kills only a process whose
working directory is this checkout's backend (`own_backend_pids`) and
reports a foreign listener. While :3001 is taken by something else, the
local full suites cannot run (`local-ci-stack.sh` refuses, by design) — run
single specs against `PORT=3011 bash scripts/start-backend.sh` with
`API=http://localhost:3011`, and let CI run the suites. Tier 510 was verified
that way: spec 296 and the reminder specs locally, both suites on CI.

### The Jahresüberschuss is not counted twice in the equity (Tier 509)

The Bilanz showed the whole equity as one Saldoposten (Aktiva − sonstige
Passiva) and left 2400 Jahresüberschuss empty; the E-Bilanz sent that
Saldoposten (bs.equity.retainedEarnings) next to the G+V's Jahresüberschuss
(bs.equity.netIncome). Measured (spec 295, spec 292's fixture): the E-Bilanz
Passiva facts summed to 18 917,50 against a total of 11 900.

- Bilanz: 2400 = the G+V's Jahresüberschuss (after income taxes for a
  Kapitalgesellschaft, Tier 506); EKV = the rest of the equity (capital,
  reserves, carry-forwards — the Berater's placeholder); the section's
  subtotal and `totals.eigenkapital` stay the whole equity. BilanzService
  injects GuVService (no cycle — the GuV reaches KSt 1 lazily).
- E-Bilanz: retainedEarnings (the Saldoposten) = EKV, not the whole equity.
- Spec 107 checks 2400 + EKV = Aktiva − sonstige Passiva.

### The E-Bilanz carries the taxes (Tier 508)

Tier 506 put the Steuerrückstellung (3100), the VAT still owed (4600), tax
refunds due (1800) and the income taxes (GuV position 14) into the Bilanz /
GuV. The E-Bilanz still sent them as placeholders (spec 294): its
Jahresüberschuss was after taxes while is.tax.incomeTax was empty, and its
Bilanz positions no longer added up to its totals.

- `ebilanz-mapping.ts`: bs.ass.currAssets.othReceivables, bs.liab.accr.
  taxProvisions (own source `bilanz.passiva.rueckstellungen.steuern` — the
  pension / other provisions stay placeholders), bs.liab.cred.
  othLiabRemaining and is.tax.incomeTax are computed; `ebilanz.service.ts`
  fills them from Bilanz 1800 / 3100 / 4600 and GuV 14 (null for other
  legal forms). Counts for a GmbH: 27 computed, 24 placeholders (spec 114).

### KSt prepayments (Tier 507)

The Steuerrückstellung (Tier 506) deducted the GewSt prepayments only — KSt
(+ Soli) prepayments, four a year on the Vorauszahlungsbescheid, could not
be recorded (spec 293: `PUT /accounting/kst1/vorauszahlungen` 404).

- `PUT /accounting/kst1/vorauszahlungen` { year, q1–q4 } (KSt + Soli paid),
  stored as `settings.kstVorauszahlungen[year]` like the GewSt ones.
- KSt 1: `kstVorauszahlungen` (the quarters), `totals.vorauszahlungen` (KSt
  + GewSt prepaid) and `totals.verbleibend` (zuZahlen − them; negative = a
  refund); `zuZahlen` unchanged.
- Bilanz: 3100 = `verbleibend`; a negative one goes to 1800.
- UI: the KSt 1 section has the four quarter inputs and shows what is left.
  Playwright `kst-vorauszahlungen-tier507.spec.ts`.

### Income taxes in a GmbH's GuV and Bilanz (Tier 506)

User decision: compute them. Measured (spec 292): a Kapitalgesellschaft's
GuV left position 14 "Steuern vom Einkommen und Ertrag" empty ("in v1 nicht
erfasst") — the Jahresüberschuss was the result before KSt / Soli / GewSt,
~30 % too high —, and the Bilanz showed neither a Steuerrückstellung nor the
VAT still owed (both "nicht ausgewiesen"; the Saldoposten held them).

- GuV (`compute(companyId, year, { preTax })`): for a Kapitalgesellschaft
  position 14 = KSt 1's "Zu zahlen" (KSt + Soli + GewSt) and the
  Jahresüberschuss after it; KSt 1 reads the GuV with `preTax: true`, so its
  zvE is unchanged. KSt1Service is resolved lazily (ModuleRef + dynamic
  import) — it injects the GuV. Anhang, E-Bilanz and the Berater package use
  the after-tax figure. Other legal forms: position 14 stays empty.
- KSt1Service no longer injects BilanzService (it never used it — and the
  Bilanz now reads KSt 1).
- Bilanz (`taxBalances`): 3100 Steuerrückstellungen = KSt 1 "Zu zahlen" −
  GewSt prepayments recorded (`settings.gewstVorauszahlungen`; the KSt
  prepayments followed in Tier 507); 4600 Sonstige
  Verbindlichkeiten = the year's UStVA Kz 83 (12 months) − payments recorded
  on that year's returns by 31.12. (Tier 483). Negative balances go to 1800
  Sonstige Forderungen. The Saldoposten shrinks accordingly.

The VAT figure relies on the payments being recorded in the UStVA history;
without them the whole year's VAT shows as owed.

### A EUR bank receipt on a foreign-currency invoice (Tier 505)

A payment's amount is in the invoice's currency (DATEV and the EÜR convert
it at the invoice's rate, Tier 118 / 362). Measured (spec 291): matching a
EUR bank credit to a USD invoice booked the euros as if they were dollars —
1 000 € for a 1 085 USD invoice (= 1 000 € at its rate) became a payment of
"1 000 USD", the invoice stayed open for 85 USD and the reports counted
921,66 €.

- `BankImportService.confirmMatch` (auto-match and manual match): a EUR
  credit on a non-EUR invoice is converted at the invoice's rate ("1 EUR =
  rate"); within 2 % of what is open (the rate moved in between) it settles
  the invoice, otherwise it is a partial payment. Skonto detection works on
  the converted amount.

Not covered: the exchange difference itself (Kursgewinn / -verlust, § 4 Abs.
3 EStG counts what was received). The EÜR / DATEV keep the invoice's rate —
990 € received are counted as 1 000 €; the Berater books the 10 € difference
(SKR03 2150 / 2660).

### The home office (Tier 504)

Since 2023 a sole trader / partner deducts either the Tagespauschale (6 €
per day worked mainly at home, at most 210 days = 1 260 €, § 4 Abs. 5 Nr. 6c
EStG) or, for a home office that is the centre of the whole activity, the
Jahrespauschale (1 260 €, a twelfth less per full month without, Nr. 6b).
Nothing marked either (spec 290: `PUT /home-office/:year` 404, no line in
the EÜR, Anlage S / G, no DATEV booking).

- Model `HomeOffice` (migration 20261002000004; unique per company and year;
  audited): method, days / months. `GET/PUT/DELETE /home-office/:year` (from
  2023; 400 for a Kapitalgesellschaft — its managing director claims it as
  Werbungskosten). `home-office/home-office.ts`: `homeOfficeAmount`,
  `homeOfficeDeduction`.
- EÜR line 5410, Anlage S 4645, Anlage G 2205 (both Gewinnermittlungen):
  "Häusliches Arbeitszimmer / Homeoffice-Pauschale". DATEV: on 31.12.,
  4288 an 1890 (Privateinlagen — no payment behind a Pauschale); account map
  `homeOffice`. The line-count specs (102 / 106 / 126, Playwright anlage-eur
  / anlage-s) count it.
- UI: settings card "Homeoffice / häusliches Arbeitszimmer" (year, method,
  days or months). Playwright `home-office-tier504.spec.ts`.

The actual costs of an Arbeitszimmer (instead of the Jahrespauschale) stay
ordinary expenses; the user must not claim both.

### Business gifts and the 50 € limit (Tier 503)

§ 4 Abs. 5 Nr. 1 EStG: gifts to business contacts are deductible only if
all gifts to that recipient in the year cost no more than 50 € (net; gross
without input-tax deduction); above it none of them — nor its input tax
(§ 15 Abs. 1a UStG). The recipient's name must be recorded (§ 4 Abs. 7
EStG); without it only a Streuartikel (≤ 10 €). A gift (category
"Geschenk…") was an expense like any other: deducted in full, the input tax
claimed, and no recipient could be recorded (spec 289, 9 assertions fail on
the old code).

- `Expense.giftRecipient` (migration 20261002000003), in the create / update
  DTOs; the UStVA expense form shows the field for a "Geschenk…" category.
- `accounting/gifts.ts`: `nonDeductibleGifts` (per recipient — trimmed,
  case-insensitive — and calendar year; without a recipient > 10 €),
  `nonDeductibleGiftIds` (for any expense list, judged against all the
  company's gifts of their years), `nichtAbziehbareGeschenke` (gross).
- EÜR / Anlage S / Anlage G: such gifts are left out of the expenses and the
  paid input tax; `totals.nichtAbziehbareGeschenke` shows them. UStVA: no
  input tax for them. KSt 1: Kz 80 adds their net cost back (with the 30 %
  of Bewirtung).

A gift that later crosses the limit (a second gift in November) takes the
input tax off the earlier month too — a submitted return is then flagged
"Berichtigung nötig" (Tier 449); the correction may also be made in the
later period. The GuV / BWA keep gifts at net cost (the lost input tax is
not added there).

### Private use of a company car — the 1 % rule (Tier 502)

User decision: build it. Nothing existed (spec 288: `POST /company-cars`
404; no private use in the UStVA, EÜR, Anlage S / G, DATEV).

- Model `CompanyCar` (migration 20261002000002; audited): name, gross list
  price, method (`one_percent`, `electric_025`, `electric_05`), from / until.
  `company-car` module: `GET/POST /company-cars`, `PUT /:id` (end date),
  `DELETE /:id`, `GET /company-cars/private-use?year`. Refused (400) for a
  Kapitalgesellschaft — there the private use is the managing director's
  payroll (geldwerter Vorteil).
- `company-car/private-use.ts` (`privateCarUse`): per calendar month a car is
  there (any day counts the whole month), the list price rounded down to full
  hundreds × 1 % (0,25 % / 0,5 % for electric) = the withdrawal; VAT on 80 %
  of the **1 %** value (also for an electric car — the reduction is income
  tax only) at 19 %; none for a Kleinunternehmer. Months: a boundary month
  reached by less than 12 h is not counted (callers end periods at local or
  UTC midnight), and never beyond the current month.
- UStVA: the Wertabgabe in the 19 % bucket (Kz 81) of its month. EÜR: lines
  4180 "Private Kfz-Nutzung" and 4145 "Umsatzsteuer auf unentgeltliche
  Wertabgaben"; Anlage S the same; Anlage G 2180 (both Gewinnermittlungen)
  and the VAT in 2195 (EÜR only). DATEV: per car and month on its last day
  1800 an 8921 (VAT part, key 3) and 1800 an 8924 (the rest; reversed for an
  electric car). Account map: `privateUseVat19` / `privateUseNoVat`.
- UI: settings card "Firmenwagen (private Nutzung)" — add, end, delete, the
  year's private use. Playwright `company-cars-tier502.spec.ts`.

Not covered: the Fahrtenbuch method, trips home–business (0,03 % / 0,002 %),
the Kostendeckelung, the Bilanz / GuV of a balance-sheet sole trader (the
withdrawal reaches Anlage G there, not the GuV).

### The December UStVA deducts the Sondervorauszahlung (Tier 501)

A monthly filer with Dauerfristverlängerung pays 1/11 of the previous
year's Vorauszahlungen as Sondervorauszahlung (§ 47 UStDV) and deducts it
in the December return (Kz 39, § 48 Abs. 4 UStDV). It could be recorded
(Tier 484, `UstPayment` kind 'sondervorauszahlung', for the EÜR), but the
December UStVA never deducted it: Kz 83 asked for it a second time and the
ELSTER data had no Kz 39 (spec 287).

- `UstvaService.compute` for month 12 (not a quarter): Kz 39 = the year's
  recorded Sondervorauszahlungen, `differenzbetrag` (Kz 83) net of it,
  `sondervorauszahlung` on the data (and accepted by the filing DTO — the
  UStVA data is posted back to save a filing, cf. Tier 491).
- `ustvaKennzahlen`: Kz 39 (shown on the page, written to the ELSTER data).
- UStJA: the Vorauszahlungssoll adds it back (it was an advance payment of
  the year), so the Abschlusszahlung is unchanged.

Recording the Sondervorauszahlung after the December return was submitted
flags that return "Berichtigung nötig" (Tier 449) — as it should.

### An invoice under a kept installment plan is not dunned (Tier 500)

A Ratenplan is a Stundung: while no installment is late the customer is not
in Verzug for the invoice (§ 286 BGB). Measured (spec 286, 6 assertions fail
on the old code): the plan's Mahnungspause (Tier 64 / 429) kept the invoice
off the overdue list, but a manual reminder for the full amount went out
(`POST /reminders/send` 201) — and once an installment was late, the
open-ended pause kept the invoice from being dunned at all.

- `reminder/installment-hold.ts` (`invoicesHeldByPlan`): an active plan with
  no overdue installment (unpaid, due before today) holds the invoice.
  `findOverdueInvoices` (list, auto-run) leaves it out; `sendOne` (manual
  and bulk) refuses it with `PLAN_HOLD_MESSAGE` (manual: 400; bulk: a
  "failed" row with the reason, as for a Proforma).
- A late installment breaks the plan: the invoice is dunned again.
- `Mahnungspause.installmentPlanId` (migration 20261002000001, backfilled for
  existing plan pauses): the pause a plan creates is linked to it and no
  longer counted — the plan decides. Pauses set by hand are unchanged.

### An invoice's total is above 0 (Tier 499)

Measured (spec 285, 9 assertions fail on the old code): `POST /invoices`
took an INV of −595 € (one line of −500 €) and one of 0 €, an edit could
turn an invoice negative, and both could be issued. A negative "invoice" is
a credit note without the invoice it corrects (§ 31 Abs. 5 UStDV) and went
into the UStVA and the EÜR as negative revenue; a 0 € one is no invoice.

- `assertPositiveTotal` (invoice-amounts.ts): in `create`, `update`, on
  issuing (a draft saved before) and in a recurring run — 400 pointing to
  "Gutschrift". The check is on the total before a credit note's sign, so
  credit notes are unaffected; a negative discount line in a positive
  invoice stays allowed.

### An igL / EU reverse-charge invoice states both USt-IdNrn. (Tier 498)

§ 14a Abs. 1 / 3 UStG: an innergemeinschaftliche Lieferung, or a B2B
service whose tax a customer in another member state owes, needs the
USt-IdNr. of supplier and recipient on the invoice. Tier 494 accepted a
Steuernummer for the supplier: measured (spec 284), a company with a
Steuernummer only issued an igL and an EU reverse-charge invoice, and the
latter also to a customer without a USt-IdNr.

- `missingInvoiceDetails` (mandatory-details.ts): for `euTransaction`, or
  `reverseCharge` with a customer in another member state, the company's
  and the customer's USt-IdNr. are required. A domestic § 13b invoice
  (Bauleistung) and every domestic invoice keep accepting the Steuernummer.
- `fixture_issuer "$C" <vatId>` sets the fixture company's USt-IdNr. (only
  when empty); used by the specs that issue igL / EU services (199, 206,
  212, 273, 277) and the Playwright ZM test.

### The archive copy is the issued invoice (Tier 497)

The first PDF download is stored (`Invoice.pdfPath`) and handed over "as
issued" by the GoBD archive, the GoBD export and the DATEV bundle (Tier
420). Measured (spec 283, 5 assertions fail on the old code): a draft's
download was stored too — the draft was then edited and issued, and the
archive held the old draft, with the old line and amount and (since Tier
496) the ENTWURF watermark; a same-day edit of an issued invoice (Tier 477)
kept the stale copy as well.

- `GET /invoices/:id/pdf` stores nothing for a draft.
- Issuing (draft → issued) and every `update()` clear `pdfPath`; the next
  download stores the current document.

Existing data: copies stored before this tier from a draft download cannot
be told apart from a correct one. If an archive shows a document that
differs from the invoice record, clear its `pdfPath` and download it once
(only what the customer actually received belongs in the archive — check
the EmailSend row / the customer's copy first).

### A draft stays internal (Tier 496)

A draft is not an invoice: not counted (UStVA, EÜR, OPOS), still editable
and deletable. Measured (spec 282): the customer portal listed the
customer's drafts with their amounts, opened them and served their PDF; a
payment link could be minted for a draft (and a cancelled invoice); and a
draft's PDF looked exactly like the issued invoice.

- Customer portal (`customer-portal.service.ts`): list, detail, PDF and
  mark-paid exclude drafts (a draft is 404 there).
- `PortalService.generateLink`: 400 for a draft or a cancelled invoice; the
  detail page hides "Zahlungslink anzeigen" for them.
- PDF: a draft says "ENTWURF – keine gültige Rechnung" above the title and
  carries a light "ENTWURF" watermark on every page.
- Spec 63 now mints its payment link on an invoice it issues itself (it took
  the seed's first draft); Playwright `portal.spec` opens an issued invoice.

### E-mailing a draft issues it the regular way (Tier 495)

`InvoiceEmailService.sendInvoiceByEmail` wrote `status: 'sent'` straight
onto a draft after the mail had gone out. Measured (spec 281, 9 assertions
fail on the old code): that skipped Tier 494 — an invoice without the
mandatory details went out by e-mail —, Tier 472 — a final invoice e-mailed
as a draft never booked the Proforma's advance, stayed open for the full
amount and kept the advance in Bilanz 4200 —, and the `invoice.sent`
webhook. A cancelled invoice could be e-mailed too.

- A cancelled invoice: 400, nothing sent.
- A draft (with a valid recipient) is issued through
  `InvoiceService.updateStatus` before the PDF is rendered, then reloaded,
  so the PDF carries the advance deduction. A refusal (missing details) is
  a 400 and nothing goes out. Applies to the single send, the bulk sends and
  a recurring template that e-mails its drafts.

### An invoice is issued only with its mandatory details (Tier 494)

§ 14 Abs. 4 UStG: name and address of supplier and recipient, the
supplier's Steuernummer or USt-IdNr. Measured: a freshly registered company
(empty address, no tax number) issued a 1 190 € invoice to a customer
without an address — `PUT …/status {"status":"sent"}` 200. The recipient of
such an invoice loses the input-tax deduction. User decision: block.

- `src/modules/invoice/mandatory-details.ts` (`missingInvoiceDetails`,
  `assertInvoiceDetails`): the company's name and address (street, PLZ,
  city); above 250 € gross also its Steuernummer or USt-IdNr. and the
  customer's name and address. Kleinbetragsrechnung (≤ 250 €, § 33 UStDV):
  name and address of the supplier only — not for igL / § 13b.
- Checked on draft → issued in `updateStatus` (not for a credit note, which
  is created from an issued invoice) and in a recurring run whose template
  issues its invoices (`invoiceStatus: 'sent'`) — the run fails with the
  list and is retried on the next tick. 400 names everything missing; the
  UI shows it as the toast it already showed for status errors.
- Test fixtures: `fixture_issuer "$C"` in `e2e/_lib.sh` fills the address
  and tax number of a freshly registered company (only what is empty);
  customers in the fixtures got addresses. Spec 280.

Existing users without an address / tax number in their company profile
must complete it before their next invoice; existing customers without an
address too (above 250 €).

### The Leistungszeitraum (Tier 493)

A recurring service or a project is supplied over a period (§ 14 Abs. 4
Nr. 6 UStG: "Zeitpunkt der Lieferung … oder Zeitraum"). An invoice could only
carry one date: `servicePeriodStart/End` were rejected, a monthly maintenance
invoice stated its issue date, and XRechnung's InvoicePeriod was that one day
(spec 279: 11 assertions fail on the old code).

- `Invoice.servicePeriodStart/End` (migration 20261001000001), create and
  update via `service-period.ts` (`servicePeriodOf`: both or neither, start ≤
  end, else 400).
- PDF: "Leistungszeitraum:" over two rows (one would run into the label
  column) instead of the Leistungsdatum. XRechnung InvoicePeriod (BT-73/74)
  and ZUGFeRD `BillingSpecifiedPeriod` (after the tax breakdown, CII order);
  with a period, BT-72 only when a date was recorded.
- `RecurringInvoice.servicePeriod`: 'none' (default for existing templates —
  unchanged), 'current' (the interval starting on the run date, in advance)
  or 'previous' (the one before, in arrears; `advanceTo` with a negative
  count). Set on the run and shown in the preview; cloned with the template.
- UI: period inputs on the invoice form, the period on the detail page, a
  selector in the recurring form (default "laufender Zeitraum" for a new
  template). Playwright `service-period-tier493.spec.ts`.

### The Leistungsdatum on the invoice PDF (Tier 492)

§ 14 Abs. 4 Nr. 6 UStG: the date of supply is a mandatory invoice field,
also when it equals the issue date. The create form pre-fills it, but an
invoice created through the API or by a recurring schedule has no
`deliveryDate` — its PDF stated no date of supply at all, and a recorded
one was labelled "Liefertermin" (spec 278: 4 assertions fail on the old
code). The schema comment even claimed § 14 did not require it.

- PDF: "Leistungsdatum:" with the recorded date, or the issue date — as
  BT-72 in XRechnung / ZUGFeRD (Tier 414) already did. A Proforma (no supply
  yet) and a credit note show a recorded date only.
- Invoice detail page: the same row and fallback; create form label
  "Leistungsdatum (optional)" with the hint that the issue date stands in.

A Leistungs*zeitraum* (monthly services) followed in Tier 493.

### Zusammenfassende Meldung (Tier 491)

§ 18a UStG: a company with innergemeinschaftliche Lieferungen or B2B services
in the EU reports them per customer USt-IdNr. The app issued such invoices
(UStVA Kz 41 / Kz 21) but had no ZM (spec 277: `GET /ustva/zm` 404, 7
assertions fail on the old code).

- `UstvaService.compute` collects the ZM entries where it adds up Kz 41 (igL,
  kind **L**) and Kz 21 (EU B2B services, kind **S**) — per normalised
  USt-IdNr. (`zm` in the UStVA data) — so ZM and UStVA always agree.
- `GET /ustva/zm?year&quarter|month` — rows {land, ustIdNr, art, betrag in
  full euros}, sums, `abgleich` with Kz 41 / Kz 21 (`stimmt`), hints (an
  entry without USt-IdNr.), disclaimer. `GET /ustva/zm.csv` —
  Länderkennzeichen;USt-IdNr;Betrag;Art. A credit note counts in its own
  period (a negative row); corrections of an earlier period are the
  Berater's.
- UI: card "Zusammenfassende Meldung — Vorschau" on the UStVA page (year,
  quarter, table, reconciliation, CSV); Playwright `zm-tier491.spec.ts`.

The CSV is a plain export — the BZSt upload format (BZStOnline / ELMA) is to
be verified before the first submission (HANDOFF §9, with the ELSTER XML).

### The USt-IdNr. is normalised and its EU format checked (Tier 490)

Measured (spec 276, 9 assertions fail on the old code): a customer's
USt-IdNr. was stored as typed — "fr 12 345 678 901", "CHE-123.456.789" —
"FR1" and the Greek "GR123456789" (Greece's prefix is EL) were accepted, a
supplier's "DE12" too, the company's own number lower case with spaces; and
Tier 486's igL check, reading the prefix only, issued tax-free igL invoices to
"FR1". `src/common/vat-id.ts`: `normalizeVatId` (upper case, no spaces /
dots / dashes), `vatIdFormatProblem` (the VIES format of each member state +
XI; GR → "use EL"; non-EU numbers left alone), `withCheckedVatId` for
create / update payloads. Applied to customers (create, update, CSV import —
the row is reported), suppliers, the company, and inside `igLVatIdProblem`
(a number stored before this tier). Because the customer form sends the
number with every save, a customer with an old malformed number can be saved
again only once it is corrected (the message says why).
Local runs: backend **275 / 0 / 1**; 1 × 5xx in ErrorEvent — the 503 of spec 257
(Tier 471) probing `GET /customers` while it restarts the database ("Server
has closed the connection"): the intended answer, recorded this time because
the write got through after the restart. Playwright **949**.

### A supplier invoice is entered once (Tier 489)

Measured: invoice RE-4711 of one supplier entered three times (twice via
`/ustva/expenses`, once via `/expenses`) — 201 each, the UStVA deducted 57 €
input tax instead of 19 (spec 275: 7 assertions fail on the old code, with
four entries 76). `expense-duplicate.ts`: the same supplier's invoice number
(case and spaces ignored) is refused with 409 naming the bill already
entered, unless `confirmDuplicate: true` (a genuinely second bill — the UStVA
form asks); the CSV import reports such a row instead of importing it. Another
supplier's number and the supplier's credit note under the same number are no
duplicates. The OCR save shows the 409 message as its error.
Local runs: backend **274 / 0 / 1**, 0 × 5xx; Playwright **949** — on the second
attempt: in the first the backend process vanished during the heaviest test
(ocr-upload "scanned PDF … raster+OCR fallback") with nothing in its log and
the machine at ~150 MB free memory, and everything after it failed; the
re-run passed all 949, that test included.

### A bank transaction is imported once (Tier 488)

Measured (spec 274, 5 assertions fail on the old code): the same CAMT file
imported twice gave two statements and the 1 190 € receipt twice (201 both
times); the copy stayed open, to be matched or booked as an expense a
second time (matching it to the already-paid invoice was refused, but a
debit could be booked twice). `importStatement` now skips transactions
already imported — same account IBAN, value date, amount, end-to-end
reference, purpose, counterparty IBAN — counted per key, so two genuinely
identical bookings in one file both stay and only as many as already exist
are skipped (overlapping daily / monthly statements work). A file with
nothing new answers 409; the response carries `skippedDuplicates`, and the
import page shows "{n} bereits importierte Umsätze übersprungen".
Limit: two different payments with the same day and amount and no purpose,
reference or counterparty IBAN, arriving in two *different* files, look the
same — the second is skipped (within one file both stay).
Spec 235 imported one 119 € receipt three times (only the statement's `:20:`
changed) to stand for three payments — now duplicates; its fixture got a
structured `:86:` purpose (`?20…`) that differs per payment. Local runs:
backend 273 / 1 / 0 → 235 green after that, 0 × 5xx; Playwright **949**.

### An igL or § 13b invoice charges no VAT (Tier 487)

Measured (spec 273, 6 assertions fail on the old code): an invoice marked
igL and one marked § 13b, each with a 1 000 € line at 19 % — what an API
caller or an import sends; the form sets 0 % itself — went out at 1 190 €
with "USt 19 %: 190,00" (owed under § 14c UStG), and the UStVA declared 380 €
output tax and 0 € in Kz 41. Tier 480's `withoutVatForKleinunternehmer` is
now `withoutVatWhereNoneIsCharged`: the lines go to 0 % for a
Kleinunternehmer, and for an igL / § 13b invoice — the flag the invoice ends
up with: the caller's, the existing invoice's on an update, else the company
default. A standard invoice keeps its rates.
Local runs: backend **272 / 0 / 1**, 0 × 5xx; Playwright 948 + 1 —
`cost-center-monthly` (Tier 45) failed on 1 October, unrelated to this tier:
its beforeAll seeded a July invoice as a **draft** (the report counts issued
documents only) and passed only while other seed data dated relative to
today fell into July. The seed is now issued; green 2 × on re-run.

### An igL needs the customer's foreign EU VAT ID (Tier 486)

§ 4 Nr. 1b, § 6a Abs. 1 Nr. 4 UStG (since 2020 a material requirement): an
innergemeinschaftliche Lieferung is tax-free only to a business with the
USt-IdNr. of another EU member state. Measured (spec 272, 5 assertions fail
on the old code): invoices marked igL — 0 %, the § 1a note — were issued to a
French customer without an USt-IdNr., to a German one with a DE-IdNr. and to
a Swiss number (201 each); all owe 19 %, and the UStVA quietly moved them to
"sonstige steuerfreie Umsätze" (its own igL test did require an EU VAT ID).
`create()` / `update()` (also when an igL invoice's customer changes, and
when the igL comes from the company default `defaultVatMode: 'igL'` —
the first version checked only an explicit flag, Playwright tier176 test 4
showed it) now refuse with the reason (`igLVatIdProblem`, ust-behandlung-detector.ts; "EL"
= Greece). An invoice without a customer answered 500 "Related resource not
found" (the foreign key) — now 400 "Kunde ist erforderlich".

Not checked here: whether the USt-IdNr. is valid (VIES — the qualified
confirmation is the VIES check in `vat-validation.service.ts`, separate).
Fixtures that issued igL invoices to a customer without a foreign EU VAT
ID now create one: backend spec 59 (took "the seed's first customer"),
Playwright `company-defaults-tier176` tests 4 / 5 (seed customer with a DE
IdNr.).
Local runs: backend **272 / 0 / 0**, 0 × 5xx; Playwright **949**.

### Entertainment is 70 % deductible (Tier 485)

§ 4 Abs. 5 Nr. 2 EStG: of an entertainment expense (category starting
"Bewirtung") only 70 % is a Betriebsausgabe for the tax profit; the input
tax stays fully deductible. Measured (spec 271, 7 assertions fail on the old
code): a sole trader's paid receipt of 100 + 19 was deducted at 100 in EÜR
5600 (Gewinn -119), Anlage S and Anlage G; KSt 1 added nothing back (its
Kz 80 a placeholder, labelled "§ 8b KStG" — the dividend exemption).

- `expense-cost.ts`: `isBewirtung`, `deductibleCost` (70 %),
  `nichtAbziehbareBewirtung` (the 30 %).
- EÜR: new line **5610 Bewirtungsaufwendungen (70 % abziehbar)** (Anlage EÜR
  Zeile 63), before 5600 whose matcher also took "Bewirtung"; the 30 % in
  `nichtAbziehbareBewirtung` (not in the Gewinn). Anlage S / G: 70 % in the
  line the expense belongs to, the 30 % in `totals.nichtAbziehbareBewirtung`.
- KSt 1: Kz 80 (now "§ 4 Abs. 5 EStG / § 10 KStG") computed as the 30 % of the
  year's Bewirtung — the Jahresüberschuss has it at 100 %; zvE follows.
- GuV / BWA keep 100 % (commercial books; the add-back is outside them).

(Gifts over 50 €, Nr. 1: Tier 503; the home office, Nr. 6b / 6c: Tier 504.)
Local runs: backend **270 / 0 / 1**, 0 × 5xx; Playwright **949** (anlage-eur's row
count +1 for 5610; backend spec 102's line list the same).

### UStJA and Sondervorauszahlung payments (Tier 484)

Closes Tier 483's limit. VAT money moved with the Finanzamt that is no
UStVA's payment — the annual return's Abschlusszahlung / Erstattung, the
Sondervorauszahlung under Dauerfristverlängerung, anything else — had no
place (spec 270: `POST /ustva/payments` 404, 9 assertions fail on Tier 483).
New model `UstPayment` {kind 'ustja' | 'sondervorauszahlung' | 'sonstige',
year, paidAt, amount (positive paid, negative refunded), note} (migration
`20260930000003_ust_payment`), `GET / POST / DELETE /ustva/payments`;
`finanzamtVat` adds them to the filings' payments, so EÜR Zeilen 18 / 58 and
Anlage S / V / G (EÜR) count them on paidAt. UI: card "Weitere Zahlungen ans
/ Erstattungen vom Finanzamt" below the UStVA history
(`UstPaymentsCard.tsx`); Playwright `ustva-payment-tier483.spec.ts` gained a
test.
`UstPayment` is an audited model (audit-log.extension.ts) — spec 196 caught
it missing in the first local run. Local runs: backend 269 / 1 / 0 → 196 and
270 green after that fix, 0 × 5xx; Playwright **949**.

### The VAT in the EÜR (Tier 483)

User decision (2026-09-30): complete the EÜR's VAT lines. § 4 Abs. 3 EStG
counts money — the VAT received with the income, the input tax paid, and the
VAT paid to / refunded by the Finanzamt are Betriebseinnahmen / -ausgaben
(Anlage EÜR Zeilen 17, 18, 57, 58). The EÜR, Anlage S, V and G (EÜR) were net
only, and a UStVA's payment could not be recorded, so e.g. December's VAT
paid in January could not move profit between years (spec 269: 11
assertions fail on the old code).

- **EÜR** lines 4140 Vereinnahmte USt, 4150 vom Finanzamt erstattete USt,
  5850 gezahlte Vorsteuer, 5860 an das Finanzamt gezahlte USt. Received =
  the paid part of each document's tax (EUR; a refund negative) plus cash
  sales; Vorsteuer = the VAT of the expenses paid in the year plus cash
  purchases (`euerVat`, euer-zufluss.ts). A Kleinunternehmer has neither
  (Tier 480 / 481) but may pay § 13b tax, so the Finanzamt lines apply.
- **Finanzamt payments**: `UStvaFiling.paidAt` / `paidAmount` (migration
  `20260930000002_ustva_filing_payment`), `PUT /ustva/filings/:id/payment
  {paidAt, amount?}` — submitted returns only, amount defaults to the
  Differenzbetrag (positive paid, negative refunded), `paidAt: null`
  clears. UI: "Zahlung erfassen" / "bezahlt am …" in the UStVA history.
  `finanzamtVat` sums them by paidAt.
- **Anlage S** 4140 / 4715, **Anlage V** 8180 / 8680 (and a Kleinunternehmer's
  Werbungskosten gross, as EÜR / Anlage S), **Anlage G** 2195 / 2895 — the
  same figures, only with Gewinnermittlung 'euer'. GuV / BWA / Bilanz stay
  net (the VAT is a balance there).
- 14 specs read EÜR / Anlage totals for other purposes; they now sum the net
  lines (comment "Tier 483" in each) or, spec 227, record the March VAT
  payment so the Gewerbesteuer arithmetic holds unchanged.

Limits: Finanzamt payments are entered by hand (no bank-import matching);
the payment / refund of the annual return (UStJA) and of Sondervorauszah-
lungen had no field — added in Tier 484.
Local runs: backend **269 / 0 / 0**, 0 × 5xx; Playwright 945 + 3 row counts
(anlage-eur / -s / -v, the new lines) updated and green on re-run, + 1 new
(`ustva-payment-tier483.spec.ts`) = **948**.

### § 19 in the e-invoice of a Kleinunternehmer (Tier 482)

Tier 480 puts a Kleinunternehmer's lines at 0 %; the XRechnung of such an
invoice said category E with TaxExemptionReason (BT-120) "Steuerbefreite
Leistung" — the generic text of any 0 % line, no ground — and ZUGFeRD's
ExemptionReason the same (spec 268, 2 assertions fail on the old code).
`exemptionFor(category, kleinunternehmer)` gives "Kleinunternehmer gemäß § 19
UStG — keine Umsatzsteuer" for E; `transformToXRechnungData` reads
`company.defaultVatMode`, which the ZUGFeRD company contexts (bulk
download, GET …/pdf?format=zugferd, GET …/zugferd, GoBD archive) now pass. A
regular company's 0 % invoice keeps the generic text; the KU invoice
validates.
Local runs: backend **267 / 0 / 1**, 0 × 5xx; Playwright **947**.

### A Kleinunternehmer deducts no input tax (Tier 481)

The purchase side of Tier 480 (§ 19 Abs. 1 Satz 4 UStG). Measured (spec 267)
for a Kleinunternehmer: a purchase of 1 000 + 190 → UStVA Vorsteuer 190,
Differenzbetrag -190 — a refund the company is not entitled to; with a
§ 13b purchase of 500 as well: tax owed 95, Vorsteuer 285, still -190. The
UStVA now zeroes every input-tax bucket for a Kleinunternehmer; the tax owed
on § 13b / igE purchases stays owed (95 / 0 / 95). UStJA and the ELSTER XML
are built from the same computation. The EÜR already counted the gross as
cost and DATEV already booked no input tax for such a company.
2 assertions fail on the old code. Local runs: backend **266 / 0 / 1**, 0 × 5xx;
Playwright **947**.

### A Kleinunternehmer charges no VAT (Tier 480)

`Company.defaultVatMode = 'kleinunternehmer'` (§ 19 UStG) changed nothing on
the invoice: the form sent its lines at 19 % (its comment claimed "Backend
already recognises this") and the backend billed them. Measured (spec 266):
a 1 000 € line → invoice 1 190 € with "USt 19 %: 190,00", no § 19 note, UStVA
190 € output tax — VAT shown on an invoice is owed (§ 14c Abs. 2 UStG). The
PDF's § 19 condition compared a Prisma Decimal with '0' / 0 (never true) and,
by `&&` / `||` precedence, would have put the note on any 0 % invoice.

- `create()` / `update()` put a Kleinunternehmer's lines at 0 %
  (`withoutVatForKleinunternehmer`); the form does the same when it loads the
  company.
- `InvoiceTemplateService.resolveConfig` keeps the § 19 note only for a
  Kleinunternehmer; the PDF shows it on a document without VAT and then lists
  no VAT line at all.
- Invoices issued before stay as issued (a § 14c case for the Berater if any
  exist).

4 assertions fail on the old code. Local runs: backend **265 / 0 / 1**, 0 × 5xx;
Playwright **947**.

### Dates the system sets itself are the German day (Tier 479)

Follow-up to Tier 478: the same `new Date()` (the instant) was stored as the
date of a voucher Storno / correction, of a customer credit applied to an
invoice ('Guthaben' payment) and of the invoice a recurring template's run
creates; the invoice number's year came from the server's local date.
Between 00:00 and 02:00 in Germany the instant is the previous day — on the
1st the previous month's UStVA / EÜR period, on 1 January the previous
year. `businessTodayDate()` (business-date.ts) gives today's German day as a
date-only value; the four places and the number year use it. Checked with
fixed instants (ts-node): 2026-09-30T22:30Z was stored as 30.09., the German
day is 01.10.; 2026-12-31T23:30Z → 31.12.2026 vs 01.01.2027.

Spec 265 pins the dates to the German day. At 09:53 CEST only the recurring
invoice fails on the old code (dated "2026-09-30T07:53:31Z" — a time where a
date belongs); the Storno and credit-payment assertions fail on the old code
only between 00:00 and 02:00 German time or on a UTC server from 22:00, so
they could not be shown failing here.
Local runs: backend **264 / 0 / 1**, 0 × 5xx; Playwright **947**.

### Today is the business's calendar day (Tier 478)

Found when Tier 477's run crossed midnight (specs 212 / 213 failed at 00:11
on 30.09.). Date-only fields are stored as midnight UTC of their day; three
places compared them with the server's instant instead:

- **Dashboard** "this month" / YTD ended at `now` — on a German server an
  invoice dated today is 02:00 local, so after midnight today's invoices were
  missing (measured 0 / 0 / 0 instead of 119 / 19 / 1).
- **Credit notes** (and `create()` without an issue date) took the instant as
  their date: written at 00:15 on 30.09., dated 29.09. (22:15 UTC) — in
  DATEV, and on the 1st of a month in the previous month's UStVA.
- **Customer summary** counted an invoice as overdue once `dueDate > now`
  failed — on a UTC server from 00:00 of its due day, on a German one from
  02:00 (the Mahnung run uses dueDate < today).

`src/common/business-date.ts`: today in Europe/Berlin and day bounds as
midnight-UTC values; the three places use it. Spec 264: on the old code the
dashboard and credit-note assertions failed (run at 00:15 CEST); the overdue
assertion fails on the old code only after 02:00 CEST or on a UTC server, so
it could not be shown failing here. Caveat: specs that take "today" from the
runner's UTC date can disagree with the German day between 22:00 and 24:00
UTC — relevant only across a month end.
Local runs (after midnight CEST): backend **263 / 0 / 1**, 0 × 5xx; Playwright **947**.

**Tier 478a — CI failed on exactly the caveat above** (run 36643329289 at
23:15 UTC = 01:15 CEST): specs 212 / 213 took "today" from the runner's UTC
date (29.09.) while the credit note was — correctly — dated 30.09. It also
showed a real gap: `isToday` (the same-day edit rule) still used the server's
local date, so on a UTC server a new invoice dated with the German day could
not be edited between 22:00 and 24:00 UTC. Fixes: `isToday` and the overdue
check take the German calendar day of the stored value
(`businessDayIso` — right for date-only values and for full instants: spec
67 sends "…T23:40Z", which is the 30th in Germany); the backend e2e job runs
with `TZ: Europe/Berlin` like every local run; the production backend gets
`TZ: Europe/Berlin` (infra/prod/docker-compose.yml) for the rest (logs,
schedulers). Local runs at 02:00 CEST: backend **263 / 0 / 1**, 0 × 5xx;
Playwright **947**.

### No editing once money or a correction is booked (Tier 477)

HANDOFF §9 item 14, **decided by the user (2026-09-29): a sent invoice stays
editable on its issue day, but not once a payment or credit note is booked
on it.** Measured before (spec 263, same-day invoices): a paid 1 190 €
invoice edited to 2 000 net → 200, total 2 380, still "paid" with 1 190 €
received; an invoice with a 119 € credit note edited down to 59,50 €.
`update()` now refuses (403) when the invoice has a payment or a
non-cancelled credit note (delete already refused since Tier 406: a credit
note books a 'Gutschrift' payment). The detail page shows "Gesperrt
(Zahlungen gebucht)" instead of Bearbeiten / Löschen. 3 assertions fail on
the old code.
Local runs: Playwright **947**; backend 260 / 2 / 1, 0 × 5xx — the run crossed
midnight into 30.09. and specs 212 / 213 failed on the business-day bug
fixed in Tier 478 (a credit note written after midnight dated the day
before; the dashboard's "this month" without today's invoices). Neither
touches Tier 477's change.

### No Mahnung for a Proforma (Tier 476)

A Proforma asks for an advance and creates no claim, so the customer cannot
be in default. The cron took only invoices, but the manual and bulk send
checked only "not a credit note" — measured (spec 262): POST /reminders/send
for a sent Proforma past its due date → 201, a level-2 Mahnung with 5,00 €
fee and 36,23 € interest (1 231,23 € demanded), e-mailed. `sendOne` now takes
claims only (CLAIM_TYPES: INV, RCV); the "Mahnung senden" button shows only
on those. 3 assertions fail on the old code.
Local runs: backend **261 / 0 / 1**, 0 × 5xx; Playwright **947**.

### An advance paid back (Tier 475)

Closes the gap Tier 474 left. The order behind a paid Proforma falls through.
Measured before (spec 261): cancelling the Proforma 400 (it has a payment),
a negative payment 400, no refund endpoint — the only way out was deleting
the payment, which took the advance and its 190 € tax out of 12/2025, the
month it was received and possibly filed.

- **`POST /invoices/:proforma/advance-refund`** `{amount, paymentDate,
  paymentMethod}` books a **negative payment** on the Proforma dated the day
  the money goes back (refused above what was received, and once a final
  invoice settled the Proforma — then the correction is a credit note on
  the final invoice).
- `euerInflows` counts a negative payment as negative income in its period,
  capped at what was received — so the EÜR, the Ist- and (via
  `advancePayments`) the Soll-UStVA correct the tax in the refund month
  (§ 17 Abs. 2 Nr. 2 UStG); the month received stays as filed. DATEV writes
  "1718 an Bank" (the negative amount flips to H); Bilanz 4200 goes back to 0.
  A fully refunded Proforma stays issued (cancelling it would take the
  original advance out of its month again).
- UI: "Anzahlung zurückzahlen" on a Proforma with money received (asks the
  amount, dated today). i18n de / en / zh.

Spec 261 (9 assertions fail on the old code); Playwright
`final-invoice-tier473.spec.ts` gained the refund test.
Local runs: backend **261 / 0 / 0** (spec 16 ran: a frontend was up), 0 × 5xx;
Playwright **947**.

### No credit note on a Proforma (Tier 474)

The invoice page offered "Gutschrift" on every document but a credit note,
Proformas included, and the API took it. A Proforma declares no tax (only
what is paid on it, Tier 470), so the credit note took off tax that was never
declared — measured (spec 260): an unpaid 1 000 + 19 % Proforma credited in
full → 201, UStVA of the month 19 %: -1 000 / -190. `createCreditNote` now
refuses a Proforma (400: cancel it when unpaid; a paid one is settled by its
final invoice, which can be credited); the button is hidden on a PI.

Open: a **paid** Proforma whose order falls through has no clean path yet —
it cannot be cancelled (it has a payment, Tier 461) and its payment can be
deleted, which takes the advance and its tax out of the month it was
received (possibly already filed). The correct booking is a refund dated
when it is paid back (§ 17 Abs. 2 Nr. 2 UStG) — done in Tier 475.

Spec 260 (3 assertions fail on the old code). Local runs: backend **259 / 0 / 1**,
0 × 5xx; Playwright **946**.

### The final invoice in the UI and in the e-invoice (Tier 473)

Completes Tier 472. Measured before on a fully prepaid final invoice (spec
259): the XRechnung said PayableAmount 1190.00 with no PrepaidAmount — an
e-invoice asking for money already paid; GET …/zugferd rendered the PDF
without the deduction (only the paths patched in Tier 472 attached it); the
invoice API did not name the Proforma; the UI had no way to create a final
invoice.

- **XRechnung / ZUGFeRD:** BT-113 from the invoice's 'Anzahlung' payments
  (`transformToXRechnungData`): UBL `cbc:PrepaidAmount`, CII
  `ram:TotalPrepaidAmount`, PayableAmount / DuePayableAmount = total −
  prepaid (BR-CO-16). The validator's BR-CO-15 check now compares the
  TaxInclusiveAmount with the invoice total (it compared the payable).
- **`InvoiceService.findOne`** includes `advanceInvoice {id, invoiceNumber}`
  and attaches `advanceDeduction`, so every PDF / ZUGFeRD path that loads
  through it states the deduction (bulk download, GET …/zugferd); the GoBD
  archive attaches it itself (and now loads payments).
- **UI:** "Schlussrechnung erstellen" on an issued Proforma
  (`final-invoice-button`) creates the draft and opens it; a final invoice
  shows "Schlussrechnung zu PI-…" linking back. i18n de / en / zh.

Specs: backend 259 (5 assertions fail on the old code), Playwright
`final-invoice-tier473.spec.ts` (3 × green with --repeat-each).
Local runs: Playwright **946**; backend 258 / 1 / 0, 0 × 5xx — the failure
was spec 50's SSRF check of `127.0.0.1.nip.io`, which needs public DNS: the
name did not resolve on this machine during the run (it did again minutes
later, and spec 50 passed alone). An unresolvable name is allowed at create
time by design, so spec 50 now asserts that case only when the name resolves.
(0 skipped: spec 16 found the frontend of the previous Playwright run up.)

### The final invoice of a Proforma (Tier 472)

Tier 470 made a payment on a Proforma an advance payment; there was no way to
settle it (spec 258 on the old code: `POST …/final-invoice` 404, Bilanz 4200
kept the advance for good, the Proforma still took payments and let its
payment be deleted).

- **`POST /invoices/:proforma/final-invoice`** `{issueDate?}` — a draft INV
  with the Proforma's lines, currency, discount, USt treatment and cost
  centre, linked by the new `Invoice.advanceInvoiceId` (migration
  `20260930000001_invoice_advance_invoice`). One per Proforma (a cancelled
  one does not count).
- **Issuing it** (`updateStatus` draft → issued) books the cash received on
  the Proforma as a payment with method **'Anzahlung'** dated the issue day
  (`advance.ts`; refused when it exceeds the invoice or the currencies
  differ; the status change is undone if the booking fails). 'Anzahlung' is
  in `NON_CASH_PAYMENT_METHODS`: open balance, status and dunning see it; the
  EÜR, the Ist-Versteuerung, the DATEV bank rows and the customer statement
  (which shows the Proforma's real payment) do not.
- **UStVA Soll:** the final invoice declares the whole delivery; the advance
  comes off per rate of the Proforma in the same period
  (`advanceSettlements`). 1 000 + 19 % prepaid in 12/2025, invoiced 01/2026:
  12/2025 1 000 / 190, 01/2026 0 / 0. Ist: nothing in 01/2026.
- **DATEV:** "1718 (1711 / 1710) an Debitor" per rate — releases the
  Automatikkonto and its tax against the invoice's Debitor row.
- **Bilanz 4200** less the settled advances up to the Stichtag.
- **PDF:** below Gesamtbetrag "abzgl. Anzahlung PI-… vom <date>", "darin netto
  …, USt 19 %" per rate and a boxed **Zahlbetrag** (§ 14 Abs. 5 Satz 2 UStG);
  the GiroCode asks for the Zahlbetrag, none when it is 0. All five PDF call
  sites (download, ZUGFeRD, e-mail, resend, portal) attach the deduction.
- **Guards:** a settled Proforma takes no payment and its payments cannot be
  deleted; 'Anzahlung' cannot be entered or deleted by hand (a correction is
  a credit note on the final invoice, which — having a payment — cannot be
  cancelled either, Tier 461).

Not yet (Tier 473): the button in the UI, and the XRechnung / ZUGFeRD XML
of a final invoice does not state the prepaid amount (BT-113).
Proforma numbers take the year of creation, not of the issue date
(PI-2026-… for a Proforma dated 2025 in spec 258) — as INV / CN do.
Local runs: backend **257 / 0 / 1**, 0 × 5xx; Playwright **945**.

### A database outage is no failed login (Tier 471)

Found in Tier 470's local run (spec 193): `HeaderAuthGuard` wrapped the user
lookup in `try { … } catch { throw 401 "Authentifizierung fehlgeschlagen" }`.
Any error — here Prisma's "Can't reach database server" during eight parallel
creates — became a failed authentication: the frontend (`api.ts`) clears the
session on 401 and sends the user to the login page, and as a 4xx it never
reached ErrorEvent, which is why the Tier 466 connection failures looked rarer
than they are. `User.id` is plain text, so the catch guarded nothing else.

The catch is gone; `system.filter.ts` answers **503 "Service temporarily
unavailable"** for Prisma P1001 / P1002 / P1017 (`code` or `errorCode`) —
still a 5xx, so ErrorEvent stores it whenever its own write gets through.

Spec 257 stops and starts the database container, so it runs only with
`CI=true` or a `PG_CONTAINER` other than `de-invoice-postgres` (otherwise exit
77) — it must never stop the dev database. Old code: 401; new: 503, and the
same credentials work again once the database is back.
Local runs: backend **256 / 0 / 1** (257 ran against tmp-ci-pg), 0 × 5xx;
Playwright **945**.

### A payment on a Proforma is an advance payment (Tier 470)

Since Tier 424 the Proforma (PI) is no invoice — no revenue, no tax — and its
payments were left out with it. Measured: a PI of 1 000 + 19 % paid in full
(1 190) on 10.12.2025 appeared nowhere — UStVA 12/2025 0, EÜR 2025 no income,
no DATEV row, no Bilanz liability. The money arrived and no report knew of it.
User decision: treat it fully as an advance payment.

- **UStVA:** taxed in the month received (§ 13 Abs. 1 Nr. 1a Satz 4 UStG),
  pro rata per rate of the Proforma. Soll: an extra block
  (`advancePayments` in `euer-zufluss.ts`); Ist: already via `euerInflows`,
  which now includes PI payments — taxed once either way.
- **EÜR / Anlage S / V / G (EÜR):** income when received (§ 11 EStG), via
  `euerInflows`. Open Proformas are still no receivable (`unpaidInvoices`
  counts CLAIM_TYPES only).
- **DATEV:** "Bank an 1718 erhaltene, versteuerte Anzahlungen 19 %" (1711 at
  7 %, 1710 without tax), gross, per rate — the Automatikkonto splits the tax.
  New account slots `advanceReceived19/7/0` in the account map, Buchungsliste
  and settings labels.
- **Bilanz:** 4200 "Erhaltene Anzahlungen auf Bestellungen" = gross PI
  payments up to the Stichtag (was null).

Not yet: the final invoice that settles the advance (§ 14 Abs. 5 UStG — the
advance and its tax deducted, the liability released). Until then an advance
followed by a normal invoice for the same delivery is taxed and counted twice;
the user has to leave the Proforma unpaid or cancel it. That is Tier 472.

Spec 256: on the old code all four report assertions failed (UStVA, EÜR, DATEV,
Bilanz); the Ist-Versteuerung check was added after that run.

Local runs: Playwright **945**; backend 254 / 1 / 1, 0 × 5xx — the failure was spec 193's eight
parallel invoice creates (6 of 8), 5 × green alone. The run log shows why: the
auth guard's `user.findUnique` got Prisma's "Can't reach database server" and
**answered 401 "Authentifizierung fehlgeschlagen"** — the same connection
failure as Tier 466, but hidden as a 4xx, so the ErrorEvent dump stayed empty
and a user would have been sent to the login page by a database hiccup.
Fixed in Tier 471.

### The UStJA no longer drops a month that fails (Tier 469)

Looking for more of the Tier 466 / 468 fan-outs: `UstjaService.compute` ran the
twelve monthly `UstvaService.compute` calls in parallel (each several queries)
and **replaced a month that threw by zeros** — only a `console.warn`. A
connection hiccup like Tier 466's would have produced an annual VAT return
(and its ELSTER XML / PDF) with a month missing and no error anywhere. The
months now run one after the other and an error fails the request.
`UstvaService.listFilings` recomputed every submitted filing in parallel
(Tier 449) — also sequential now.

Verified by output: UStJA 2025 and 2026 and the filing list of the seeded
company byte-identical old vs new; specs 49, 131, 133, 142, 206, 237, 238, 252,
254 pass. No new spec — a failing month cannot be provoked through the API.
Local runs: backend **254 / 0 / 1**, 0 × 5xx; Playwright **945**, no flaky.

### The dashboard reads its rows once (Tier 468)

The same shape as Tier 466, applied to the other endpoint with an unexplained
500 (dashboard-v2, Tiers 429 and 463): `getDashboardKpis` ran 6 aggregates for
YTD / this / last month and 12 × 3 for the trend chart in parallel, and
dashboard-v2 ran that next to the aging report and four more queries — about
45 queries at once. It now reads the issued invoices and the non-AfA expenses of
the whole span (the earlier of 1 January and 12 months back) in two queries and
takes every sum in memory with the aggregates' definitions (invoices: issued
sales documents, total / totalVat; expenses: all statuses, net / VAT / gross,
open payables = gross of `booked`).

Verified by output, not by a new spec: `/reports/dashboard` and
`/reports/dashboard-v2` for the seeded company were byte-identical old vs new
(apart from the aging report's timestamp); specs 15, 64, 66, 213, 215, 226
pass. Like Tier 466 a mitigation — the 500 was never reproduced on demand; the
ErrorEvent dump of every local run (Tier 464) will show whether it recurs.
Local runs: backend **254 / 0 / 1**, 0 × 5xx; Playwright **945**, no flaky.

### The default Sachkonten are SKR03 accounts (Tier 467)

`GET /accounting/accounts/seed` created an invented numbering: "1600 Vorsteuer",
"1800 Sonstige Vermögensgegenstände", "2000 Verbindlichkeiten", "2200
Umsatzsteuer", "2800 Erhaltene Anzahlungen", "4200 / 4300 Umsatzerlöse",
"4400 Wareneinsatz", "6000 Aufwendungen für Waren", "8000 Sonstige Erträge".
The DATEV export writes a voucher line's account number as it is: measured, a
manual voucher Bank 119 an "Umsatzerlöse 19%" 100 / "Umsatzsteuer" 19 went to
DATEV as 1200 an **4200** (SKR03: Raumkosten) and 1200 an **2200** (SKR03:
Körperschaftsteuer).

The seed is now SKR03: 1000 Kasse, 1200 Bank, 1400 Forderungen, 1571 / 1576
Vorsteuer 7 / 19 %, 1600 Verbindlichkeiten L+L, 1710 Erhaltene Anzahlungen,
1771 / 1776 USt 7 / 19 %, 1800 Privatentnahmen, 1890 Privateinlagen (type
`equity`), 2700 Sonstige Erträge, 3200 Wareneingang, 4900 Sonstige betriebliche
Aufwendungen, 4980 Betriebsbedarf (Tier 256 inference), 8200 Erlöse. Revenue
and purchases are the accounts **without** automatic tax: a manual voucher books
net plus its own tax line; on the Automatikkonten 8400 / 3400 DATEV would
compute the tax a second time. The Buchungsliste knows the new names.

Found with it: a voucher line with `accountId: ""` skipped the tenant check (it
is falsy) and then failed as a foreign key — **500** "Related resource not
found". "" is "no account yet" now, like null (the inference fills it in).

**Not changed — a decision (§ 9):** companies that already ran the old seed keep
their rows (seeding only adds numbers that are missing), and vouchers posted to
the old accounts stay as they are; their DATEV export still shows 4200 / 2200 /
1600 with the old meaning. Correcting them means re-posting (Storno + new
voucher) or renumbering accounts — a Berater's call.

Spec `e2e/255-tier467-skr03-sachkonten.sh` (9 assertions, 7 failing against the
previous code — the empty-account case added after). Spec 58 looks for 3200 /
1776 / 1576 instead of the invented 4400 / 2200 / 1600; `ci-seed.sh` comments
follow.
Local runs: backend **254 / 0 / 1** — the first local run without a local-only
failure — 0 × 5xx; Playwright **945**, no flaky.

### The P&L asks the database twice, not 72 times (Tier 466)

The first run with the Tier 464 ErrorEvent dump caught a 5xx at once: spec 213
failed because `GET /reports/pnl` answered 500 — `PrismaClientKnownRequestError
… Can't reach database server at localhost:55460`, raised inside
`PnlService.compute`'s `Promise.all` of 12 months × 6 `expense.aggregate`
calls (72 queries fired together; the stack shows index 23). "Can't reach"
is a failed connection, not a pool timeout: most likely the burst of new
connections of a cold pool, dropped by Docker Desktop's port forwarding.
Not reproduced on demand — 30 concurrent P&L requests against a warm pool
passed with the old and the new code alike — so this is a mitigation, not a
proven root cause; the intermittent dashboard-v2 500 (Tiers 429, 463) had the
same shape (a wide `Promise.all`) and may be the same thing.

`PnlService` now reads each year's expenses in one `findMany` (invoice date,
net, category, status, relatedAssetId) and buckets them per month in memory —
the same three buckets (Material/Waren; booked non-AfA; AfA rows) with the
same arithmetic. Specs 101, 142, 213, 225, 226, 229, 214 pass unchanged.

The harness's "5xx captured" counted lines of the dump (a stack spans many);
it counts rows now.
Spec 240 used `mapfile` (bash 4) and failed in every local run on macOS's bash
3.2; it reads with a loop now.

Local runs (Tiers 465 + 466 together): backend **252 passed / 1 failed / 1
skipped** — 240 before its fix (passes alone with /bin/bash 3.2 after), 0 ×
5xx in ErrorEvent; Playwright **945**, no flaky.

### A corrected UStVA carries Kz 10 in its export (Tier 465)

The "Not done" of Tier 448: after a UStVA was submitted again as a corrected
return (`berichtigt: true`), its ELSTER XML and text preview were those of a
first return — no Kz 10 "Berichtigte Anmeldung", left to the user to tick in
Mein ELSTER; the filing knew it only from a notes prefix.

New `UStvaFiling.berichtigt` (migration `20260929000001_ustva_filing_berichtigt`,
filled for existing rows from the notes prefix), set on a corrected
resubmission and kept. The XML writes `B-Kz010=1` before the amounts, the text
preview the same line with its label. (The XML container format is still the
unverified one of §9 item 9.)

Spec `e2e/254-tier465-ustva-kz10.sh` (9 assertions, 3 failing against the
previous code).

`reap_orphan_engines` (Tier 464) also works when `_lib.sh` is sourced from zsh.

### Anlage G follows the Gewinnermittlung; test stack hygiene (Tier 464)

Anlage G counted by document date for every company — the "still open" of
Tiers 454/455. Measured, a sole trader with an invoice of November 2025
(1 000 € net) paid in January 2026 and a cash sale in December 2025 (100 €):
Anlage G 2025 income 1 000 (the EÜR 100), 2026 income 0 (the EÜR 1 000); and
the Kassenbuch's cash sales and purchases were in no Anlage G at all (Tier 425
covered EÜR, GuV, BWA, not G).

New `Company.gewinnermittlung` ('euer' | 'bilanz', NULL = derived; migration
`20260928000001_company_gewinnermittlung`), `PUT /companies/:id`, a select on the
settings page (de/en/zh). `company/gewinnermittlung.ts`: not set, it follows the
legal form (Tier 441) — OHG, KG, GmbH & Co. KG and corporations keep books
(§ 238 HGB, § 140 AO) → 'bilanz'; sole trader, freelancer, GbR, PartG and an
unknown form → 'euer' (a sole trader above § 141 AO or an e. K. sets 'bilanz').
Anlage G for 'euer' takes the EÜR's inflows and paid expenses
(`euer-zufluss.ts`), each payment split over the invoice's VAT rates in the
proportions of its net; for 'bilanz' the documents of the year. Both add the
cash book (`cash-bookings.ts`). The response carries `gewinnermittlung` /
`gewinnermittlungQuelle`; the page says which basis the figures follow. GewSt
1A reads Anlage G and follows along. GuV / BWA stay accrual (they are accrual
statements); the EÜR stays cash.

**Test stack hygiene, found on the way:**
- Postgres refused every new backend ("too many clients"): 479 Prisma query
  engines were running without a parent. Prisma starts its engine as a child
  process; `kill -9` on the node process (specs 20 and 191 on every run, and
  manual restarts) orphaned it with its connection pool. New `kill_backend` /
  `reap_orphan_engines` in `e2e/_lib.sh` (TERM first, KILL what is left, then
  reap engines of this checkout with parent 1); specs 20 and 191 use it, `up`
  reaps before starting.
- `local-ci-stack.sh run` ran under `set -e`: when a spec failed it ended right
  after `run-all.sh`, so the Tier 429 log copy (`/tmp/backend-e2e-run.log`)
  only ever happened for green runs — a failing run left the previous run's
  copy behind. That is why the Tier 463 dashboard-v2 500 "was in no log": the
  file read was another run's. Fixed (`rc=0; … || rc=$?`); the run now also
  dumps the 5xx rows of `ErrorEvent` (message and stack, written by
  `system.filter`) to `/tmp/backend-e2e-errors.txt`. Spec 64 prints the body,
  the :3001 listener and the ErrorEvent row on a non-200. The dashboard-v2 500
  itself is still unexplained; the next one will leave its stack.

Spec `e2e/253-tier464-anlage-g-gewinnermittlung.sh` (16 assertions, 8 failing
against the previous code).
Spec 231 changed: its company is a sole trader, so its Anlage G follows the
EÜR (nothing paid → 0), as the EÜR assertion above it already did. Local runs:
backend 250 / 2 / 1 before that change (231, and 240 — `mapfile`, macOS bash
3.2 only), 0 × 5xx in ErrorEvent; Playwright **945**, no flaky.

### A UStVA with negative input tax can be filed (Tier 463)

Merged history first: Tiers 443–462 were built on the cloud branch
`claude/eloquent-hopper-qbea72` (PR #1). A second, local Tier 443 (delete
guard + an expense Storno endpoint, `d5a8016`) was pushed to main from the same
base in parallel; it was reverted (`028ce09`) and PR #1 merged (`ba31e7f`) —
the cloud Tier 443/447/449 cover the same ground more completely (lock
reasons, editing of open expenses, "Berichtigung nötig" for a submitted UStVA
the books no longer match). Checked on the merged code: an unpaid expense of a
submitted month can still be edited or deleted, and the filing is then flagged
`berichtigungNoetig` with the deviation (Tier 449) — a corrected return, not a
refusal. That is kept.

The one part of the reverted work the branch lacked: `UstvaVorsteuerDto` and
`vorsteuerSum` still had `Min(0)`. A month with only a supplier credit note
(Tier 442) has Vorsteuer −19 €, and `POST /ustva/filings` answered 400 — the
month could not be declared. A negative Kz 66 is legitimate (§ 17 UStG) and
ELSTER writes it signed (`B-Kz066=-000000001900`, Kz 83 +19 to pay back). The
constraints are gone, as Tier 417 did for the sales side.

Spec `e2e/252-tier463-ustva-negative-vorsteuer.sh` (6 assertions, 3 failing
against the previous code).
Merge CI (run 36456999242, `ba31e7f`): backend 250/0/1, Playwright 945.
Local backend run after the change: 248 passed / 3 failed / 1 skipped —
50-webhooks (local nip.io, as always), **240** (uses `mapfile`, which macOS's
bash 3.2 lacks — passes in CI's bash 5; local-only) and **64**: one
`GET /reports/dashboard-v2` answered **500** and passed on the rerun. That is
the second unexplained dashboard-v2 500 (the first in Tier 429) and again the
cause is lost: the spec deleted the body unread and the backend log has no
entry for it. Spec 64 now prints the body and the log tail on a non-200.
Playwright: 944 + **1 flaky** — `assets-afa` "storno button visible" (Tier 90).
Cause in the page, not the test: every change of the year starts a load, and
`fill("2028")` clears the field first (→ current year) — whichever answer came
last was shown, sometimes the wrong year's. The assets page now applies only
the latest load's answer (a user typing a year hit the same). The Tier 89 and
90 tests wait for the text instead of a fixed 2,5 s (the Tier 89 fix of the
reverted local Tier 443 is re-applied here). assets-afa 5 × without retries:
50/50.

### A payment belongs to an issued invoice (Tier 462)

The mirror of Tier 461. `PaymentService.create` checked the type (no credit
note) and the amount, not the status — and every way a payment is booked
(invoice page, bank import, cash book, Raten, Sammelzahlung, customer credit,
payment notices) goes through it. Measured:
- a cancelled invoice took 1 190 € (201) and turned "paid": the Storno
  undone, its 190 € back in the UStVA;
- a draft took a payment and went straight to "paid" — never issued, but
  counted in the UStVA (380 € for the two) and the EÜR.

Now a draft is refused ("zuerst ausstellen") and so is a cancelled document
(the message points to booking the money as the customer's credit). The
invoice page hides "Zahlung erfassen" on drafts (it already did on cancelled
invoices).

Specs that paid drafts in their fixtures now issue them first: 50, 52, 79,
149, 175, 189 (a PUT status 'sent' before the payment, nothing else).

Also here — Tier 461a: `list-pages.spec.ts` "Invoices list" (flaky in run
36231779527) counted the rows right after networkidle; it waits for a row or
the empty state now (HANDOFF §10 lesson 13). 10 repeats passed.

Spec `e2e/251-tier462-zahlung-status.sh` (11 assertions, 7 failing against
the previous code).

### A paid invoice is not simply cancelled (Tier 461)

`PUT /invoices/:id/status` checked no transition, and "cancelled" takes a
document out of every return (UStVA, EÜR, DATEV — with its payments).
Measured, a 1 190 € invoice paid in full, then cancelled (200): its 190 €
output tax, its 1 000 € income and the 1 190 € on the bank left the books,
and the customer's money was nowhere (no credit, no refund). An invoice with
a credit note against it, cancelled: the invoice left the returns, the
credit note stayed subtracted. The delete route's own message pointed there
("Bitte stornieren oder eine Gutschrift erstellen").

Now `updateStatus` refuses 'cancelled' while the document has payments
(credit-note offsets included) or an active credit note, and refuses it for a
credit note already settled against its invoice — the correction is a credit
note (and refunding what was paid). An unpaid invoice can still be
cancelled. The delete message names the credit note only.

Spec `e2e/250-tier461-storno-bezahlt.sh` (10 assertions, 6 failing against
the previous code). No UI change: the invoice page shows the refusal as a
toast.

### Deleting a payment takes back what it caused (Tier 460)

`DELETE /invoices/:id/payments/:paymentId` removed only the payment row.
Measured:
- 1 300 € paid on 1 190 €, deleted: the customer kept the 110 € credit
  (Tier 58) for money that never arrived — it could be paid out;
- 1 166,20 € paid within 2 % Skonto, deleted: the Skonto credit note
  (Tier 422) stayed — 1 166,20 € open instead of 1 190 €, UStVA 3,80 € short;
- a credit applied to an invoice (a 'Guthaben' payment, Tier 431), the
  payment deleted: the credit was gone.

Now `CreditBalanceService.paymentDeletion` refuses the delete when the
overpayment's credit has been used meanwhile (400, the payment stays), and
afterwards takes the overpayment back / gives an applied credit back (ledger
rows 'manual', referenceType Payment). `PaymentService.cancelSkontoOf`
cancels the Skonto credit note the payment booked — found by its reason,
the payment day and its creation in the same request (≤ 60 s) — and removes
its offset on the invoice; paying again books a new one.

Spec `e2e/249-tier460-zahlung-loeschen.sh` (17 assertions, 7 failing against
the previous code). No UI change: the invoice page shows the refusal's
message.

Not changed: the Skonto credit note carries no explicit link to its payment
(the match is by reason, day and creation time); a payment booked by the bank
import or the cash book is taken back there (Tiers 444 / 446 / 425), not by
this route.

### A paid Quittung: settled in the app and in DATEV (Tier 459)

Since Tier 424 a Quittung (RCV) is a sale of its own and DATEV books it on
the customer's Debitor. Measured, a Quittung over 119 € paid 119 € by bank:
- the app left it "sent": PaymentService set only an INV to paid (its
  comment said INV / RCV), and only an INV back to open when a payment was
  deleted — so a paid Quittung counted as unpaid (EÜR `counts.unbezahlt`,
  the invoice list's status filter);
- DATEV: the payments query took INV / CN only — the Debitor stayed at 119 €
  owed and the bank at 0.

Now both status paths use `CLAIM_TYPES` (INV, RCV), and the DATEV payments
query takes INV, RCV and CN. The Skonto stays INV-only (a Quittung has no
payment terms).

Spec `e2e/248-tier459-quittung-datev.sh` (8 assertions, 3 failing against the
previous code).

### Privateinlage / Privatentnahme in the Kassenbuch (Tier 458)

A Kassenbuch entry without a VAT rate is the owner's money (Tier 425: no
EÜR / UStVA / GuV). Measured:
- DATEV exported nothing for it: 500 € put in and 200 € taken out moved the
  Kassenbuch to 419 € (with a 119 € cash sale) and DATEV's Kasse 1000 to
  119 €.
- the Kassenbuch page offered 19 %, 7 % or 0 % only — a withdrawal entered
  there at 0 % became a business expense (EÜR 5900), a deposit tax-free
  revenue (EÜR 4170, UStVA Kz 44 "sonstige steuerfreie Umsätze").

Now the VAT select has "Privateinlage" / "Privatentnahme" (saved with
`vatRate: null`, a hint says what it means), and DATEV books "Kasse an
Privateinlagen 1890" / "Privatentnahmen 1800 an Kasse" — two new keys in the
per-company account map (`privateDeposit`, `privateWithdrawal`, labelled in
the settings page and the Buchungsliste).

Spec `e2e/247-tier458-privat-kasse.sh` (7 assertions, 4 failing against the
previous code); spec 214 now expects the Privateinlage row. Playwright
`cashbook-privat-tier458.spec.ts`.

Not changed: the Sachkonten seed (`accounting/accounts/seed`) names 1800
"Sonstige Vermögensgegenstände" — in SKR03 1800 is Privatentnahmen; the seed
is not used by the DATEV export, but its labels are off.

### Ist-Versteuerung: output tax when the money comes in (Tier 457)

The app knew only the Soll-Versteuerung. A business allowed the
Ist-Versteuerung (§ 20 UStG — below the turnover threshold, or a freelancer)
owes the output tax in the period the payment arrives (§ 13 Abs. 1 Nr. 1 b).
Measured: there was no setting (PUT `besteuerungsart` → 400), and the March
UStVA declared 190 € on an invoice paid in April and the full 7 € on a
half-paid one.

Now `Company.besteuerungsart` ('soll' default / NULL, or 'ist'; migration
`20260925000001_company_besteuerungsart`, settings page select). With 'ist'
the UStVA takes taxed sales from `istPaidDocuments` (`reports/ustva-ist.ts`):
the EÜR's payment walk (`euerInflows`, which now also returns the paid
`fraction` of each document) applied per rate. Zero-rated sales (§ 4, igL,
§ 13b, export) stay at the invoice date, and so does the input tax (§ 15).
The response carries `besteuerungsart`; the UStVA page says so; the UStJA
sums the monthly results, so it follows. The filing DTO accepts the echoed
field (it was refused as unknown — specs 206 / 237 / 238 caught it).

Spec `e2e/246-tier457-ist-versteuerung.sh` (10 assertions, 5 failing against
the previous code). Playwright `ist-versteuerung-tier457.spec.ts`.

Not changed: the DATEV export books the same either way — DATEV handles the
Ist-Versteuerung through the Mandant's own setting (the Berater sets it
there); the ELSTER XML has no field for it.

### Paying out a customer's credit books money leaving the bank (Tier 456)

Found while reading the credit code for Tier 454. Measured (invoice 119 €,
paid 150 €, the 31 € credit paid out):
- the payout voucher was Bank **Soll** 31 / Forderungen Haben 31 — money
  coming in. DATEV exported "1200 an 1400 S 31": the bank at 181 € instead of
  119 €, the customer's Debitor left at −31 (the credit never settled), and a
  direct posting on the collective account 1400.
- a payout above the credit was refused (400) only after its bank voucher had
  been posted; the voucher stayed.
- a Storno of the payout voucher put the money back in the books, but the
  credit ledger kept the payout: balance 0 € while the Debitor owed 31 €.

Now `CreditBalanceService.payout` checks the balance first, books
Forderungen Soll / Bank Haben, and reverses its voucher if the ledger write
still fails (a concurrent use of the credit). DATEV exports a payout as
"Bank an Debitor H" (a Storno "S"), taking the customer from the payout's
ledger row and the amount from the bank line's size — so payouts booked the
old way export right as well. `VoucherService.createReversal` restores the
credit (a 'manual' ledger row) when the original is a payout.

Spec `e2e/245-tier456-guthaben-auszahlung.sh` (14 assertions, 6 failing
against the previous code; the credit-after-Storno check was added with the
fix). No UI change — `credit-balance.spec.ts` (8 tests) still passes.

Not changed: payout vouchers already posted keep their reversed lines in the
voucher list / account sheets (DATEV reads them right); a data fix would
reverse and re-post them. A fresh company has no Sachkonten until
`accounting/accounts/seed` runs, so the payout form stays disabled until then
(covered by `credit-balance.spec.ts`).

### Anlage S and Anlage V count payments too (Tier 455)

Left open by Tier 454. A freelancer's Anlage S is the EÜR (§ 18 income,
§ 4 Abs. 3 EStG) and rent is income when received (§ 21 / § 11), but both
annexes still took invoices at their issue date and expenses at their
invoice date. Measured with 243's fixtures: 2025 showed 1 000 income for an
invoice paid in 2026 and the bill paid in 2026; 2026 showed the unpaid
invoice and bill — Anlage S Gewinn −200 where its EÜR said 700.

Now EÜR, Anlage S and Anlage V share `euerInflows` / `euerExpenses`
(`euer-zufluss.ts`), return `prinzip: 'zufluss'` and `counts.unbezahlt`, and
the page sections and PDFs say so. One addition to the selection: a *paid*
negative invoice (a correction entered as INV, as spec 106 seeds it) lowers
the income at its issue date — the walk over payments skipped it.

Specs adapted: 106, 118 (SQL-seeded expenses get `paidAt`), 213 (the
Quittung and the invoice are paid before the Anlage S check, moved to the end
so the ageing / DATEV checks still see them open).

Spec `e2e/244-tier455-anlage-s-v-zufluss.sh` (8 assertions, 7 failing against
the previous code). Playwright `anlage-s-v-zufluss-tier455.spec.ts`.

Still open: Anlage G stays on the document date — a Gewerbe that keeps books
(§ 140 AO / § 141 AO) accrues, one that does not files the EÜR; the app does
not know which (a company setting would decide it). Money received on a
Proforma (an Anzahlung) is income under § 11, but PI payments are not
counted — the final invoice's payment would then count it twice; that needs
the PI → invoice link.

### The EÜR counts payments, when they were made (Tier 454)

Item 20 of §9, decided by the user: cash basis (Zufluss-/Abflussprinzip,
§ 11 EStG). Measured with a fresh company: an invoice of November 2025 paid
in January 2026 was 2025 income; the 2026 EÜR showed an unpaid invoice (200),
a half-paid one in full (500), an unpaid bill (400), and not the invoice paid
in 2026. An expense paid outside the bank import / SEPA / cash book (card,
private account) had no way to record its payment date — `paidAt` was an
unknown field (400).

Now (`accounting/euer-zufluss.ts`):
- income = each payment's net share of its invoice (payment × net / gross,
  in EUR via the invoice's own net), in date order up to the invoice total.
  A 'Gutschrift' payment (credit note settling the invoice, also the Tier 422
  Skonto) takes up its part and is no income; an overpayment beyond the total
  is no income of that invoice — it counts when the credit pays another
  invoice ('Guthaben' payment). An invoice set "paid" without its payments
  recorded counts the uncovered part at its issue date.
- a credit note's amount beyond what it settled on its invoice (the invoice
  was already paid) lowers the income at the credit note's date — strictly
  that is the day the money goes back, but a payout (`credit-balance
  payout`) is not linked to the credit note.
- expenses count at `paidAt`. `paidAt` can be entered on create and changed
  / cleared on update (both expense routes, "Bezahlt am" in the UStVA form
  and the expenses modal). A manual `paidAt` no longer locks the expense
  (Tier 443 locked any `paidAt`); bank, SEPA, cash-book and AfA locks stay,
  and a Skonto credit note (Tier 452) stays locked to its bank payment.
- the response says `prinzip: 'zufluss'` and `counts.unbezahlt` (invoices /
  expenses of the year not paid yet); the page and the PDF say so.

Specs adapted (they built revenue from sent-but-unpaid invoices or unpaid
expenses): 141 (baseline from the EÜR itself, then the three invoices paid),
199, 200, 208, 225, 227 (payments / `paidAt` added), 231 (nothing paid → 0,
4 open), 232 (`paidAt` is now a field; a SEPA-paid expense's `paidAt` cannot
be cleared).

Spec `e2e/243-tier454-euer-zufluss.sh` (15 assertions; its first version
failed 12 against the previous code). Playwright `euer-zufluss-tier454.spec.ts`: an unpaid bill is
listed as open, its paid date entered in the modal puts it on 4300.

Still open: Anlage G, GuV and BWA stay on the document date (GuV and BWA are
accrual by nature; Anlage S / V followed in Tier 455);
a customer-credit payout is not linked to the credit note that created it.

### A stored file's URL opens it (Tier 453)

Measured: `POST /storage/upload` answered with url `/api/v1/storage/<path>` —
no such route, GET was 404 (the file route is `files/*splat` with the path's
slashes as commas, which `GET /storage/list` returned). And the settings
page's file "Download" (left open by Tier 385) navigated to the list URL
without the auth headers: 401, the browser saved an error page.

Now `storageFileUrl()` builds the URL for both routes, and the button fetches
the file with the headers (`apiGetBlob`) and saves the blob under its original
name. Nothing else read the upload's url (attachments keep `path`).

Spec `e2e/242-tier453-storage-url.sh` (7 assertions, 4 failing against the
previous code; the Tier 385 isolation — 404 for another company — still
holds). Playwright `storage-download-tier453.spec.ts` checks the saved file's
name and bytes.

### A supplier bill paid less its Skonto (Tier 452)

Left open by Tier 451. A bill of 1 190 € paid within its Skonto period with
1 166,20 € (2 %) could not be booked against the bill — Tier 451 refuses a
debit that is not the bill's amount; before Tier 451 it was booked and the
bill marked paid with the Skonto nowhere (cost 1 000, Vorsteuer 190 although
23,80 € were never paid). The way out was a supplier credit note entered by
hand first.

Now `book-expense` takes `skonto: true`: when the debit is less than the bill
by at most 10 %, the difference becomes a supplier credit note
("<number>-SKONTO", split at the bill's rate — § 17 UStG: net −20, VAT −3,80),
settled with the payment (paidAt, notes `[skonto-voucher:<id>]`), and the bill
is paid; the voucher carries the VAT of what was paid. Cost 980, Vorsteuer
186,20, nothing owed in the balance sheet or DATEV. Without the flag the 400
says to book it with Skonto. DATEV's "otherwise paid" rows (Tier 432) skip the
Skonto credit note — no money moved for it (the filter keeps NULL notes: NOT
LIKE on NULL would have dropped every other expense, which spec 221 caught).
A Storno of the payment voucher deletes its Skonto credit note
(`releaseBankBooking`). The bank import page offers "Zahlung <nr> mit Skonto
<x> €" on a debit 0–10 % below an open bill when no bill matches exactly.

Spec `e2e/241-tier452-lieferantenskonto.sh` (20 assertions, 9 failing
against the previous code). Playwright `bank-skonto-tier452.spec.ts`.

### A bank debit pays a recorded expense once, and only its amount (Tier 451)

`book-expense` with an `expenseId` checked only that the expense was the
company's. Measured with six debits of 119 €: one was booked against an
invoice of 1 190 and marked it paid; an expense paid from the cash book was
paid again; one paid by an earlier bank booking was paid again; a supplier
credit note was "paid" by a debit — four vouchers where none belonged. And the
bank import page could not link an expense at all: a debit row offered only
"Als Aufwand buchen" (an account), so paying a recorded Eingangsrechnung left
it open.

Now a debit against an expense needs its gross amount (±½ cent; the message
suggests a supplier credit note for a difference such as a Skonto), refuses a
credit note (its refund is an incoming payment, Tier 450) and an AfA row, and
refuses an expense already paid — or a credit note already refunded — by the
cash book or another unreversed bank booking. A SEPA-paid expense is accepted:
the debit is the batch's execution, and `paidAt` keeps the batch date. The
page shows "Zahlung <number>" on an unbooked debit row when an open expense
(or a SEPA-paid one without a bank booking) has its amount, booking it with
the expense's VAT, Sachkonto and supplier (de/en/zh).

Spec `e2e/240-tier451-zahlung-eingangsrechnung.sh` (13 assertions, 6 failing
against the previous code); spec 239 gained "not refunded twice". Playwright
`bank-payment-tier451.spec.ts`.

(A supplier Skonto — paying less than the bill — is Tier 452.)

### A supplier's refund is booked against its credit note (Tier 450)

Left open by Tier 442: a supplier credit note (negative expense) could be
recorded, but the refund it promises could not be booked when it arrived.
`book-expense` refused every incoming transaction ("nur für Ausgänge"),
nothing else links an incoming payment to an expense, and the bank import page
offered no action on a credit row. Measured: after the 238 € refund was on the
bank account the balance sheet still showed the supplier owing us the credit
note (4000: −297.50 with a second, smaller one), DATEV's Kreditor too.

Now `book-expense` takes an incoming transaction when `expenseId` names a
credit note of the same amount (±½ cent): the lines of a payment reversed —
Bank an Aufwand / Vorsteuer — and the credit note paid on the value date. An
incoming payment without a credit note, against an invoice, or of another
amount is refused as before. The UStVA counts the credit note once (the
bank voucher adds nothing to it); DATEV books the refund on the Kreditor (a
negative amount flips S/H); a Storno of the refund voucher takes it back
(Tier 444) and the transaction can be booked again. The bank import page
shows "Erstattung Gutschrift <number>" on an unbooked credit row when an open
credit note has its amount (de/en/zh).

Spec `e2e/239-tier450-gutschrift-erstattung.sh` (19 assertions, 5 failing
against the previous code). Playwright `bank-refund-tier450.spec.ts`.

(Tier 451 adds the same for a debit: "Zahlung <number>".)

### A submitted UStVA the books no longer match is flagged (Tier 449)

Tier 448 kept a submitted filing's figures; the books of its period could
still change afterwards (an expense entered late, an open one corrected —
Tier 443). `GET /ustva/filings` kept showing the submitted figures with
nothing to say they were now wrong, although § 153 AO requires a corrected
return once the error is known.

Now a submitted or accepted filing carries `abweichung` (live compute() minus
submitted, for Umsatzsteuer, Vorsteuer and Zahllast) and `berichtigungNoetig`
(any difference ≥ 1 cent); a draft carries null for both (it is recomputed
when saved). The filings table shows "⚠ Berichtigung nötig" with the Zahllast
difference and § 153 AO in its tooltip (de/en/zh); submitting the period again
(the Tier 448 confirm) clears it.

This is a notice, not a lock: whether a submitted period should refuse new or
changed bookings (Festschreibung) is still a product decision (§ 9).

Spec `e2e/238-tier449-berichtigung-noetig.sh` (10 assertions, 4 failing
against the previous code). Playwright `ustva-berichtigung-noetig-tier449.spec.ts`.
`listFilings` now runs compute() once per submitted filing.

Spec 210's letter checks failed a second time in CI (run 36131518196), again
all four at once with the text empty. The spec extracted the text with a regex
over the raw PDF streams; one way that yields nothing is shown with a
synthetic stream (a FlateDecode stream whose last compressed byte is 0x0D
loses it to the `\r?\n endstream` match and zlib refuses it — the error was
swallowed). It now uses pypdf (CI's "Install Python pdf deps" step) and, if
the text is still empty, prints the PDF request's status, the Mahnung id and
the file's head. Not proven to be CI's cause; the next failure will say.
The first three CI runs with pypdf (36133257386, 36135918279, 36139143262)
passed it.

### A submitted UStVA stays what was submitted (Tier 448)

`POST /ustva/filings` (the UStVA page's "Als Entwurf speichern" / "An
Finanzamt übermitteln") upserted by period. Measured:

- the stored figures were the request's: Umsatzsteuer **999** saved for a
  month whose computed Umsatzsteuer was 0 (the page posts compute()'s data
  back, but nothing checked it);
- a filing marked "submitted" was overwritten by the next save — a draft save
  set it back to "draft", cleared `submittedAt` and replaced the figures. The
  record of what went to the Finanzamt was gone.

Now `saveFiling` stores compute()'s figures for the period, whatever the body
says. A submitted filing cannot be saved as a draft (409); submitting it again
is refused (409) unless `berichtigt: true` — a corrected return (§ 153 AO),
whose notes record the first submission's date and Zahllast; the audit log
(UStvaFiling is audited) keeps the before-image. The page catches the 409 on
"übermitteln", asks "Als berichtigte Voranmeldung übermitteln?" (de/en/zh) and
only then resends with `berichtigt`.

Spec `e2e/237-tier448-ustva-uebermittelt.sh` (13 assertions, 8 failing
against the previous code). Playwright `ustva-berichtigt-tier448.spec.ts`
(against the previous backend the second submission answered 201).

Not done: the ELSTER XML (§9 item 9 — its format is unverified anyway) does
not mark a corrected return (Kz 10 "Berichtigte Anmeldung"); the user has to
tick it in Mein ELSTER. There is still only one filing row per period, so the
first submission's figures survive only in the notes and the audit log.

### The expenses page shows how an expense was paid, and corrects open ones (Tier 447)

`GET /expenses` (the `/dashboard/expenses` list) derived each row's
`paymentState` from bank-import vouchers alone (`[expense:<id>]` in the
description). Measured:

- an expense paid by SEPA or from the cash book showed **"Offen"** — the
  page's "Offen" filter and counter listed bills that were paid;
- "Storniert" could never appear: `createReversal` writes "Storno: <number> …"
  without the tag. A reversed bank booking showed **"Bezahlt"**, linked to
  the reversed voucher. Spec 12 had hand-crafted a tagged `VoucherReversal`
  to test a path its own comment said did not exist.
- the list carried no `lockReason`, and the page's modal (opened from the 📎
  badge) only listed receipts: Tier 443's correction was reachable from the
  UStVA page only.

Now `paymentState` is "bezahlt" when `paidAt` is set (bank, SEPA, cash) or an
unreversed bank booking exists (bookings before Tier 425 set no `paidAt`),
"storniert" when it is open again after its bank booking was reversed
(Tier 444), else "offen". `linkedVoucher` is the paying booking, else the
reversed one. `lockReason` comes from `expense-lock.ts`. The modal shows
`ExpenseEditForm` (date, number, supplier, description, category, net, rate →
`PUT /expenses/:id`) above the receipts, or the lock reason instead (de/en/zh).

Spec 12 now reverses through the real route and expects the reversed booking
as link; its cleanup no longer deletes every company's `[expense:` vouchers
(one referenced by a bank transaction made the whole statement fail) — only
its own, Stornos first. Spec `e2e/236-tier447-ausgaben-status.sh` (12
assertions, 5 failing against the previous code). Playwright
`expense-edit-tier447.spec.ts` (2 tests, both failing against the previous
page).

### A bank reconciliation is undone as a whole (Tier 446)

Tier 444's twin on the invoice side. A customer payment matched from the bank
statement (confirm / manual match) books a voucher (`referenceType`
`BankReconciliation`, 1200 an 1406), records a Payment and sets the invoice's
`voucherRefId`. Its undo exists: "Rückgängig" in the bank import
(`reconciliations/:id/reopen`) reverses the voucher, deletes the Payment,
clears `voucherRefId` and puts the match back to "suggested". But the voucher
page's plain Storno (`POST /accounting/vouchers/:id/reversal`) also accepted it
(201) and took back only the journal lines: the invoice stayed paid (never
dunned), the match stayed confirmed — and a later "Rückgängig" reversed the
same voucher a second time (measured: three vouchers where two belong).
DATEV was not affected: since Tier 423 reconciliation vouchers and their
reopening are not exported, the payment comes from the Payment row.

Now `createReversal` refuses a `BankReconciliation` voucher (400, the message
names "Rückgängig" in the bank import; the voucher page shows it as a toast).
`reopenMatch` reuses an existing Storno of the voucher instead of writing a
second one, so matches reversed by hand before this tier can still be undone
cleanly. `/correct` stays allowed — the payment happened, only its accounts
change.

Spec `e2e/235-tier446-zuordnung-storno.sh` (22 assertions, 5 failing against
the previous code; the legacy case seeds the by-hand Storno with SQL).

### Seven cleanups that never ran; spec 114 lived on their residue (Tier 445)

`docker exec` attaches stdin only with `-i`. Seven calls fed SQL to
`docker exec "$PG_CONTAINER" psql` by heredoc without it — psql got an empty
stdin, ran nothing, exited 0, and each sent its output to /dev/null:
105 (the Berater test user), 106 (ANS-* pre-clean and cleanup), 107 (BIL-*
pre-clean and cleanup), 108 (the GUV-* pre-clean; its trap cleanup was already
one `-c` per statement since an earlier tier, which is why that one worked),
91 (Mahnungspause). On CI none of them ever ran.

Found in Tier 443 with a local `docker` shim that passed stdin regardless:
there 114-tier88-ebilanz failed "Materialaufwand > 0" — it only ever passed on
CI because 106 / 107 left their Material expenses behind in the shared
company. With the shim made to behave like docker (no stdin without -i),
114 passed again.

Now all seven have `-i`; 114 seeds its own Material expense (T88-*-MAT, removed
by its trap) like the Personal one of Tier 361. Spec
`e2e/234-tier445-docker-exec-stdin.sh` scans every spec, `_lib.sh`,
`ci-seed.sh` and `run-all.sh` for a stdin-fed `docker exec` without -i
(continuation lines joined, quoted SQL ignored) and proves on a probe file that
it flags a heredoc, a pipe and a continued heredoc but not `-i` or `-c "… < …"`.
Against the previous tree it lists exactly the seven.

### A reversed bank booking no longer pays the expense (Tier 444)

Left open by Tier 443. A bank debit booked against an expense (`book-expense`
with `expenseId`) sets the expense's `paidAt`; a Storno of that voucher
(`POST /accounting/vouchers/:id/reversal`) took the journal booking back and
nothing else. Measured with two expenses of 119 € and one debit of 119 €
booked against the wrong one, then reversed:

- the wrong expense stayed paid: the balance sheet owed 119 instead of 238,
  the SEPA run did not offer it, and — through Tier 443's lock — it could be
  neither corrected nor deleted ("bereits bezahlt");
- the bank transaction kept `voucherId` → the reversed voucher, so it could
  never be booked again (400 "bereits als Aufwand gebucht"), although the
  money had left the account. The right expense could not be marked paid.

Now `VoucherService.createReversal` calls `releaseBankBooking` for bank-import
expense vouchers (`referenceType` `Expense` / `BankTransaction`): the
transaction's `voucherId` is cleared, and the tagged expense's `paidAt` is
cleared when it is the booking's value date and nothing else pays it (no SEPA
batch, no unreversed cash-book Ausgabe). A correction (`/correct`, Storno + new
booking in one transaction) does not come through here: the payment happened,
the expense stays paid.

Spec `e2e/233-tier444-bankbeleg-storno.sh` (20 assertions, 10 failing against
the previous code — the rest of the re-booking path could not run at all).

CI run 36109905697: attempt 1 failed one spec not touched here —
`210-tier421-verzugszinsen.sh` section 3, all four checks on the Mahnung
letter text empty (the interest figures before it passed); attempt 2 passed
it, as did 10 local runs. Cause unknown: the spec throws away the PDF
request's status and body. If it recurs, make it print them first.

Not done: the invoice side has its own route (`reconciliations/:id/reopen`),
which already deletes the payment; a plain voucher Storno of a *reconciliation*
voucher (referenceType `BankReconciliation`) is untouched here.

### An open expense can be corrected; a paid one is not deleted (Tier 443)

Tier 442 left it open: an expense (Eingangsrechnung) could be created and
deleted, never corrected. Measured on the delete, which checked nothing:

- An expense paid by a SEPA batch was deleted (200). The money had left the
  bank and the batch still listed the payment; the cost, the input tax and the
  DATEV payment row were gone.
- An expense paid from the cash book was deleted too (200) — not a 500: the
  cash-book entry's `expenseId` is an optional relation, so Postgres set it
  to NULL and the Ausgabe stayed in the Kassenbuch as an unexplained payment.
- An AfA row of the asset register was deleted by hand (200), past the AfA
  storno; the register still said "AfA gebucht" for that year.

And on the UStVA page's expense form (Chromium):

- Typing the net amount key by key saved the VAT and gross computed for the
  **first digit**: 1000 € net → VAT 0,19, gross 1,19, and the UStVA took
  0,19 € Vorsteuer. The effect kept `f.vatAmount || …`; every Playwright test
  used `fill()`, which sets the whole value at once.
- The "Lieferant" select listed the company's **customers**; saving with one
  chosen answered 400 "Lieferant nicht gefunden" (the Tier 390 check).

Now: `PUT /expenses/:id` (`invoice.update`) and `PUT /ustva/expenses/:id`
(`accounting.update`) share `expense/update-expense.ts`. Amounts are entered
positive as on create; a changed net or rate without a VAT derives VAT (to
cents) and gross; a credit note keeps its sign unless `creditNote: false`.
Unknown fields (`paidAt`, …) are 400. `expense/expense-lock.ts` says when an
expense is no longer open — an AfA row, paid by SEPA (`paidBySepaBatchId`),
an unreversed cash-book Ausgabe, an unreversed bank-import voucher tagged
`[expense:<id>]`, or any other `paidAt` — with the way out in the message
(AfA storno, SEPA storno, cash-book / voucher storno, or a supplier credit
note). Such an expense cannot be deleted, and a PUT may change only its
notes. After a SEPA storno it is open again. `GET /ustva/expenses` carries
`lockReason`; the page shows "Bearbeiten" / "Löschen" only on open rows, a
🔒 "Gesperrt" with the reason as tooltip on the others, edits in the same
form (de/en/zh), loads `/suppliers`, and always recomputes VAT and gross.

Spec `e2e/232-tier443-ausgabe-korrigieren.sh` (24 assertions, 21 failing
against the previous code). Playwright `ustva-expense-edit-tier443.spec.ts`
(3 tests, all failing against the previous page; the VAT one types with
`pressSequentially`).

Not done: a filed UStVA period (`UStvaFiling.status = submitted`) locks
nothing — invoices and expenses of that period can still change, nowhere in
the app is a period closed (that is a Festschreibung feature of its own;
Tiers 448 / 449 flag a filing that needs a Berichtigung instead).
~~A voucher storno of a bank-import expense booking does not clear the
expense's `paidAt`~~ (Tier 444). ~~The expenses page has no edit button~~
(Tier 447).

### Supplier credit notes (Tier 442)

A supplier's credit note (Lieferantengutschrift: goods returned, a price
reduction, a refund) could not be recorded: `POST /ustva/expenses` and
`POST /expenses` required amounts ≥ 0 and rejected any other field (400), the
CSV import skipped negative rows. The input tax claimed on the original
invoice stayed claimed in full (§ 17 Abs. 1 UStG requires the correction),
the cost too. Two reports would have got one wrong anyway: the UStVA took
`Math.abs()` of every expense's net and VAT, the BWA of every cost — a
negative row would have ADDED input tax and cost.

Now: `creditNote: true` on either endpoint (amounts entered positive) stores
the expense with negative amounts (`expense/credit-note.ts`); a negative CSV
row is a credit note (its VAT and gross negative too, whatever sign they came
with). The UStVA and the BWA use the signed amounts; everything else already
summed them (GuV, EÜR, Anlage S/G, P&L, balance-sheet payables, DATEV —
a negative amount flips S/H, the Buchungsliste is sign-aware). It is no bill:
the SEPA payment run lists and pays only `grossAmount > 0`, and the cash book
refuses to link an Ausgabe to a credit note. The UStVA page's expense form has
a "Gutschrift des Lieferanten" checkbox (de/en/zh).

Measured with an invoice of 1 000 € + 19 %, a credit note of 200 € + 19 % and
a CSV credit note of 10 € + 1,90 €: before, only the invoice got in — input
tax 190, Gewinn −1 000, payables 1 190; now input tax 150,10, Gewinn −790 in
every report, payables 940,10, DATEV Kreditor −940,10.

Spec `e2e/231-tier442-lieferantengutschrift.sh` (19 assertions, 13 failing
against the previous code). Spec 119
seeded its BWA expenses with negative amounts — which only added up through
the BWA's Math.abs() — and now seeds them positive, as the app stores them.

~~Not done: the bank import does not match an incoming refund to a credit
note~~ (Tier 450); ~~there is still no way to edit an expense~~ (Tier 443).
Local runs: backend **230 / 0 / 1**, 0 × 500; Playwright 929 + **1 flaky** —
`list-pages-2` "search filters the supplier list" counted the rows a fixed
500 ms after Enter, before the reload had rendered (unrelated to this tier).
It polls now; 10 repeats without retries passed.

### The company's legal form (Tier 441)

There was no `Company.rechtsform`. KSt 1 and the Berater packager read one
anyway and fell back to "GmbH": every company was a corporation — KSt 1 in
the package, Anlage G left out — and KSt 1 counted a GmbH & Co. KG (a
partnership) as one too. Anlage AUS looked in `settings.rechtsform` and the
legal name, testing `/^(GmbH|AG|KGaA|UG)/` — anchored, so "SH Leder GmbH" was
not a GmbH (the open question spec 136 recorded in Tier 361). And the GewSt
Freibetrag of 24 500 € (Tier 438) went to every company: a GmbH with 50 050 €
profit was shown 3 570 € GewSt instead of 7 000 €.

New column `Company.rechtsform` (migration `20260924000001_company_rechtsform`),
settable through `PUT /companies/:id` (one of Einzelunternehmen, Freiberufler,
GbR, PartG, OHG, KG, GmbH & Co. KG, GmbH, UG (haftungsbeschränkt), AG, KGaA;
null clears) and a select on the settings page (de/en/zh). `company/
rechtsform.ts` resolves it: the column, else an old `settings.rechtsform`, else
the suffix of the legal name / name ("… GmbH", "… GmbH & Co. KG"), else unknown.
Corporations are GmbH, UG, AG, KGaA. Used by KSt 1 (unknown shows "nicht
angegeben", not a corporation), the packager (KSt 1 vs Anlage G), Anlage AUS
(§ 8b KStG) and Anlage G / GewSt 1A (no Freibetrag for a corporation).

Spec `e2e/230-tier441-rechtsform.sh` (16 assertions, 9 failing against the
previous code). Specs changed: 126 (the seeded SH Leder GmbH has Freibetrag 0),
132 (its Kz 12 identity no longer assumes Kz 10 = 0), 227 (its companies are
sole traders now, as Anlage G assumes).
Local runs: backend **229 / 0 / 1**, 0 × 500; Playwright **930**, no flaky.
The migration must be applied to a `db push` stack by hand (psql < migration.sql).

### An asset sold or scrapped leaves with its book value (Tier 440)

Measured with two machines (6 000 € each, 60 months, bought January 2025,
AfA 2025 booked), sold on 5 June 2026 — book value 4 200 € each:

- `dispose` set `verkauftAm` and booked nothing else. The balance sheet lost
  the machine; no report had the Restbuchwert as an expense (GuV 2026:
  −1 800 AfA only; right −6 000 for one machine). 8 400 € disappeared into
  the equity balancing item.
- A machine whose AfA 2026 was booked in full before the sale could still be
  sold: 1 200 € booked for six months (600 € due), nothing to take it back.

New `assets/disposals.ts` (`assetDisposals`, `sumRestbuchwert`): the book
value at the disposal month from the asset register (`computeAfaSummary`),
computed per report like the cash-book bookings — no stored row. It is a
Betriebsausgabe of the disposal year (§ 4 Abs. 3 Satz 4 EStG): GuV 8
(sonstige betriebliche Aufwendungen), EÜR new line **4610 "Restbuchwert
ausgeschiedener Anlagegüter"**, Anlage S 4720, Anlage G 2890, BWA 3600, P&L
other expenses, DATEV "2310 Anlagenabgänge an Anlagekonto" (SKR03 table of
Tier 437; Belegfeld1 `ABG-…`, dated the disposal day).

`dispose` is refused (400) when AfA is booked for the asset beyond the sale
(the disposal year above the months due, or any later year); the message
says to storno the AfA, record the sale and book the AfA again — the
AfA storno is per company and year (`storno-afa`), so the other assets are
re-booked unchanged.

The sale price (`verkaufsPreis`) is not booked: the sale is revenue like any
other and belongs on an invoice (with USt). DATEV always uses 2310 (Buch-
verlust); a Buchgewinn would be 2315 — the app does not know the proceeds.

Spec `e2e/229-tier440-anlagenabgang.sh` (23 assertions, 14 failing against
the previous code). Spec 102 and Playwright `anlage-eur` count 8 EÜR expense
lines now.
Local runs: backend **228 / 0 / 0** (16-dark-mode failed instead of skipping:
a frontend left on :3100 by an earlier `run-playwright <spec>`; skips once it
is stopped), 0 × 500; Playwright **930**, no flaky. `run-playwright` leaves
its backend (:3001) and frontend (:3100) running — stop them before a
backend run.

Found, not changed: a supplier credit note (Lieferantengutschrift) cannot be
recorded — the expense DTOs require amounts ≥ 0 — so a refund from a supplier
has no place in the books (the BWA's `Math.abs()` on expenses would turn one
into a cost if it ever got in).

### KSt 1: no credit of the Gewerbesteuer against the KSt (Tier 439)

KSt 1 subtracted min(KSt, 3,8 × GewSt-Messbetrag) from the
Körperschaftsteuer and called it "KSt-Anrechnung auf GewSt (§ 35 EStG / § 26
KStG)". § 35 EStG reduces the *income* tax of natural persons with Gewerbe
income (Einzelunternehmer, Mitunternehmer); a Kapitalgesellschaft gets
nothing of the kind (§ 26 KStG is the credit for foreign taxes). Measured at
100 050 € profit, Hebesatz 400: KSt 15 007,50 € "after Anrechnung" 1 700,85 €,
zu zahlen **16 533,26 €** instead of **29 832,91 €** (KSt 15 007,50 + Soli
825,41 + GewSt 14 000) — the tax burden shown at ~16,5 % instead of ~29,8 %.

The totals `kstAnrechnung` / `kstNachAnrechnung` are gone from the API, the
UI block and the PDF; the block (same test id) says there is no credit. The
GewSt-Messbetrag rounds the Gewerbeertrag down to full 100 € (§ 11 Abs. 1
GewStG). Texts de/en/zh and the packager README follow.

Spec `e2e/228-tier439-kst-ohne-anrechnung.sh` (10 assertions, 4 failing
against the previous code). Spec 128 asserted the Anrechnung identity and an
unrounded Messbetrag; Playwright `kst1` looked for "3,8 × Messbetrag" — both
corrected.
Local runs: backend **227 / 0 / 1** (50-webhooks local-only nip.io failure
aside), 0 × 500; Playwright **930**, no flaky.
CI run 35920709870: backend 227/0/1, Playwright 929 + **1 flaky** —
`cashflow.spec.ts` "changing startingBalance updates endBalance" read the end
balance right after clicking "update" and got the old value back (a race with
the refetch; the server side is not involved). Tier 439b makes it wait for the
text to change. Not reproducible locally: 15 repeats without retries passed
with the old and the new version alike.

Still open (§ 9): there is no `Company.rechtsform` (KSt 1 and the packager
read one that does not exist and assume GmbH), so the GewSt 1A report applies
the 24 500 € Freibetrag of Anlage G to every company, a GmbH included.

### Anlage G counted costs as profit; the GewSt estimate was off (Tier 438)

Anlage G shows Betriebsausgaben negative and adds them to the revenue, but
took each expense's netAmount as it was — positive for every real expense
(only AfA rows are stored negative). Measured with 50 050 € revenue, three
uncategorised expenses of 100 €, rent 12 000 €, car costs 2 000 € and 1 200 €
AfA booked (right Gewinn: 34 550 €, as GuV / EÜR):

| | before | now |
|---|---|---|
| 2890 Sonstige | +100 (one expense per category — `matchedKz` skipped the rest) | −300 |
| Betriebsausgaben | +12 900 | −15 500 |
| Gewinn | **62 950** | 34 550 |
| 4100 Hinzurechnung | 3 000 (25 % of rent) | 0 |
| 5100 Kürzung | 1 000 (50 % of car costs) | 0 (placeholder) |
| Freibetrag | 100 000 | 24 500 |
| Gewerbeertrag nach Freibetrag | 0 | 10 000 (rounded down to 100 €) |
| GewSt estimate | Messbetrag × 400 (100× too high once above the Freibetrag) | 1 400 |

Law applied: § 8 Nr. 1 GewStG — a quarter of the financing shares (interest
100 %, rent/lease of immovable property 50 %, of movable goods 20 %, licences
25 %) as far as their sum exceeds 200 000 €; the app tells them apart by
category only (Schuldzins/Zins 100 %, Miete/Pacht 50 %, Leasing 20 %) and says
so in the line's note. § 9 GewStG has no car-cost Kürzung (private use is a
withdrawal in the Gewinn); 5100 is now the § 9 Nr. 2a placeholder, 4200 the
§ 8 Nr. 10 one (was a non-existent "50 % Schuldzinsen Gesellschafter-Darlehen"
rule). § 11 Abs. 1: rounded down to full 100 €, Freibetrag 24 500 € for
natural persons and Personengesellschaften — Anlage G's filers. The
GewSt 1A report (gewst.service) reads these totals and was right in its own
formula (÷ 100). The booked AfA goes to 2500 via `bookedAfaCost`; a
Kleinunternehmer's expenses count gross (`expenseCost`), as elsewhere.
Texts (packager README, hints de/en/zh, KSt 1 subtitle) no longer say 100k.

Spec `e2e/227-tier438-anlage-g-gewerbesteuer.sh` (16 assertions, 12 failing
against the previous code). Spec 126 asserted the old rules (4100 = 25 % of
2200, 5100 = 50 % of 2600, Freibetrag 100 000) and is corrected.
Local runs: backend **226 / 0 / 1** (50-webhooks local-only nip.io failure
aside), 0 × 500; Playwright **930**, no flaky.

Found, not changed: `Company.rechtsform` is read by KSt 1 and the packager
but does not exist in the schema — every company counts as a GmbH there. KSt 1
credits 3,8 × the GewSt-Messbetrag against the Körperschaftsteuer (§ 35 EStG
is an income-tax relief for natural persons; a GmbH gets none) — to measure.

### An AfA booking is no supplier invoice (Tier 437)

The AfA rows "AfA buchen" creates (Expense, `category='AfA'`,
`relatedAssetId`, negative amount) were taken for supplier invoices by every
report about bills and money. Measured with a machine (6 000 € / 60 months,
1 200 € AfA a year) and one unpaid supplier invoice of 119 €:

| where | before | now |
|---|---|---|
| Bilanz 4000 Verbindlichkeiten L+L | −1 081 (119 − 1 200) | 119 |
| DATEV | "Kreditor 70000 an 4900, 1 200 S", dated 30.12 | "4830 an 0210, 1 200 S", 31.12, Belegfeld1 `AFA-2025` |
| P&L other expenses (year) | 100 (AfA subtracted; `max(0, …)` hid it in December) | 1 300 |
| Cash-flow forecast | −1 200 outgoing in December | 0 |
| Dashboard monthly expenses / open payables | −1 200 | 0 |
| Cost-centre reports | 119 − 1 200 | 119 |

`NOT_AFA_BOOKING` (`{ relatedAssetId: null }`, booked-afa.ts — the field is
set on AfA rows only) keeps them out of payables, cash flow, dashboard and
cost centres. The P&L adds the AfA as a cost. DATEV books "AfA-Konto an
Anlagekonto" by asset type from the new SKR03 table `datev-anlagen.ts`
(Software 0027/4822, Gebäude 0090/4831, Maschine 0210/4830, Fahrzeug
0320/4832, Betriebsausstattung 0400/4830, GWG 0480/4860) — `Asset.bilanzKonto`
is the app's balance-sheet position (0100–0500), not a DATEV account. The
annual AfA row is now stored at noon of 31.12 (local midnight was 30.12 in
UTC); the export dates AfA rows from `afaYear`/`afaMonth`, so rows already
stored come out as 31.12 too.

Not done: the table is SKR03 only and not in the DATEV account settings (an
SKR04 company gets SKR03 asset accounts); DATEV still has no booking of the
asset's acquisition (the supplier invoice for it goes to 4900) — the Berater
has to reclassify it. Assets have no DATEV Anlagenbuchhaltung export.

Spec `e2e/226-tier437-afa-keine-rechnung.sh` (14 assertions, 7 failing against
the previous code).
No existing spec needed a change. Local runs: backend **225 / 0 / 1**, 0 × 500;
Playwright **930**, no flaky.

### Booked AfA lowers the profit in every report (Tier 436)

"AfA buchen" (Tier 87) stores each asset's AfA as an Expense row with category
`AfA` and a **negative** netAmount/grossAmount. Only BWA and Anlage G handled
that sign. Measured with 5 000 € revenue and one machine with 1 200 € AfA
booked for the year (right answer 3 800 €):

| report | before | now |
|---|---|---|
| GuV 7a / Jahresüberschuss | −1 200 / **6 200** | 1 200 / 3 800 |
| EÜR | no AfA line, Gewinn **5 000** | 4600 AfA 1 200, Gewinn 3 800 |
| Anlage S 4600 / Gewinn | −1 200 / **6 200** | 1 200 / 3 800 |
| Anlage V 8600 | **−1 200** (a machine) | 0 |
| BWA, Anlage G | 3 800 | 3 800 |

GuV's cost lines are positive and subtracted — the booked 7a was negative
(while its computed fallback was positive), so the AfA was *added* to the
result; KSt 1 and the E-Bilanz take the GuV and inherited it. The EÜR skipped
AfA rows ("AfA lives in Anlage AVEÜR" — AVEÜR lists the assets; the AfA is a
Betriebsausgabe of the EÜR itself). Anlage V made both of its 8600 paths
negative on purpose; spec 118 made that add up by seeding its expenses with
negative amounts, which the app never stores, and asserted an Überschuss of
3 500 − (−8 300) = 11 800 for 3 500 € rent against 8 300 € of costs.

New `accounting/booked-afa.ts` (`bookedAfaCost`): the year's booked AfA as a
positive cost, used by GuV, EÜR (new line 4600 "Absetzung für Abnutzung",
between 5800 and 5900) and Anlage S. Anlage V's 8600 is positive on both paths
and takes booked AfA of the rental pool (Grundstück/Gebäude) only, as its
computed path always did. The frontend already rendered every expense total
as "−{amount}", i.e. expected positives.

Spec `e2e/225-tier436-afa-im-gewinn.sh` (16 assertions, 7 failing against the
previous code). Specs changed: 113 (GuV 7a and Anlage S 4600 are +1000, not
−1000), 118 (positive expense fixtures; 8600 = 6000; Überschuss −4 800),
102 and Playwright `anlage-eur` (7 expense lines).
Local runs: backend **224 / 0 / 1**, 0 × 500; Playwright **930**, no flaky.

### The Kassenbestand never goes below zero (Tier 435)

Measured before: an Ausgabe of 80 € into an empty till → 201, balance −80;
a backdated Ausgabe could empty an earlier day while today's balance stayed
positive; raising an Ausgabe or deleting the Anfangsbestand did the same.
A Kassenminusbestand shows more cash leaving the till than there was — the
tax office treats such a Kassenbuch as not orderly and estimates (§ 158 AO).

`KassenbuchService.assertCashNotNegative`: a create, amount change or delete
that takes cash out is refused (400, "Der Kassenbestand würde am TT.MM.JJJJ
negativ …") when the end-of-day balance of its day or of any later day would
fall below zero. Changes that add cash are always allowed, so a book that is
already negative can be repaired with the missing Einnahme / Privateinlage.
A **Storno is not checked**: it corrects a wrong booking, often on a closed
day where nothing else can be entered, and refusing it would keep the wrong
booking. Not guarded against two concurrent requests (no lock) — the same as
the other cash-book checks.

Spec `e2e/224-tier435-kasse-nie-negativ.sh` (15 assertions, 8 failing against
the previous code). Spec 03 needed a change: it posted an Ausgabe of 50 into
the till its own Storno had just emptied (it only tests that a Storno needs a
reason; it posts an Einnahme now).
Local runs: backend **223 / 0 / 1** (50-webhooks locally only, as in Tier
434), 0 × 500; Playwright **930**, no flaky.

### Cash taken to the bank reaches DATEV (Tier 434)

Measured before: a Kassenbuch "Umbuchung" (cash paid in at the bank, 300 €)
was in no DATEV export. Opening 500 + a cash sale of 595 − the 300 taken to
the bank leaves 795 in the Kassenbuch, but Kasse 1000 in the Berater's books
ended the month at 595 from the export alone instead of 295 — the Kasse was
300 € too high for good.

`buildBuchungenFromDb` now books every Umbuchung of the period as
"Kasse 1000 an Geldtransit 1360" (H), Belegfeld1 = the entry's Belegnummer.
The bank side comes with the bank statement (Bank an Geldtransit), so 1360
nets to zero once both are booked. A Storno of the Umbuchung (a negative
counter-entry) books the reverse and leaves 1360 at 0. New account slot
`transit` (SKR03 1360 "Geldtransit") in the DATEV account settings and the
Buchungsliste, labelled de/en/zh.

Spec `e2e/223-tier434-kasse-umbuchung.sh` (5 assertions, 2 failing against
the previous code). No existing spec needed a change.
Local runs: backend **222 / 0 / 1** (50-webhooks fails locally only — nip.io
does not resolve here; green in CI), 0 × 500; Playwright **930**, no flaky.

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

~~Not changed, found on the way: the customer detail's "Sammelzahlung" (one
amount over several invoices, `customer.service`) and the credit-balance
"Guthaben verrechnen" write payments directly instead of through
PaymentService~~ — both go through PaymentService since Tier 431.

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

~~Not done (§ 9): the EÜR still counts invoices and expenses at their
document date, not when paid (§ 11 EStG)~~ — done in Tier 454; the payment dates are now there
for invoices (Payment), cash and SEPA-paid expenses, but not for expenses
paid by plain bank transfer without a bank-import match. ~~Kassenbuch
`umbuchung` (Bank ↔ Kasse) is not exported to DATEV~~ (Tier 434).

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

~~Not changed, next tier: **the DATEV export contains no credit notes at all**
(it exports paid INV / PI only), so refunds and Skonti never reach the
Berater's books; and its payment row books the invoice total, not the cash
received.~~ Done since (credit notes and payments are exported on their own
rows; Tier 459 added the Quittung's payments).

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
4. ~~**Dev database out of `/tmp/pgdata`.**~~ — **done in Tier 571** (07.10.2026): rebuilt on a named volume from `backup-2026-09-05-224235`, schema migrated; see §8. History:
   ~~Dev database out of `/tmp/pgdata`.~~ The manually created
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
7. ~~**Anlage AUS KapG rule**~~ — resolved by Tier 441: the company's
   legal form is a setting (`Company.rechtsform`, `resolveRechtsform`), which
   Anlage AUS uses for § 8b KStG; "GmbH & Co. KG" is no Kapitalgesellschaft.
8. **Hetzner VPS IP + SSH key** — for `infra/prod/HETZNER-DEPLOY.sh`
   (DNS A record, deploy). `sudo` only for `scripts/fix-dev-pg.sh`.
9. **Verify the ELSTER UStVA XML format against the official schema** — and,
   since Tier 491, the ZM CSV (`GET /ustva/zm.csv`) against the BZSt upload
   format before the first Zusammenfassende Meldung is filed (found
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
10. ~~**Replace the header "authentication" before any real deployment**~~ — **done:** production refuses `x-user-id` by default (Tier 555), the compose file sets `ALLOW_HEADER_AUTH: "0"`, verified on the production stack (Tier 562). The text below is the history.
    ~~Replace the header "authentication" before any real deployment~~
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

11. ~~**Decide who is a platform operator**~~ — **done:** `SystemAdminGuard` (Tiers 548, 565): an admin of the oldest company, optionally narrowed by `SYSTEM_ADMIN_EMAILS`. History: (found Tier 378). Registration is
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

14. ~~**May a sent invoice be edited or deleted on its issue day?**~~
    **Decided 2026-09-29 (Tier 477): same day, but not once a payment or
    credit note is booked on it.** Original question (found
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

20. ~~**EÜR on a cash basis (§ 11 EStG)**~~ — done in Tier 454 (the user
    chose the cash basis; manual "Bezahlt am" for unmatched payments), Anlage
    S / V in Tier 455. Open: does Anlage G follow (only for a Gewerbe that
    keeps no books — needs a company setting)? (found Tier 425) The EÜR and
    Anlage S / V count invoices at their issue date and expenses at their
    invoice date — a December invoice paid in January lands in the wrong
    year. Payment dates now exist for invoices, cash-, SEPA- and
    bank-matched expenses, but not for an expense paid by a transfer that
    was never matched. Switching needs a decision on those (fall back to the
    invoice date and say so?) — and whether Anlage G, which may belong to a
    bookkeeping business, follows. Also: a Kassenbuch entry without a VAT
    rate is treated as Privateinlage / -entnahme (no income) — confirm
    (since Tier 458 the page offers it as such and DATEV books it on
    1890 / 1800).

When the Hetzner items are available, the deploy is:

```bash
cd infra/prod
./HETZNER-DEPLOY.sh --check       # Tier 127 pre-flight, ~5s
./HETZNER-DEPLOY.sh                # 10-step deploy, ~15-20 min
bash infra/prod/smoke-test.sh      # 17-check post-deploy verification
```
Set `FRONTEND_URL` in `infra/prod/.env` first: since Tier 363 it is the
frontend's build arg, and the frontend image refuses to build without it.

21. **Accounts from the old Sachkonten seed** (found Tier 467). Until Tier 467
   `accounts/seed` created an invented numbering (4200 "Umsatzerlöse 19%",
   2200 "Umsatzsteuer", 1600 "Vorsteuer", 2000, 2800, 4300, 4400, 6000, 8000,
   1800 "Sonstige Vermögensgegenstände"). A company that ran it keeps those
   rows, and any voucher posted to them reaches DATEV with the SKR03 meaning of
   the number (4200 Raumkosten, 2200 Körperschaftsteuer, 1600 Verbindlichkeiten).
   Check which companies used them (`VoucherLine` → `Account.accountNumber`)
   and decide with the Berater: re-post (Storno + new voucher on 8200 / 1776 /
   1576 …) or renumber — the app does neither on its own.

22. **Status review 07.10.2026 — what is still open** (after Tier 570; none of it decided or done):
    - ~~**Dependencies with known vulnerabilities**~~ — **done in Tier 572**: backend 12 → 3 (`node-forge`: no fix exists, the affected verify function is not used; `fast-xml-parser` inside `fints`: no compatible fix), frontend 5 → 0. Re-run `npm audit --omit=dev` now and then.
    - ~~**Receiving e-invoices**~~ — **done in Tier 573** (XRechnung UBL / CII, ZUGFeRD PDF → supplier, expense(s), the file kept). Open from it: ~~two VAT rates → two expenses (one bank payment)~~ (the bank debit now settles all parts, Tier 577); no automatic EN 16931 validation on import; upload by hand only (no mailbox, no Peppol); ~~Skonto terms not evaluated~~ (read since Tier 579). (The OCR path's two defects seen in passing — supplier created before confirmation, scan not attached — are fixed in Tier 574.)
    - ~~**Two production paths**, stale deploy documents~~ — **done in Tier 584**: one path (`infra/prod/`), the old one deleted, its documents in `docs/history/`; the deploy script's hand-seeded company (which left the installation without an operator), the wrong mail variable names and the `db push` instructions fixed on the way. `USER-GUIDE.md`, `SECURITY-AUDIT-2026-09-06.md` and most of the root `README.md` still predate Tiers 344 ff.
    - ~~**The monitoring overlay**~~ — its network, the open ports and the default Grafana password are **fixed in Tier 576** (resolved with `docker compose config`; still never run — the images are a download to ask for).
    - ~~**No CI job builds the Docker images**; production starts the backend with `ts-node`~~ — **both done in Tier 580** (`docker-build.yml`, path-triggered; the image runs `node dist/main.js`). `release.yml` still only runs on a `v*` tag and has never run.
    - **Account self-service:** no e-mail verification at registration, no deletion of an account or company, no data export for a data subject. (~~no "change my password" while signed in~~ — done in Tier 575.)
    - **Unfinished by design, and saying so:** FinTS TAN submission and transfers (stubs), ELSTER (an export for transcription, container format unverified, no transmission — item 9), E-Bilanz (XBRL with positions left "TODO (manuell)" for the Steuerberater), ~~PDF signature verification (structural only)~~ (a real check since Tier 583 — it had called tampered PDFs valid), cloud storage ("coming soon").
    - **Tests:** 342 backend specs + 1004 Playwright tests, all end-to-end; two unit-test files. The backend suite expects a fresh database (15 specs fail on a reused one). No load test in this stretch. ~800 `any` in the backend, ~330 in the frontend; four files over 2 700 lines.
    - ~~**The owner's local development database is gone**~~ — rebuilt in Tier 571 from `backup-2026-09-05-224235`, migrated in Tier 582.

23. **Status review 08.10.2026 — measured additions** (after Tier 584; none of it decided or done). An inline review: the planned multi-agent review was cut off three times by the usage limit before a single reviewer finished, so this is narrower than intended — no live reconciliation of one month across UStVA / DATEV / EÜR / journal, no browser sweep of every page, no fresh cross-tenant probe (**done since:** Tiers 585–587 the month, 589–590 the browser walk, 592 the cross-company test).
    - ~~no browser sweep of every page~~ — **done, Tiers 589–590** (the activity log leak, fixed; the open points are listed there).
    - ~~**Two finished pages have no link anywhere in the UI:** `/dashboard/assets` (fixed assets, AfA) and `/dashboard/berater`. No file under `frontend/src` mentions either path except the page itself; the hub that carries the links is `frontend/src/app/dashboard/page.tsx`. They are reachable by typing the URL only.~~ — a card each on the dashboard, Tier 590.
    - (**done in Tier 604** — it shows the operator company's own details) **The Impressum is hard-coded placeholder text** (`frontend/src/app/impressum/page.tsx`: „Musterstraße 1, 12345 Musterstadt“, `info@example.com`). Its header comment promises a deployment-time template (.env → company settings); the page reads no configuration and no deploy document mentions it. An operator has to edit the source before going public (§ 5 DDG).
    - **The backend container runs as root** (`backend/Dockerfile` ends on `USER root`, on purpose — the storage volume comes up root-owned); the frontend runs as `app`. `infra/prod/docker-compose.yml` sets no `user:`, `read_only`, `cap_drop` or `no-new-privileges`.
    - **No Verfahrensdokumentation** (GoBD): no template and no mention in code or documents. No `LICENSE`, no changelog.
    - (**fixed in Tier 594** — four real jobs; `fints.service.ts` and `cron-health.service.ts` only mention `@Cron` in a comment.) **`DISABLE_CRON=1` — the files with an `@Cron` and no check for it:** `webhook/webhook-retry.scheduler.ts`, `fints/fints-sync.scheduler.ts`, `fints/fints.service.ts`, `admin/cron-health.service.ts`, `exchange-rate/exchange-rate.service.ts`, `assets/afa-auto-booker.scheduler.ts`. The last one writes into the books: `5 0 1 * *`, on for every company unless `settings.autoBookAfa === false`. "Start with `DISABLE_CRON=1`" does not stop it.
    - (**done in Tier 599**) **Leitweg-ID:** `invoices/xrechnung.service.ts` takes a `leitwegId`; nothing under `frontend/src` contains "leitweg" or "buyerReference", and the schema has no such column. To confirm how an invoice to a public authority gets its buyer reference from the UI.
    - **No closing of the books.** A submitted UStVA locks the invoices, expenses, payments, cashbook entries and bank bookings of its period (Tier 537, `reports/filed-period.ts`); `voucher.service.ts` and `journal.service.ts` do not use it, and no model holds a year-end lock (Festschreibung). To confirm whether a manual voucher dated into a closed year should be refused.
    - **Document types are INV, CN, PI (pro-forma) and RCV:** no quote (Angebot) or delivery note; no time tracking. Product decisions. (Corrected in Tiers 585–587: this line first said there was no pro-forma — there is.)
    - ~~no live reconciliation of one month~~ — **done, Tiers 585–587**: the figures agree; three defects fixed on the way. ~~Open from it: `UBL-CreditNote-2.1.xsd` + a scenario for the official validator~~ — done in Tier 588.
    - (**done in Tier 607**, with a static check) **Environment variables read in code but in no `.env.example`:** `STORAGE_PATH`, `BACKUP_ROOT`, `BACKUP_DOCKER_CONTAINER`, `HTTP_KEEPALIVE_TIMEOUT_MS`, `DISABLE_VAT_REVERIFY_EMAIL` (the other undocumented ones are test switches).
    - **Small:** five models with `companyId` have no index led by it (`User`, `CustomerPortalSession`, `VatRate`, `VatRateHistory`, `WebhookDelivery` — only the last grows); 227 of 272 `findMany` calls carry no `take` (most are bounded by a parent row; no load test has shown which are not).

24. **Status 09.10.2026 — what is still open after Tier 608.** Since the review of 08.10. (item 23) three checks were done — a month reconciled by hand (the figures agree), every page walked in a browser, the cross-company test redone — and 24 tiers of fixes (585–608) came out of them, two of them leaks between companies (the activity log, Tier 589; the bulk download's manifest, Tier 592). What is left, by who has to move:
    - **The owner / operator, before anyone else uses it:** a server, domain, SMTP, `FINTS_PIN_ENC_KEY`, an off-site copy of backups and storage (item 22); the operator company's details, which are the Impressum now (Tier 604); a privacy policy and a processing agreement of its own — `/datenschutz` is a generic text; the cookie banner, which asks for consent to analytics and marketing that do not exist (Tiers 589–590); a licence for the code, if anyone else is to get it; the tax and legal decisions of items 5, 9, 12, 13, 15, 17–21, plus one more for the Steuerberater: Skonto is booked against 8400, not 8736 (Tiers 585–587).
    - **Product scope — decided on 09.10.2026 („都做“, twice) and built:** the closing of the books (Tier 609), quotes and delivery notes (Tier 610), time tracking (Tier 611); then what those tiers had left out — the order confirmation (614), a quote invoiced and delivered in parts (615), projects and default hourly rates (616), the timer (617), the time sheet PDF (618). **Still to decide:** a per-invoice buyer reference (an authority's order number) next to the customer's Leitweg-ID (Tier 599); stock moved by a delivery note instead of the invoice; (the small things Tiers 610–625 had listed as not built were all built by Tier 628).
    - **Unfinished and saying so** (unchanged): FinTS TAN and transfers, ELSTER transmission, E-Bilanz positions, cloud storage, the tax annexes' placeholders; no e-mail verification, account deletion or data-subject export; e-invoices by upload only, no automatic EN 16931 check on import; CSV import and the OCR proposal know one VAT rate; no Verfahrensdokumentation.
    - **Technical, found and not done:** the backend container runs as root, the compose file sets no `read_only` / `cap_drop` / `no-new-privileges` (item 23); (`MailConfig.smtpPassword` is sealed since Tier 630;) `release.yml` never run; (the implicit conversion of numbers: Tier 633; the flags in untyped bodies: Tier 632;) (the Leitweg-ID's check digits: Tier 634;) (the five models without an index led by `companyId`: Tier 635;) 227 `findMany` without `take`, no load test; the FinTS matcher (`fints.service.ts`, a second one next to the statement import's, Tier 639) proposes any two or more unmatched receipts that add up to an invoice's *total* at confidence 95, whoever paid them — only reachable in mock mode while FinTS has no TAN; two unit-test files, about 800 `any` in the backend.
    - **Interface, found and not done:** the accounting page — developer paths in its explanations, about 730 German words in the other languages (the forms are ordered by legal form since Tier 643); `/dashboard/v2`, the activity page's action names and parts of the import page untranslated; (the fields have labels since Tier 637 — 143 measured, 10 left with a placeholder only;) (the dashboard's cards and the invoice form's search fields work by keyboard since Tier 636;) on a phone, tables scroll sideways inside their box and `/dashboard/accounting` is 12 px too wide at 350 px.
    - **What the three checks did not cover:** the reconciliation — a real exchange rate (the balance sheet, and through it the bank file formats: Tier 642; OSS: Tier 641; the bank import: Tier 639; Ist-Versteuerung and dunning: reconciled in Tier 638; a Kleinunternehmer: checked with the new document types); the page walk — clicking through tasks, other browsers, a real device, a screen reader; the cross-company test — 26 of 74 GET routes with a path parameter had no live target (roles inside one company: done in Tier 629; one customer against another in the portal: Tier 631; the operator's routes: Tier 632).

25. **For the Steuerberater and the owner, from the reconciliations of 10.10.2026 (Tiers 638–641).**
    - **OSS:** does the company take part in the OSS scheme (§ 18j UStG)? The app cannot tell, and treats a sale to a consumer in another member state by its rate: a rate that is not German is that state's tax (out of the UStVA, in the OSS report), 19 % or 7 % is German tax (Kz 81 / 86) — wrong for an OSS seller's customers in Cyprus. A switch in the company settings would settle it. And: is the net of OSS sales to be shown in a Kennzahl of the UStVA? It is in none now.
    - **Dunning:** interest is charged on what is open today for the whole time since the due date; a part paid late bears none. Less than § 288 BGB allows, never more — intended?
    - **Dunning fees:** the defaults are 5 € / 5 € / 10 € from the first reminder on (Tier 164). Whether a fee may be charged for the reminder that itself puts the customer in default is the owner's to decide with a lawyer.
    - (**Dunning levels:** decided 10.10.2026, Tier 647 — Zahlungserinnerung / 1. Mahnung / Letzte Mahnung everywhere.)
    - **Bank files:** the CAMT.053 and MT940 readers were rebuilt from the schema (Tier 642) without a real file to test against — the first statement downloaded from the company's bank should be put through the preview before it is relied on.
    - **Bank import:** an amount beyond what is open on the matched invoice stays on the bank entry; it is not turned into a customer credit (a payment entered by hand is, Tier 58).
    - **Two questions asked earlier and not answered:** should the time sheet be attached to an invoice e-mail by default (it is), and should CSV exports use a decimal comma — **answered 10.10.2026: a comma (Tier 648)**.

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

- **A CSS rule for "every X" matches things you did not picture (Tier 603).** `.flex:has(> button) { flex-wrap: wrap }`, meant for button rows, matched `<body>` and widened 23 pages. After a global style change, run the page walk over ALL pages again (`$S/review/ui/walk.js mobile`), not only over the pages the change was for — and measure narrower than the test (350 px), because the CI machine's fonts are wider than macOS's.

- **A new document type is checked by calling the routes, not by reading the queries (Tier 612).** After adding quotes and delivery notes to the `Invoice` table, a scan of the code for invoice queries without a type filter looked clean — it counted `type: true` in a select and any mention of `invoiceNumber` as a filter, and skipped `findFirst`. Calling every write route with a quote's id and searching every GET response for its number found six places in an hour, one of them a voucher booked for a quote and one a customer marking a quote as paid.

- **"Looked at on desktop and phone" skips the width where grids have the most columns per pixel (Tier 620).** A three-column grid at 768 px has narrower columns than the one-column layout at 390 px; a long German compound in a card title overflowed only there. Measure new UI at 375 / 640 / 768 / 1024 / 1280, in all three languages — it is one script and a minute.

- **In a spec, `X=$(helper …)` runs the helper in a subshell (Tier 628).** Whatever it sets besides its output — `$STATUS`, `$BODY` — is gone; an assertion on `$STATUS` right after it tests an earlier call and passes for the wrong reason. Assert on a call made in the shell itself.

- **A spec that moves a clock back must not then say "today" (Tier 636b).** Spec 371 sets a timer's start 95 minutes into the past and expected the entry on today's date; the entry is dated the day the timer started. Right for 22 hours and 25 minutes of the day — the CI run that began at 23:57 Berlin reached the spec at 00:15 and failed. Take the expected date from the same source as the code does (the start), and when a run fails only at night, try it at night: it reproduced locally at 00:20.

- **A test that fails only at night may be telling the truth about the product (Tier 640).** The second red run of the same night looked like the first (a spec's own date arithmetic, Tier 636b) and was not: the page compared dates in the browser's time zone. Before fixing the test, ask who else lives in that condition — a UTC browser after midnight is a user abroad every evening. `page.clock.setFixedTime` and a context with `timezoneId` reproduce it at any hour.

- **A PDF is checked by opening it (Tier 644).** Nineteen PDF routes had specs: status 200, `%PDF`, a size, sometimes a page count. Eleven of them had headings broken mid-word in the wrong column and their explanations cut off at the page edge, and the balance sheet printed „!³“ in front of every note — since the tier that made them. Read the file as an image once; and where a layout rule can be stated, read it out of the content stream (the x of each line: `1 0 0 1 x y Tm`).

- **Look at the output as a company that is not the first one (Tier 646).** The owner's company name, tax number and IBAN stood as literals in a PDF's letterhead and in the invoice signature; every check by eye had been made as that company, where they are right. A literal that is true for the developer's own data is invisible until someone else's data is used — search the source for the seed company's name, VAT id and e-mail domain.

- **A green run with „1 flaky“ is a finding (Tier 646c).** Playwright retries twice in CI; a test that fails once and passes on retry leaves the run green and one word in the summary line. Four runs carried it before it was read — it was a timing change of that very tier. After every run read the summary line (`N passed`, `flaky`, `skipped`), not the conclusion; a flaky test on a page just changed is caused by the change until shown otherwise.

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
