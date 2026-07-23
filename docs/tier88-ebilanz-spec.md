# Tier 88 — E-Bilanz (XBRL) Spec

## Goal

Generate an **E-Bilanz-VORSCHAU** in the BMF `eBilanz-in-xtml` format. The
output is a structurally-valid XBRL XML file that the Berater can review
locally + (after manual touch-up) upload to ELSTER. Like all our other
"Steuererklärung" tiers, this is a **VORSCHAU** — the Berater/ELSTER
client is the source of truth for actual submission.

## Background

The BMF eBilanz format is based on XBRL (eXtensible Business Reporting
Language). Each annual financial statement is encoded as an XML document
that references the BMF taxonomy (currently 6.7 for 2026). The structure
has three main parts:

```
<xbrl xmlns="http://www.xbrl.org/2003/instance"
      xmlns:de-gcd="http://www.xbrl.org/taxonomy/de/gcd/...">
  <link:schemaRef xlink:type="simple" xlink:href="..."/>
  <context id="...">...</context>
  <unit id="EUR">...</unit>
  <de-gcd:bs.ass.currAssets.cashAndCashEquivalents contextRef="..." unitRef="EUR" decimals="2">12345.67</de-gcd:bs.ass.currAssets.cashAndCashEquivalents>
  ...
</xbrl>
```

A real BMF eBilanz requires (1) the BMF taxonomy XSD reference, (2) all
mandatory contexts, (3) all required GCD positions, (4) PDF attachments
for Anhang / Lagebericht.

## v1 scope (Tier 88)

**What we ship:**
- A `EBilanzService` that generates a **valid eBilanz-in-xtml XML
  document** for the year, drawing from:
  - Company (Stammdaten: Name, Sitz, Steuernummer, USt-IdNr, Handelsregister)
  - BilanzService (Bilanz position sums)
  - GuVService (G+V position sums)
  - AnhangService (Anhang sections — included as <de-gcd:...> narrative
    placeholder, since XBRL is for numbers, not free text)
  - Anlagenverzeichnis (Buchwert + annual AfA per asset)
- A `EBilanzController` with two routes:
  - `GET /api/v1/accounting/ebilanz?year=YYYY&companyId=...` → JSON shape
    (preview the mapping + amounts)
  - `GET /api/v1/accounting/ebilanz.xml?year=YYYY&companyId=...` → the
    XML file (Content-Type: application/xml, attachment filename)
  - `GET /api/v1/accounting/ebilanz.pdf?year=YYYY&companyId=...` → the
    human-readable PDF (reuses the existing Anhang / G+V / Bilanz
    renderers — same pattern as Berater-Packager tier 85)
- A frontend `EBilanzTab` on `/dashboard/accounting` with year picker,
  3 download buttons (XML / PDF / VORSCHAU preview), and a position-
  count summary ("32 von 84 Pflichtpositionen berechnet").

**v1 simplifications (acceptable for VORSCHAU):**
- We don't download the BMF taxonomy XSD — we reference the
  `http://www.xbrl.org/taxonomy/de/gcd/...` namespace declaratively,
  and let the Berater/ELSTER client validate the full schema on
  their side. (Same VORSCHAU honesty pattern as tier 81 Bilanz
  "nicht ausgewiesen".)
- We don't write to the Anhang positions in XBRL (Anhang is
  narrative + non-numeric in XBRL; we include it as a comment
  block in the XML, and the Berater attaches the human-readable
  PDF as the Anhang when uploading).
- Pflichtpositionen that we don't compute (e.g. Eigenkapital-
  saldoposten, Steuerrückstellungen, RAP, Sonderposten) are
  emitted as `<de-gcd:... contextRef="..." unitRef="EUR"
  decimals="2">` with no value (or commented placeholder).
  The Berater fills these in their ELSTER client.
- Only 4-digit taxonomy IDs from GCD (General Commercial
  Domain). No Microsig taxonomy. No Bilanz für kleine Personen-
  gesellschaften (PK) — that's v2.

## Mapping table (v1)

The mapping is the heart of eBilanz. v1 covers the 30+ positions
we already compute in tiers 81-85. The rest are placeholders for
the Berater.

