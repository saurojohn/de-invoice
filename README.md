# de-invoice — Deutsches Rechnungs- & Buchhaltungssystem
# de-invoice — German Invoice & Accounting System
# de-invoice — 德国发票与会计管理系统

> GoBD-konforme Rechnungs-, Buchhaltungs- und Bankensoftware für kleine
> und mittelständische Unternehmen im DACH-Raum. Inklusive XRechnung,
> ZUGFeRD/Factur-X, DATEV-Export, UStVA, FinTS-Banking und OCR-Vorbereitung.

**Tier 119 — Cron health monitoring (admin/cron-health endpoint)**:
- 143 backend e2e tests + 337 Playwright UI tests (all green)
- A central `CronHealthService` records every run
  of the 7 background crons (webhook-retry, fints-
  sync, reminder-auto-send, vat-reverify,
  exchange-rate-refresh, afa-auto-booker,
  recurring-invoices + the new `cron-health-
  cleanup`) into a `CronHealth` table. The
  admin endpoint surfaces last-run / next-run /
  status / last-error for the Berater + Mandant
  overview page.
- `CronHealthService.wrap(name, fn)` is the
  shared try/catch helper. Each scheduler calls
  `this.health.wrap('<name>', async () => { …
  })` so the try/catch + duration + error capture
  is in ONE place (not duplicated 7× across the
  schedulers).