| BMF taxonomy element (gcd-gen) | Tier 81-85 source |
|---|---|
| Bilanz Aktiva | |
| `de-gcd:bs.ass.fixAss.tangAss.othTangAss` | Asset pool, default 0400 |
| `de-gcd:bs.ass.fixAss.tangAss.propAndBuild` | Asset pool, 0200 |
| `de-gcd:bs.ass.fixAss.intangAss` | Asset pool, 0100 |
| `de-gcd:bs.ass.currAssets.tradeReceivables` | Bilanz 1500 (open invoices) |
| `de-gcd:bs.ass.currAssets.cashAndCashEquivalents` | Bilanz 1600+1700 (cash book) |
| Bilanz Passiva | |
| `de-gcd:bs.liab.cred.tradeLiabilities` | Bilanz 4000 (open expenses) |
| `de-gcd:bs.liab.deferredTax` | Bilanz 4500 (customer credits) |
| `de-gcd:bs.equity.subscribedCapital` | placeholder — Berater fills |
| `de-gcd:bs.equity.retainedEarnings` | Bilanz Saldoposten |
| G+V (§ 275 HGB GKV) | |
| `de-gcd:is.rev.netSales` | G+V 1 (Umsatzerlöse) |
| `de-gcd:is.rev.othOperRev` | G+V 4 (Sonstige betr. Erträge) |
| `de-gcd:is.exp.costOfMaterials` | G+V 5a (Materialaufwand) |
| `de-gcd:is.exp.employeeBenef` | G+V 6a (Personalaufwand) |
| `de-gcd:is.exp.deprecAndAmort` | G+V 7a (AfA) |
| `de-gcd:is.exp.othOperExp` | G+V 8 (Sonstige betr. Aufw.) |
| `de-gcd:is.fin.inc.fromInterest` | not in v1 (placeholder) |
| `de-gcd:is.fin.exp.fromInterest` | G+V 13 (Zinsaufwendungen) |
| `de-gcd:is.tax.incomeTax` | G+V 14 (Steuern) |
| `de-gcd:is.netIncLoss` | G+V 17 (Jahresüberschuss) |

The Anhang / Lagebericht positions are not in XBRL; they are
attached as a PDF. We provide a comment block in the XML noting
"see Anhang.pdf".

## Files to create

```
backend/src/modules/accounting/ebilanz.service.ts      (~400 lines)
backend/src/modules/accounting/ebilanz.controller.ts   (~80 lines)
backend/src/modules/accounting/ebilanz-mapping.ts     (~200 lines — the mapping table)
backend/src/modules/accounting/ebilanz.types.ts        (~60 lines)
backend/prisma/migrations/...                         (none — no schema change)
backend/e2e/114-tier88-ebilanz.sh                     (~250 lines)
frontend/src/app/dashboard/accounting/EBilanzTab.tsx  (~200 lines)
frontend/src/app/dashboard/accounting/page.tsx        (add tab + nav)
frontend/messages/{de,en,zh}.json                    (ebilanz.* 12 keys × 3)
frontend/e2e/ebilanz.spec.ts                          (~120 lines)
```

## Dependencies

- `xmlbuilder2` (^3.1.0) — XML construction. Add to backend `package.json`.
  No new frontend deps.

## i18n keys (ebilanz.* × DE/EN/ZH)

`title`, `subtitle`, `year`, `downloadXml`, `downloadPdf`,
`vorschau`, `positionCount`, `notComputed`, `mappingTable`,
`xmlError`, `noData`, `disclaimer`, `ready`.

## Tests

**e2e 114:**
1. GET /ebilanz?year=2026 → JSON shape with mapping table summary
2. GET /ebilanz.xml?year=2026 → valid XML, starts with `<?xml`,
   contains `<xbrl`, contains GCD namespace
3. XML well-formed (parse with xmllint or python xml.etree)
4. Contains expected de-gcd positions: netSales, employeeBenef,
   deprecAndAmort, netIncLoss
5. Mapping table row count >= 14 (the v1 cover)
6. Year validation 1999, 2101 → 400
7. Missing companyId → 400
8. Cross-tenant → 401

**Playwright ebilanz.spec.ts:**
1. Tab visible on /dashboard/accounting
2. Year input visible
3. Download XML link uses full backend URL (tier 76 lesson)
4. Download PDF link uses full backend URL
5. Position count summary visible
6. No console errors

## Implementation order

1. Add `xmlbuilder2` to backend package.json
2. Create `ebilanz-mapping.ts` with the 14+ position mapping
3. Create `ebilanz.service.ts` with `compute()` (JSON) + `renderXml()`
   + `renderPdf()` methods
4. Create `ebilanz.controller.ts` with 3 routes (declare literal
   routes BEFORE :id per tier 87 lesson)
5. Wire into AccountingModule
6. Add `EBilanzTab` to /dashboard/accounting
7. Add i18n
8. e2e 114
9. Playwright
10. Commit + push + memory