- `list()` joins the most-recent row per cron via
  `DISTINCT ON (name)` (Postgres-specific but
  matches the project's de-invoice stack) and
  computes a `health` colour:
  - `'green'` last run succeeded and < 2× interval
    ago
  - `'amber'` last run > 2× interval ago (cron
    looks stuck)
  - `'red'` last run failed
  - `'grey'` never ran (fresh DB)
- `POST /api/v1/admin/cron-health/clean` deletes
  rows older than 7 days. Wired to a nightly
  `cron-health-cleanup` @Cron at 03:00 Berlin.
- `users.service.ts` adds `'admin.read':
  ROLES.ACCOUNTANT` so the Berater + Mandant can
  both see the dashboard (same rank as reports).
- e2e `143-tier119-cron-health.sh`: 6 sections,
  13+ assertions — covers the table existence,
  fresh DB "all grey", the 4 health colours
  (green/red/amber/grey via fake-tick inserts),
  and the clean endpoint. ALL PASSED.
- 12/12 cross-cutting regression tests pass
  (42, 50, 58, 60, 101, 108, 112, 139, 140, 141,
  142, 143).

**Polish #13 — 108 GuV cleanup reliability**:
- 142 backend e2e tests + 337 Playwright UI tests (all green)
- The 108 GuV test's EXIT trap used
  `<<SQL >/dev/null 2>&1` (heredoc + redirect combo)
  which had a stdin-buffering race when invoked
  from inside an EXIT trap on macOS bash. The
  cleanup appeared to succeed but the docker
  exec's SQL never actually ran, leaving 3
  GUV-* fixtures in the DB and contaminating
  the 141 / 142 / BWA / PnL / GuV / UStVA tests'
  baseline-snapshot assertions.
- Fix: 5 separate `docker exec psql -c "DELETE ..."
  >/dev/null` calls. Each call has its own
  stdin, no heredoc-vs-redirect parsing race, and
  the user can see psql's `DELETE N` output if
  they need to debug. Also broadened the pattern
  from `GUV-${TS}-%` to `GUV-%` so a missed TS
  capture doesn't leak residue from a prior run.
- 3 consecutive 108 runs now leave 0 GUV-*
  fixtures (verified).
- The 141 / 142 tests still keep their defensive
  `GUV-%` cleanup + PRE exclusion as belt-and-
  suspenders, but the root cause is now fixed.

**Polish #12 — pg_restore fix + 141 test GUV-residue tolerance**:
- 142 backend e2e tests + 337 Playwright UI tests (all green)
- **pg_restore fix** (`backend/prisma/migrations/20260701000001_search_tsv/migration.sql`):
  The `immutable_unaccent` wrapper function called
  `unaccent('unaccent', $1)` (the 2-arg `unaccent(regdictionary, text)`
  form). On a fresh DB restore, pg_restore replayed the
  EXTENSION record before the wrapper's body was fully
  resolvable, raising 53 "function unaccent does not
  exist" errors and exiting with status 1. Fix:
  schema-qualify the call as `public.unaccent($1)` (the
  1-arg overload), so the function resolves via the
  explicit schema even before the extension's own
  functions are visible in the restore session.
  Verified with the 42 backup-fire-drill test (now
  passes end-to-end).
- **141 test GUV-residue tolerance**
  (`backend/e2e/141-tier118-multicurrency.sh`):
  The 108 GuV test's EXIT trap sometimes doesn't run
  (e.g. when the script encounters a set -e abort
  downstream), leaving 3 GUV-* fixtures in the DB.
  The 141 EÜR baseline-snapshot test is sensitive to
  this pollution (the residue contributes 2000 EUR
  to Kz 4100, breaking the PRE + delta = POST
  invariant). Fix: 141 now also wipes `GUV-%`
  fixtures at the start, and its PRE query excludes
  the same prefix.
- e2e `42-backup-fire-drill`: now ALL PASSED (was
  2 failures: pg_restore exit 1 + row count mismatch
  caused by the same restore errors).
- e2e `141-tier118-multicurrency`: now ALL PASSED
  even when run after 108 (was 1 failure on the
  EÜR Kz 4100 baseline check).
- All 11 cross-cutting regression tests pass:
  42, 50, 58, 60, 101, 108, 112, 139, 140, 141, 142.

**Tier 118.5 — Cross-currency aggregation in UStVA / BWA / PnL / GuV (Tier 118 follow-up)**:
- 142 backend e2e tests + 337 Playwright UI tests (all green)
- The four German Finanzamt-facing reports (BWA,
  PnL / GuV, UStVA) now aggregate in EUR across
  currencies, mirroring what Tier 118 did for the
  EÜR. The original-currency amounts stay on the
  customer-facing PDF / XRechnung; the EUR
  equivalents (pre-computed at issue time from the
  ECB rate) are what the reports sum.
- **BWA** (`bwa.service.ts`): `invoiceMonat`,
  `invoiceVormonat`, `invoiceYtd`, `vorjahresYtdInvoice`
  use `eurSubtotal ?? subtotal` for the BWA 1000
  (Umsatzerlöse) line.
- **PnL** (`pnl.service.ts`): `_sum` aggregates
  include `eurSubtotal` and `eurTotalVat` alongside
  the original amounts; the result map picks EUR
  first with original as fallback.
- **GuV** (`accounting/guv.service.ts`): `umsatzerloese`
  and downstream lines use `eurSubtotal ?? subtotal`.
- **UStVA** (`ustva.service.ts`): per-invoice EUR
  conversion factor `eurSubtotal / subtotal`
  (defaults to 1 for null rows), applied to each
  line's `netAmount` / `vatAmount` before bucketing
  into the Kennziffern. EUR-foreign sales land in
  the same Kz 81 / 86 / 77 buckets as EUR sales.
- e2e `142-tier118-5-eur-aggregation.sh`: 6
  sections, 9+ assertions — covers baseline+delta
  pattern for BWA / PnL / GuV (UStVA shape varies
  across versions, smoke-tested). Pre-query
  excludes the test's own PREFIX AND GUV-%
  (residual fixtures from the 108 GUV test).
- Regression: 101, 108, 112, 139, 140, 141, 58, 60
  all still pass.
- 141 PRE query also now excludes `GUV-%` to
  tolerate 108 test pollution.

**Tier 118 — Multi-currency (Invoice.currency + ECB rates + EUR aggregation)**:
- 141 backend e2e tests + 337 Playwright UI tests (all green)
- Invoices can now be issued in any ISO 4217 currency
  the company has ECB rates for (EUR, USD, CHF, GBP, JPY,
  PLN, CZK, CNY by default).
- New Invoice columns:
  - `exchangeRate` (Decimal 12,6) — the ECB rate at issue
    time ("1 EUR = X currency", e.g. 1.138 for USD).
  - `eurSubtotal` / `eurTotalVat` / `eurTotal`
    (Decimal 12,4) — pre-computed EUR equivalents for
    cross-currency aggregation.
- For EUR invoices: `exchangeRate = 1.0000` and the EUR
  amounts mirror the originals. Backfill on existing rows.
- For non-EUR invoices: the backend looks up the rate
  from `Company.settings.datev.exchangeRates` (the
  existing ECB cache from the `ExchangeRateService`
  cron at 02:00 Berlin) and computes the EUR equivalents
  at issue time.
- Reuses the existing `ExchangeRateService` —
  `infra/kosit` cron pulls ECB daily rates, the
  controller exposes `GET /exchange-rates` for the
  manual refresh, and the `getRate(companyId, ccy)`
  helper returns the ECB rate string.
- **EÜR aggregation** now uses `eurSubtotal` (with
  `?? subtotal` fallback for legacy null rows). The
  Finanzamt form sums everything in EUR regardless
  of source currency. Same change will be applied
  to UStVA / BWA / GuV as those reports are extended.
- XRechnung generator: original currency preserved on
  the XML (`<cbc:DocumentCurrencyCode>USD</...>`) and
  on the PDF — customer-facing artifacts stay in the
  customer's currency, internal aggregation is in EUR.
- Frontend invoice form: Währung selector with 8 ISO
  codes, Intl.NumberFormat renders the right symbol
  in the Summary card (e.g. `1.190,00 $` for USD,
  `1'190.00 Fr.` for CHF).
- i18n: `invoice.currencyHint` × 3 locales (DE/EN/ZH).
- e2e `141-tier118-multicurrency.sh`: 7 sections, 18+
  assertions — covers EUR rate=1 case, USD/CHF
  cross-currency math, EÜR aggregation delta, and
  XRechnung `DocumentCurrencyCode` preservation.

**Tier 117 — XRechnung generator: UBL 2.1 XSD element order + BR-DE compliance**:
- 140 backend e2e tests + 337 Playwright UI tests (all green)
- Generator now produces UBL 2.1 XSD-compliant XML that
  passes KoSIT Validator 1.6.2 with `acceptance: ACCEPTABLE`
  for all 4 invoice types (B2B, B2B-OSS, B2G, Skonto).
- Fixes applied to `backend/src/invoices/xrechnung.service.ts`:
  - **UBLVersionID=2.1** added (XRechnung 3.0 expects it)
  - **Element ordering** matches the UBL 2.1 XSD sequence
    (UBLVersionID → CustomizationID → ProfileID → ID →
    IssueDate → DueDate → InvoiceTypeCode → Note →
    DocumentCurrencyCode → TaxCurrencyCode (omitted per
    BR-53) → LineCountNumeric → BuyerReference →
    InvoicePeriod → SupplierParty → CustomerParty →
    PaymentMeans → PaymentTerms → AllowanceCharge →
    TaxTotal → LegalMonetaryTotal → InvoiceLine)
  - **Note** moved from end of invoice to after
    `InvoiceTypeCode` (XSD position)
  - **TaxCurrencyCode** omitted when equal to
    `DocumentCurrencyCode` (BR-53)
  - **InvoiceLine / AllowanceCharge** + **TaxTotal**
    positioned BEFORE `Item` and `Price` (XSD position)
  - **ItemLocationQuantity** (UBL 2.0) replaced with
    **Item / ClassifiedTaxCategory** (UBL 2.1)
  - **InvoicePeriod** (BG-14) added with StartDate = EndDate
    = issueDate — satisfies BR-DE-TMP-32 for service invoices
  - **Seller Contact** (BR-DE-2/6/7) now includes Name +
    Telephone (BT-42) + ElectronicMail (BT-43) — sourced
    from `Company.email` + `Company.phone` columns
  - **Customer EndpointID** falls back to Leitweg-ID
    (scheme 9930) when no VAT-ID is present — required for
    B2G buyers (BR-DE-TMP-1)
  - **AllowanceCharge** currencyID now derived from
    `data.currency` (was hardcoded `EUR`)
- e2e `139-tier115-xrechnung.sh`: now also asserts
  UBLVersionID=2.1, LineCountNumeric, and BuyerReference
  is after DocumentCurrencyCode (line-number order check).
- e2e `140-tier116-kosIT.sh`: now asserts
  `engine=kosit` returns `schema=Y`, `schematron=Y`,
  `acceptance=ACCEPTABLE` for B2B, B2B-OSS, B2G, Skonto.

**Tier 116 — KoSIT Validator 1.6.2 integration (XRechnung 3.0.2 official validation)**:
- Replaces the in-process BR-* check (Tier 115) with the
  official KoSIT Validator 1.6.2 for full EN 16931 compliance
  (150+ rules: BR-*, BR-CO-*, BR-DEC-*, BR-S-*).
- New `?engine=basic|kosit` parameter on the validate endpoint:
  - `?engine=basic` (default): fast in-process BR-* check
    from Tier 115 (BR-01..13). No Java/JAR required.
  - `?engine=kosit`: spawns the KoSIT Validator JAR via
    child_process, parses the result table, returns the
    full EN 16931 verdict.
- **Graceful fallback** when the KoSIT JAR / JDK is missing:
  the controller falls back to the basic engine with a
  warning, so the endpoint is always responsive.
- Infra: `infra/kosit/validator.jar` (10MB) +
  `infra/kosit/scenarios.xml` + `infra/kosit/repository/`
  (~2.5MB UBL 2.1 XSDs + XRechnung 3.0.2 schematron).
  `infra/kosit/setup.sh` is the one-shot installer
  (idempotent, downloads from KoSIT releases + OASIS UBL).
  JDK 17 (Eclipse Temurin, ~300MB) is added to `.gitignore`
  and downloaded by `setup.sh`.

**Tier 115 — XRechnung 3.0.2 (German B2B e-invoice — mandatory since 2025)**:
- 139 backend e2e tests + 337 Playwright UI tests (all green)
- Upgraded the existing XRechnung service from v1.2
  (UBL 2.0) to **XRechnung 3.0.2** (UBL 2.1 + KoSIT 2024 —
  the current spec). CustomizationID:
  `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`.
- **BuyerReference** is now mandatory (BR-1 v2).
  Auto-derived from `customer.address.buyerReference`
  → `customer.address.leitwegId` → customer name.
- **PaymentMeans** block with IBAN + BIC (BR-16
  validation, including the regex check).
- **AllowanceCharge** for Skonto (per-invoice + future
  per-line Rabatt). Reason codes: 95 (Skonto), 1
  (discount).
- **Leitweg-ID** for B2G invoices: stored in
  `customer.address.leitwegId` or `company.settings.leitwegId`.
  Surfaced as the BuyerReference for B2G.
- **EndpointID scheme IDs** standardised: 9930 (Leitweg-ID),
  9931 (Steuernummer), DE:VAT (VAT), EM (email).
- **Validation endpoint** `GET /invoices/:id/xrechnung/validate`:
  in-process BR-* check (engine=basic). For the official
  full validator, use `?engine=kosit` (see Tier 116).
- ProfileID: `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`
  (Peppol BIS Billing) — the standard that XRechnung
  3.0.2 aligns with.

**Tier 112 — SEPA pain.008 (Lastschrift / Direct Debit — incoming payments)**:
- 137 backend e2e tests + 333 Playwright UI tests (all green)
- The customer-side counterpart to Tier 108 (pain.001).
  Instead of paying suppliers, here the company RECEIVES
  money from customers via SEPA direct debit.
- SEPA-Lastschriftmandat (mandate) per customer: CORE (B2C,
  14-day Vorabankündigung + 8-Wochen-Widerruf) or B2B
  (1-day Vorabankündigung, no Widerruf).
- Auto-generated Mandatsreferenz format:
  `MANDATE-{K-NNNN}-{YYYYMMDD}-{NNNN}`. One customer can
  sign multiple mandates (e.g. per subscription).
- pain.008.001.02 XML schema: `<CstmrDrctDbtInitn>` →
  `<GrpHdr>` → `<PmtInf>` (PmtMtd=DD, SvcLvl=SEPA,
  LclInstrm={CORE|B2B}, CdtrSchmeId with Gläubiger-ID) →
  N× `<DrctDbtTxInf>` (PmtId + InstdAmt + DrctDbtTx{MndtId,
  DtOfSgntr} + DbtrAgt + Dbtr + DbtrAcct + RmtInf).
- §2.2 Scheme Rulebook enforced: all collections in one
  batch must use the same type. Mixed CORE+B2B → 400.
- Pre-notification deadline: executionDate - 14 (CORE) /
  - 1 (B2B). v1: stamps preNotificationSentAt; v2 wires
  actual email send.
- 18-char Gläubiger-Identifikationsnummer (Bundesbank) per
  company, stored in `Company.settings.sepaCreditorIdentifier`
  with auto-derived fallback from company UUID.
- `/dashboard/payments/direct-debit` page (1031 LOC) with
  three cards: Mandate manager, Open-invoices picker,
  Past-batches history. Tab bar shared with pain.001.
- E2E 137 (17 sections, 60+ assertions): mandate CRUD +
  validation, open-invoice eligibility, batch generation,
  XML structure + math identity (CtrlSum = Σ InstdAmt),
  CORE vs B2B deadline, mixed-type rejection, revoked /
  mismatched mandate rejection, cross-tenant 401, XML
  download, two mandates per customer.
- v1: no R-Transaction (Rücklastschrift) auto-credit.
  v2: SEPA pain.008 return handling + email-driven
  pre-notification + automatic mandate renewal reminders.

**Tier 110 — Anlage AUS (Ausländische Einkünfte, § 34d EStG — the 9th Anlage form)**:
- 136 backend e2e tests + 307 Playwright UI tests (all green)
- Anlage AUS: international dimension. Per-entry 2-way
  decision: hasDba=true → Freistellung (Progressionsvorbehalt
  per § 32b EStG) / hasDba=false → Anrechnung (foreign tax
  credited, § 34c EStG).
- For KapG (GmbH/AG/KGaA/UG): § 8b KStG overrides — 95% of
  foreign dividends exempt, 5% non-deductible.
- BMF Vordruck Anlage AUS 2024 Kz: 5 (Progression), 6
  (Taxable), 13 (Anrechnung), 20 (§ 8b Pauschale), 32
  (Dividends), 34 (Interest), 40 (Gewerbe foreign), 42
  (Employment foreign).
- Berater packager: 13-way shift (Anlage AUS as 9th
  optional). Auto-include when entries.length > 0.
- 7th feature-flag toggle (anlageAus) — force-include in
  Berater package regardless of heuristic.
- v1: per-entry manual input. v2: auto-import from
  broker PDFs + automatic Wechselkurs-Lookup +
  complete DBA-table integration.

**Tier 109 — Anlage SO (Sonstige Einkünfte, § 22 EStG — the 8th Anlage form)**:
- 135 backend e2e tests + 302 Playwright UI tests (all green)
- Anlage SO: catch-all for private Veräußerungsgeschäfte
  (Krypto / Gold / Aktien within Spekulationsfrist) +
  wiederkehrende Bezüge (private Pensionen, Unterhalt).
- Math: 1-year Spekulationsfrist for Wertpapiere
  (§ 23 Abs. 1 Nr. 2 EStG), 10-year for Sonstige WG
  (§ 23 Abs. 1 Nr. 1 EStG). 600 EUR Freigrenze
  (§ 23 Abs. 3 Satz 5 EStG): total taxable gain ≤ 600 → tax-free.
- BMF Vordruck Anlage SO 2024: Kz 32 (Wertpapiere) +
  Kz 34 (Krypto) + Kz 41 (Sonstige WG) + Kz 20 (Freigrenze)
  + Kz 11/12 (Wiederkehrende Bezüge + Werbungskosten).
- Berater packager: 12-way shift (Anlage SO at optionalSlot+1,
  pushes UStJA/GewSt/BWA by +1). Auto-include when
  transactions.length > 0 OR wiederkehrendeBezuege > 0.
- 6th feature-flag toggle (anlageSo) — force-include in
  Berater package regardless of heuristic.
- v1: no auto-import from bank; user enters transactions
  manually. v2: auto-detect sales from bank transactions
  (BTC exchanges, broker PDFs) + complete loss-verrechnung.

**Tier 108 — SEPA pain.001 batch payments (ISO 20022 Sammelüberweisung)**:
- 134 backend e2e tests + 297 Playwright UI tests (all green)
- SEPA pain.001.001.09 XML generator: bundles open
  Eingangsrechnungen (status='booked', paidAt IS NULL, supplier
  with valid IBAN) into one pain.001 batch the Berater downloads
  + uploads to the house bank's online banking portal.
- `/dashboard/payments` page: checkbox list of unpaid expenses +
  create-batch form (execution date + notes) + past batches table
  with per-row XML download.
- `SepaBatch` model + `Expense.paidAt` + `Expense.paidBySepaBatchId`
  (with explicit `@relation("ExpensePaidByBatch")` to disambiguate
  from the same-model relation).
- Math identity: `CtrlSum = Σ CdtTrfTxInf.InstdAmt` in the XML
  (verified by e2e 134 §10).
- Permissions: extended `ROLE_PERMISSIONS` with `expense.read/write`
  + `payment.read/write` (was 403-ing the unpaid endpoint before
  the fix).
- v1: read-only export + manual mark-as-paid (no SEPA network
  integration). v2: pain.008 (Lastschriften / incoming direct
  debits) + auto-reconciliation with bank-statement import.

**Tier 107 — UStJA ELSTER XML (BMF Datenlieferung for § 18 Abs. 3 UStG annual VAT return)**:
- 133 backend e2e tests + 292 Playwright UI tests (all green)
- UStJA ELSTER XML: same ERiC Datenlieferung envelope as the UStVA
  monthly path, but AnlageName='AnlageUStJA' + Zeitraum is the
  full calendar year (no Quartal/Monat) + Kz 66/67/68/39/69/81 from
  the consolidated annual aggregation. BMF has required UStJA
  submission via ELSTER since 2024 — this completes the compliance
  chain alongside the UStVA monthly ELSTER export.
- ASCII preview companion for visual sanity check (Mein-ELSTER
  paste-import format).
- Anlage S / V / KAP / G / N / R / Kind + UStJA + GewSt for Berater-Packager
  — 11-way conditional shift (plus KSt 1; UStJA + GewSt always-on)
- 5th feature-flag toggle (anlageKind) — force-include in Berater package
- E-Bilanz (XBRL) v2 — 52 BMF GCD 6.7 positions
- 404/500 error pages + mobile responsive + deploy readiness
- 2432 i18n keys × 3 locales (DE/EN/ZH), 100% consistent

---

## ⚡ Quickstart (5 Minuten)

```bash
# 1. Repo klonen + Node 22 prüfen
node --version   # muss >= 22 sein

# 2. Dependencies installieren
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# 3. Datenbank starten + App hochfahren
./start.sh       # bringt Postgres + Backend (3001) + Frontend (3000) hoch

# 4. Im Browser öffnen
open http://localhost:3000
# Login: info@shleder.de / Test1234!
```

Die App ist sofort einsatzbereit mit Testdaten (SH Leder GmbH).

### E2E-Tests (137 Backend + 333 Playwright UI, ~9 Min)

```bash
# Backend hochfahren
cd backend && npm install && npx ts-node src/main.ts &

# Alle 137 Backend-Tests
cd backend && for f in e2e/[0-9]*.sh; do bash "$f"; done

# 333 Playwright UI-Tests (Frontend muss auf 3100 laufen)
cd frontend && npm install && npx playwright install chromium
cd frontend && npx playwright test
```

### Produktion (Docker)

```bash
cp .env.example .env                                       # JWT_SECRET etc. setzen
docker compose -f docker-compose.prod.yml up -d --build    # Postgres + Backend + Frontend
```

Required env vars (see DEPLOY.md §2.1):
- `POSTGRES_PASSWORD` — postgres role password
- `JWT_SECRET` — backend JWT signing secret (`openssl rand -hex 32`)
- `NEXT_PUBLIC_API_URL` — **build-time** URL the browser uses to reach the backend
  (e.g. `https://api.example.com`). Requires `docker compose build frontend`
  BEFORE `up` if changed.

Siehe [DEPLOY.md](DEPLOY.md) für die vollständige Produktionsanleitung
und [RUNBOOK.md](RUNBOOK.md) für Operator-Notfälle (Restore, Rotate,
Troubleshoot).

---

## 🏗️ Architektur

```
                  ┌───────────────────────┐
                  │   Browser (Chrome /   │
                  │   Firefox / Safari)   │
                  └──────────┬────────────┘
                             │  HTTPS (via Cloudflare/reverse proxy)
                  ┌──────────▼────────────┐
                  │   Next.js Frontend    │
                  │   (port 3000)         │     React 19 + Next 16
                  │   - SSR pages         │     standalone output
                  │   - API proxy         │     i18n (DE/EN/ZH)
                  └──────────┬────────────┘
                             │  HTTP (internal docker network)
                  ┌──────────▼────────────┐
                  │   NestJS Backend      │
                  │   (port 3001)        │     30+ modules
                  │   - REST API          │     throttler (600/60s)
                  │   - Cron jobs         │     self-hosted Sentry
                  │   - PDF gen (PDFKit)  │     bcrypt + 2FA
                  └──────────┬────────────┘
                             │  Prisma 5
                  ┌──────────▼────────────┐
                  │   PostgreSQL 16       │
                  │   (port 5432)         │     ~50 models
                  │   - GoBD audit trail  │     2FA recovery (SHA-256)
                  │   - Backups (daily)   │     EUR-cents numeric(12,4)
                  └───────────────────────┘
```

### Tech-Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Frontend | Next.js 16 (standalone), React 19, Tailwind | `output: "standalone"` für minimal image size |
| Backend | NestJS 11, TypeScript 5, ts-node | Multi-stage Dockerfile, health endpoints |
| ORM | Prisma 5 (binary engine) | `engineType: "binary"` — avoids libssl 1.1 in slim images |
| Database | PostgreSQL 16 | 50+ models, ~80 indexes |
| PDF | PDFKit (server-side) | GoBD: 1 page, no fills, thin lines |
| E-Invoice | Custom builders | XRechnung (UBL 2.1) + ZUGFeRD 2.1 (PDF/A-3 + XML) |
| Auth | bcrypt + 2FA (TOTP) | Per-route `@Require(action)` |
| Banking | FinTS 3.0 (mock + real) | HKCSE/HKCCS, 2-step TAN |
| Mail | SMTP (nodemailer) | Falls back to "no-smtp" mode in dev |
| Storage | Local FS (`~/data/invoice-system`) | S3/MinIO compatible |
| Backup | `pg_dump` + tar | Daily rotation, 7d/4w/monthly anchors |
| Monitoring | `/metrics` (Prometheus) | 3 gauges + 2 counters + 1 histogram, no deps |
| CI | GitHub Actions | typecheck × 2 + e2e (137 backend + 333 Playwright UI) on every PR |

### 137 E2E-Tests Backend + 333 Playwright UI (470 tests, ~9 Min)

| # | Feature | Tests |
| --- | --- | --- |
| 1-6 | Cashbook (Kassenbuch), Z-Bericht, Storno | 50+ assertions |
| 7-11 | DATEV (per-company, storno, config) | 30+ |
| 8, 36-37 | Bank import (MT940, FinTS read, FinTS write) | 50+ |
| 12-14 | Expenses, voucher templates | 30+ |
| 15 | Dashboard KPIs (perf-optimized, 8ms warm) | 17 |
| 16-19 | Dark mode, email, receipts, bulk import | 40+ |
| 20-21 | VIES VAT validation, self-hosted Sentry | 30+ |
| 22-23 | Reminder cron, logo upload | 25+ |
| 24 | 2FA TOTP | 15+ |
| 25-30 | DATEV Tier 5 + exchange rates + attachments | 80+ |
| 31-32 | FinTS mock + smart match | 40+ |
| 33-34 | Custom invoice templates (PDF applied) | 40+ |
| 35 | Recurring invoice wizard | 16 |
| 36 | Banking reconciliation panel | 17 |
| 37 | SEPA transfer (HKCSE/HKCCS) | 21 |
| 38 | Health endpoints | 12 |
| 39 | SSRF guard on FinTS endpointUrl | 11 |
| 40 | Buchungsjournal PDF (GoBD, X-Journal-* headers) | 14 |
| 41 | Prisma migrate fresh-DB round-trip | 21 |
| 42 | Backup fire-drill (sentinel insert→backup→restore) | 9 |
| 43 | `/metrics` Prometheus endpoint contract | 39 |
| 44-50 | (cost-center, skonto, credit notes, statement, credit-balance, PDF-signing, age analysis) | 100+ |
| 51-65 | (TOTP, OCR, customer portal, dashboard, cost-center-CRUD, cost-suggest, voucher-correct, cost-suggest-prefix, voucher-autopersist, installment-plan, skonto-window, credit-note-PDF, Mahnung-skonto, statement-v2) | 250+ |
| 66-79 | (mandant-switcher, audit-trail, global-search, datev-preview, readonly, PDF-signing-cert, 2FA, cashflow, P&L, Anlage-EUR, GoBD-archive, EU-OSS, Berater-exchange, Anlage-S) | 200+ |
| 80-90 | (Bilanz, G+V, Anlagenverzeichnis, Anhang, Berater-Packager, BWA, AfA-Buchung, E-Bilanz-VORSCHAU, AfA-monatlich, AfA-Storno) | 250+ |
| 91 | Auto-AfA month-end scheduler (cron) | 18 |
| 92 | Anlage V (Vermietung und Verpachtung, § 21 EStG) | 18 |
| 93 | BWA extensions (granular Sonstige + Steuern + Zinserträge) | 24 |
| 94 | Frontend Settings UI for feature flags (autoBookAfa + anlageV) | 13 |
| 95 | BWA im Berater-Packager | 11 |
| 97 | E-Bilanz (XBRL) v2 — 52 BMF GCD 6.7 positions, 17 sub-sections | 50+ |
| 98 | Anlage KAP (Kapitalerträge, § 20 EStG) | 60+ |
| 99a | 404/500 error pages (DE/EN/ZH) | 4 |
| 99b | Mobile responsive (iPhone 12 audit) | 7 |
| 99c | Production deploy readiness (compose lint) | 12 |
| 99d | Security headers regression (helmet + CORS) | 12 |
| 100 | Anlage G (Gewerbebetrieb, § 15 EStG) | 50+ |
| 101 | Anlage N (Arbeitnehmereinkünfte, § 3 EStG) | 40+ |
| 102 | KSt 1 (Körperschaftsteuererklärung, § 1 KStG) | 30+ |
| 103 | Anlage R (Einkünfte aus Renten und Bezügen, § 22 EStG) | 40+ |
| 104 | Anlage Kind (Kinderfreibetrag + Kindergeld, § 32/33/33a EStG) | 50+ |
| 105 | UStJA (Umsatzsteuerjahreserklärung, § 18 Abs. 3 UStG) | 50+ |
| 106 | GewSt-Erklärung (Gewerbesteuererklärung, BMF Vordruck GewSt 1A 2024) | 50+ |
| 107 | UStJA ELSTER XML (BMF Datenlieferung for annual VAT return) | 50+ |
| 108 | SEPA pain.001 batch payments (ISO 20022 Sammelüberweisung) | 50+ |
| 109 | Anlage SO (Sonstige Einkünfte, § 22 EStG — 8th Anlage form) | 60+ |
| 110 | Anlage AUS (Ausländische Einkünfte, § 34d EStG — 9th Anlage form) | 70+ |
| 112 | SEPA pain.008 (Lastschrift / incoming direct debits) | 60+ |
| UI | Playwright suite (77 spec files, 333 tests) | 333 |

---

## 🌐 Sprache / Language / 语言

| Deutsch (Standard) | English | 中文 |
|---|---|---|
| [↓ Deutsche Dokumentation](#deutsch) | [↓ English documentation](#english) | [↓ 中文文档](#中文) |

---

<a id="deutsch"></a>

## 🇩🇪 Deutsch

Eine Webanwendung für kleine und mittelständische Unternehmen in Deutschland
zur **GoBD-konformen** Erstellung, Versendung und Verbuchung von Rechnungen
sowie zur Erfüllung der Anforderungen an **XRechnung** und
**ZUGFeRD/Factur-X**. Entwickelt für SH Leder GmbH (und vergleichbare
B2B-Anwendungsfälle im DACH-Raum).

### Funktionen

#### Rechnungserstellung (Kern)
- Rechnungstypen: Standardrechnung (INV), Gutschrift (CN), Proforma (PI) und
  Quittung (RCV)
- Mehrzeilige Positionen mit deutschen USt-Sätzen (0 %, 7 %, 19 %)
- Rabatte, Zahlungsziele (Sofort fällig / 14 / 30 / 60 Tage), Bankverbindung
  auf dem PDF
- Fortlaufende Rechnungsnummern pro Unternehmen
- Nummernformat: `RE-2026-000001`, `GS-2026-000001` usw.
- Statusworkflow: Entwurf → versendet → bezahlt / überfällig / storniert
- GoBD-konformes 1-Seiten-PDF (keine Farbflächen, dünne schwarze Linien,
  deutsches Zahlen-/Datumsformat `€ 1.234,56` / `dd.mm.yyyy`)

#### Compliance & E-Invoicing
- **XRechnung** (XML, UBL 2.1) — Pflicht im öffentlichen B2G-Bereich
- **ZUGFeRD 2.1 / Factur-X 2.1** — hybrides PDF mit eingebettetem XML für B2B
- **UStVA** (Umsatzsteuervoranmeldung) mit allen Kennzahlen
  (Zeilen 20–23 Umsätze, 26–29 steuerfrei, 36 Reverse Charge,
  50–66 Vorsteuer, 81 Differenzbetrag)
- **SEPA pain.001** (Sammelüberweisung, ISO 20022) — bündelt
  offene Ausgaben zu einer XML-Datei für die Hausbank
- **SEPA pain.008** (Lastschrift, ISO 20022) — das Kunden­gegenstück.
  Pro Kunde ein SEPA-Lastschriftmandat (CORE/B2B),
  Gläubiger-Identifikationsnummer, Vorabankündigung gemäß
  §2.2 SEPA Scheme Rulebook, pain.008.001.02 XML mit
  MndtId + DtOfSgntr je Lastschrift
- Ausgabenverwaltung mit Zuordnung zu UStVA-Zeilen
- Audit-Log

#### Kunden- und Produktverwaltung
- Kunden-Stammdaten mit USt-ID, freiem Ländertext, deutscher Adressformat
- CSV-Import/Export (RFC 4180 + UTF-8-BOM für Excel)
- Pro Kunde: Datum der letzten Rechnung + Anzahl Rechnungen (effizientes
  groupBy)
- Produktkatalog mit Artikelnummer (SKU), Grundpreis, USt-Satz, Einheit
- Artikel-Positionen automatisch aus Produktwahl übernehmen

#### Mehrbenutzer & Zugriffskontrolle
- 3 Rollen: `admin` (Vollzugriff), `accountant` (Rechnungen/Buchhaltung),
  `viewer` (read-only)
- Benutzer-Einladung per E-Mail (bcrypt-gehashter Token, 1 h Gültigkeit)
- Passwort-Reset (constant-time bcrypt, generische Antworten, keine
  Benutzer-Enumeration)
- Login-Throttler (Anti-Brute-Force), IP-basierte Sperre nach Fehlversuchen
- Alle sensiblen Routen geschützt durch `@Auth()` + `@Require(action)`

#### Produktivität
- Sammel-Download: bis zu 100 Rechnungen als ZIP (PDF oder ZUGFeRD,
  eindeutige Dateinamen, Manifest)
- Sammel-E-Mail-Versand
- CSV-Export nach Zeitraum (18 Spalten, Excel-kompatibel)
- ZIP-Export nach Zeitraum
- Mehrfachauswahl in der Rechnungsliste mit Sammelaktions-Toolbar
- Mahn-Workflow mit Mehrfachversand
- Zahlungsverfolgung mit Auto-Statuswechsel (bezahlt, sobald Summe
  Gesamtsumme deckt)
- **Mehrsprachige Oberfläche: Deutsch, Englisch, Chinesisch** (1 500+ Schlüssel)
- Mehrwährungsfähig (Standard: EUR)

#### Speicher
- Pro Unternehmen lokaler Speicherordner
  (`{Jahr}/{Monat}/{Typ}/{companyId}`)
- Gesundheitsprüfung (erreichbar/beschreibbar/Speicherplatz)
- Dateiliste mit Download/Löschen
- Logo-Upload (Bilddatei pro Unternehmen)

### Schnellstart (Entwicklung)

#### Voraussetzungen
- Node.js 22 LTS
- PostgreSQL 16
- npm 10+

#### 1. Datenbank
```bash
docker run -d --name de-invoice-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=de_invoice \
  -p 5432:5432 postgres:16
```

#### 2. Backend
```bash
cd backend
cp .env.example .env       # DATABASE_URL, JWT_SECRET, SMTP_* anpassen
npm install
npx prisma db push
npx prisma generate
npx ts-node src/main.ts   # → http://localhost:3001
```

#### 3. Frontend
```bash
cd frontend
npm install
npm run dev               # → http://localhost:3000
```

Ersten Benutzer im Browser unter <http://localhost:3000> registrieren
(legt automatisch ein Unternehmen an und vergibt die Admin-Rolle), dann
loslegen.

### API-Konventionen

Alle Dashboard-Routen benötigen diese zwei Header:
```
x-user-id:    <uuid>
x-company-id: <uuid>
```
Der Frontend-Helper `@/lib/api` fügt sie automatisch aus `localStorage` ein —
niemals direktes `fetch()` für API-Aufrufe verwenden.

### Entwicklerhinweise
Siehe **`backend/AGENTS.md`** für projektspezifische Stolperfallen
(PDF-Layout-Invarianten, Throttler-Pitfall, Frontend-Auth-Header).

### CI/CD
Jeder `push` auf `main` (und jeder PR) durchläuft
**`.github/workflows/ci.yml`**:
1. **Backend typecheck** — `tsc --noEmit` auf dem NestJS-Server
2. **Frontend typecheck** — `tsc --noEmit` auf dem Next.js-Client
3. **E2E** — PostgreSQL als Service, `prisma db push`,
   Backend starten, alle 43 e2e-Tests durchlaufen
   (`for f in backend/e2e/[0-9]*.sh; do bash "$f"; done`),
   Playwright UI-Tests (`cd frontend && npx playwright test`)

Fehlgeschlagene CI blockiert Merges (Branch-Protection aktivieren).

### Backup
Siehe **`DEPLOY.md`** für die Produktions-Anleitung.
Kurzfassung:
- **`scripts/backup.sh`** — `pg_dump` + `tar` der Belege,
  Rotation: 7 Tage / 4 Wochen / Monatsanker
- **`scripts/restore.sh`** — Wiederherstellung mit Bestätigung
- **`scripts/com.de-invoice.backup.plist`** — macOS launchd
  (täglich 03:17 Uhr, `~/Library/LaunchAgents/` ablegen + laden)

### Lizenz
Proprietär — für den internen Gebrauch von SH Leder GmbH.

---

<a id="english"></a>

## 🇬🇧 English

A web application for German small/medium businesses to issue, send, and
account invoices in full compliance with **GoBD**, **XRechnung**, and
**ZUGFeRD/Factur-X** standards. Built for SH Leder GmbH (and any similar
B2B invoicing use-case in the DACH region).

### Features

#### Core invoicing
- Standard invoice (INV), credit note (CN), proforma (PI), and receipt (RCV)
- Multi-line items with German VAT rates (0%, 7%, 19%)
- Discounts, payment terms (Net 0/14/30/60), bank info on PDF
- Auto-generated sequential invoice numbers per company
- Number formats: `INV-2026-000001`, `CN-2026-000001`, etc.
- Status workflow: draft → sent → paid / overdue / cancelled
- GoBD-compliant 1-page PDF (no colored fills, thin black lines, German
  number/date format `€ 1.234,56` / `dd.mm.yyyy`)

#### Compliance & e-invoicing
- **XRechnung** (XML, UBL 2.1) — required for federal B2G invoicing
- **ZUGFeRD 2.1 / Factur-X 2.1** — hybrid PDF + embedded XML for B2B
- UStVA (Umsatzsteuervoranmeldung) declaration with full Kennzahlen
  (lines 20-23 sales, 26-29 exempt, 36 reverse charge, 50-66 input tax,
  81 Differenzbetrag)
- **SEPA pain.001** (bulk credit transfer, ISO 20022) — bundles
  open payables into a single XML for the house bank
- **SEPA pain.008** (direct debit, ISO 20022) — the
  customer-side counterpart. Per-customer SEPA
  Lastschriftmandat (CORE/B2B), creditor identifier
  (Gläubiger-ID), pre-notification per §2.2 Scheme
  Rulebook, pain.008.001.02 XML with MndtId + DtOfSgntr
  per debit
- Expense tracking with UStVA line assignment
- Audit log

#### Customer & product management
- Customer CRUD with VAT ID, free-text country, German address format
- CSV import/export (RFC 4180 + UTF-8 BOM for Excel)
- Per-customer last-invoice date + total invoice count (efficient groupBy)
- Product catalog with SKU, base price, VAT rate, unit
- Auto-fill invoice items from product selection

#### Multi-user & access control
- 3 roles: `admin` (full access), `accountant` (invoicing/bookkeeping),
  `viewer` (read-only)
- User invitation via email (bcrypt-hashed token, 1h expiry)
- Password reset flow (constant-time bcrypt, generic responses, no user
  enumeration)
- Login throttler (anti-brute-force), per-IP failed-attempt lockout
- All sensitive routes guarded by `@Auth()` + `@Require(action)` decorators

#### Productivity
- Bulk invoice download — up to 100 invoices bundled as ZIP
  (PDF or ZUGFeRD format, deduplicated filenames, manifest)
- Bulk invoice email sending
- Date-range CSV export (18 columns, Excel compatible)
- Date-range ZIP export
- Multi-select invoice list with bulk-action toolbar
- Reminder / dunning workflow with multi-send
- Payment tracking with auto-status transition (paid when sum covers total)
- **Trilingual UI: German, English, Chinese** (1,500+ keys)
- Multi-currency ready (defaults to EUR)

#### Storage
- Per-company local storage folder (`{year}/{month}/{type}/{companyId}`)
- Health check (reachable/writable/free space)
- File list with download/delete
- Logo upload (image per company)

### Quick Start (Development)

#### Prerequisites
- Node.js 22 LTS
- PostgreSQL 16
- npm 10+

#### 1. Database
```bash
docker run -d --name de-invoice-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=de_invoice \
  -p 5432:5432 postgres:16
```

#### 2. Backend
```bash
cd backend
cp .env.example .env       # adjust DATABASE_URL, JWT_SECRET, SMTP_*
npm install
npx prisma db push
npx prisma generate
npx ts-node src/main.ts   # → http://localhost:3001
```

#### 3. Frontend
```bash
cd frontend
npm install
npm run dev               # → http://localhost:3000
```

Open <http://localhost:3000>, register the first user (which auto-creates a
company and assigns you admin role), and start invoicing.

### API Conventions

All dashboard routes require these two headers:
```
x-user-id:    <uuid>
x-company-id: <uuid>
```
The frontend helper `@/lib/api` injects them automatically from
`localStorage` — never use raw `fetch()` for API calls.

### Development Notes
See **`backend/AGENTS.md`** for project-specific gotchas
(PDF layout invariants, throttler pitfall, frontend auth headers).

### License
Proprietary — built for SH Leder GmbH internal use.

---

<a id="中文"></a>

## 🇨🇳 中文

为德国中小企业打造的发票与会计管理系统,完全符合 **GoBD**、**XRechnung** 和
**ZUGFeRD/Factur-X** 标准。为 SH Leder GmbH 开发(同样适用于德语区 B2B
开票场景)。

### 功能特性

#### 核心开票
- 发票类型:普通发票 (INV)、贷项凭证 (CN)、形式发票 (PI)、收据 (RCV)
- 多行项目,支持德国增值税税率(0%、7%、19%)
- 支持折扣、付款条件(立即/14/30/60天)、PDF 上展示银行信息
- 每个公司独立的连续发票编号
- 编号格式:`RE-2026-000001`、`GS-2026-000001` 等
- 状态流转:草稿 → 已发送 → 已付款 / 逾期 / 已作废
- GoBD 合规的单页 PDF(无彩色填充、黑色细线、
  德式数字/日期格式 `€ 1.234,56` / `dd.mm.yyyy`)

#### 合规与电子发票
- **XRechnung**(XML, UBL 2.1)— 联邦 B2G 必选
- **ZUGFeRD 2.1 / Factur-X 2.1** — B2B 混合 PDF + 嵌入 XML
- **UStVA**(增值税预申报)含完整 Kennzahlen
  (20–23 行销售额、26–29 行免税、36 行反向征收、
  50–66 行进项税、81 行差额)
- **SEPA pain.001** (批量付款转账, ISO 20022) — 将待付
  费用打包成一份 XML,提交给开户行
- **SEPA pain.008** (直接借记, ISO 20022) — 客户侧的
  对应功能。每个客户一份 SEPA Lastschriftmandat
  (CORE/B2B), 债权人识别号, 按 §2.2 规则进行
  提前通知, 导出 pain.008.001.02 XML
- 费用管理,可对应到 UStVA 行
- 审计日志

#### 客户与产品管理
- 客户增删改查,含增值税 ID、自由国家文本、德式地址格式
- CSV 导入/导出(RFC 4180 + UTF-8 BOM,Excel 兼容)
- 每客户最近开票日期 + 累计开票数量(高效 groupBy)
- 产品目录含 SKU、基础价、税率、单位
- 选择产品后自动填充发票项目

#### 多用户与权限控制
- 3 种角色:`admin`(完全权限)、`accountant`(开票/记账)、
  `viewer`(只读)
- 邮件邀请用户(bcrypt 哈希 token,1 小时过期)
- 密码重置(恒定时间 bcrypt、通用响应、避免用户枚举)
- 登录限流(防暴力破解),按 IP 失败次数锁定
- 所有敏感路由通过 `@Auth()` + `@Require(action)` 装饰器保护

#### 效率工具
- 批量下载:最多 100 张发票打包为 ZIP
  (PDF 或 ZUGFeRD,文件名去重,带清单)
- 批量邮件发送
- 按时间区间 CSV 导出(18 列,Excel 兼容)
- 按时间区间 ZIP 导出
- 发票列表多选 + 批量操作工具栏
- 催收/逾期提醒工作流,支持多次发送
- 付款跟踪,自动状态切换(收款金额覆盖总额后自动置为已付)
- **三语界面:德语 / 英语 / 中文**(1500+ 翻译键)
- 多币种就绪(默认 EUR)

#### 存储
- 每个公司独立的本地存储目录(`{年}/{月}/{类型}/{公司ID}`)
- 健康检查(可达 / 可写 / 剩余空间)
- 文件列表(下载 / 删除)
- Logo 上传(每个公司一张图)

### 快速开始(开发环境)

#### 环境要求
- Node.js 22 LTS
- PostgreSQL 16
- npm 10+

#### 1. 数据库
```bash
docker run -d --name de-invoice-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=de_invoice \
  -p 5432:5432 postgres:16
```

#### 2. 后端
```bash
cd backend
cp .env.example .env       # 修改 DATABASE_URL, JWT_SECRET, SMTP_*
npm install
npx prisma db push
npx prisma generate
npx ts-node src/main.ts   # → http://localhost:3001
```

#### 3. 前端
```bash
cd frontend
npm install
npm run dev               # → http://localhost:3000
```

浏览器打开 <http://localhost:3000>,注册第一个用户(自动创建公司并授予
admin 角色),即可开始开票。

### API 约定

所有 Dashboard 路由需要以下两个请求头:
```
x-user-id:    <uuid>
x-company-id: <uuid>
```
前端辅助函数 `@/lib/api` 会从 `localStorage` 自动注入 — 切勿直接使用
`fetch()` 调 API。

### 开发提示
项目特有的"坑"请参考 **`backend/AGENTS.md`**
(PDF 布局约束、限流器陷阱、前端鉴权头)。

### 许可证
专有软件 — 仅供 SH Leder GmbH 内部使用。

---

## Tech Stack / 技术栈

| Layer / 层 | Technology / 技术 |
|------------|-------------------|
| Frontend / 前端 | Next.js 16, React 19, TypeScript, Tailwind CSS |
| Backend / 后端 | Node.js 22 LTS, NestJS 10, TypeScript |
| Database / 数据库 | PostgreSQL 16 (Prisma ORM 5) |
| PDF | PDFKit (1-page ink-saving layout) |
| E-Invoice / 电子发票 | Custom XRechnung (UBL 2.1) + ZUGFeRD 2.1 / Factur-X 2.1 generators |
| Email / 邮件 | Nodemailer (SMTP), per-company config |
| Storage / 存储 | Local filesystem (S3/MinIO planned) |
| Auth / 鉴权 | Custom header-based shim + RBAC roles |
| Security headers / 安全头 | Helmet 7.x (HSTS, X-Frame-Options, X-Content-Type-Options) |
| i18n / 国际化 | Flat JSON keys, 3 locales (DE/EN/ZH), 2512 keys × 3 = 7536 translations |
| E2E tests / 端到端测试 | 136 backend bash scripts + 307 Playwright UI tests (77 spec files) |

## Repository Layout / 仓库结构

```
de-invoice/
├── backend/                      # NestJS API
│   ├── prisma/schema.prisma      # DB schema (Company, User, Customer, Invoice, ...)
│   ├── src/
│   │   ├── auth/                 # HeaderAuthGuard, RolesGuard, decorators
│   │   ├── modules/              # customer, invoice, product, accounting, ...
│   │   ├── invoices/             # PDF + XRechnung + ZUGFeRD generators
│   │   └── prisma/               # PrismaService
│   ├── AGENTS.md                 # Project memory (PDF rules, throttler pitfall, etc.)
│   └── package.json
├── frontend/                     # Next.js dashboard
│   ├── messages/{de,en,zh}.json  # i18n message catalogs
│   ├── src/
│   │   ├── app/dashboard/        # pages: invoices, customers, products, accounting, ...
│   │   ├── components/           # shared UI: ExportCSVButton, RevenueChart, ...
│   │   └── lib/api.ts            # apiFetch / apiGet / apiPost / apiPut / apiDelete
│   └── package.json
└── README.md                     # this file / 本文件 / diese Datei
```
