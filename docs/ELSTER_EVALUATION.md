# ELSTER Integration Evaluation (Tier 13.4.2)

> **Status:** Research/decision document, not code.
> **Author:** Tier 13 evaluation.
> **Date:** 2026-06-25.

## TL;DR

The UStVA XML **generator** is already done (`elster.service.ts`,
UStVA 2026 schema, ERiC-compatible). What's missing is the
**submission** path. We have two options:

| Option | Effort | Cost/mo | When to pick |
|---|---|---|---|
| **A. Self-host ERiC C library** | 1-2 weeks dev + ongoing | €0 | SH Leder wants 100% control / no per-form fee |
| **B. Outsource to sevDesk / lexoffice** | 1 day (just data export) | €0-30/user | SH Leder is OK paying €0-30/mo for the convenience |

**Recommendation: B for now, A in 6 months if/when the
per-user cost adds up.** The UStVA XML export endpoint
already exists; a Steuerberater can use it today to file
in Mein ELSTER manually. Adding automated submission
without the right volume is premature engineering.

## What already exists

Verified by reading `backend/src/modules/reports/`:

- `ustva.service.ts` — `compute(companyId, year, quarter?, month?)`
  produces `UstvaData` (Bemessungsgrundlagen, Vorsteuer, Zahllast)
  from the actual Expense / Invoice / CashBook tables.
- `ustva.controller.ts` — `GET /api/v1/ustva/compute`,
  `POST/GET /api/v1/ustva/filings`, and
  `GET /api/v1/ustva/filings/:id/elster-xml` (the export).
- `elster.service.ts` — full XML generator for **UStVA 2026**
  (BMF Anlage). Produces ERiC-compatible `Datenlieferung`
  packets. Supports all 12 Kz fields (20-23, 26-29, 36, 41,
  43, 44, 50-66, 81) with proper 13-digit BMF encoding.
- e2e tests for UStVA computation exist (e2e 21-system-errors
  touches it; the elster-xml endpoint is exercised in
  smoke flows but doesn't have its own e2e file — **add
  e2e 49 for ELSTER XML contract** as a quick win).

The XML produced is **ready for Mein ELSTER upload**. The
Steuerberater can:

  1. GET `/api/v1/ustva/filings/:id/elster-xml`
  2. Open `https://www.elster.de/eportal/start` → "Upload"
  3. Drag-drop the XML file
  4. Sign with ElsterSecure / Zertifikatsdatei
  5. Submit

This is the **current production path**. It works. The
question is whether to automate steps 1-5.

## Option A: Self-host ERiC (libreicapi)

### What ERiC is

ERiC = **E**lektronische **R**echtsverkehrs-**I**nformation
**C**lient. It's the **official** library published by the
Bayerisches Landesamt für Steuern (BayLfSt) for talking to
the ELSTER servers. It handles:

  - The full FinTS-style transport (technically
    HTTPS + SOAP under the hood, not FinTS)
  - Digital signatures (ElsterSecure, Zertifikatsdatei
    .pfx, soft-PSE)
  - Server-side validation (the ELSTER server checks
    the XML schema BEFORE accepting)
  - Return-code mapping (30200 = success, 4xxxx = data
    errors, 9xxxx = transport errors)

### The dev path

  1. **License**: ERiC is **free for German tax advisors
     and taxpayers**. Source is available on request from
     BayLfSt. We'd need to sign a license agreement.
  2. **Dependencies**: ERiC is a **C** library
     (`libericapi.so` on Linux, `libericapi.dylib` on macOS,
     `ericapi.dll` on Windows). The Node binding is via
     `node-eric` (a community binding) or a custom
     `ffi-napi` wrapper. Both are unmaintained.
  3. **Build**: `libreicapi` needs a recent OpenSSL +
     a small set of Linux system libs. We've already
     paid this cost for the Postgres binary engine
     (Tier 11), so adding another shared lib to the
     image is minor.
  4. **Signature flow**:
     - User generates or uploads a `.pfx` (Zertifikatsdatei)
     - The PIN is entered client-side
     - ERiC signs the XML with the user's soft-PSE
     - POST to ELSTER servers
     - Poll for return code (30200 = OK, 4xxxx = data err)
  5. **State machine**:
     - `draft` → `signed` → `submitted` → `accepted` /
       `rejected`
     - On `rejected`, the response includes the field
       that was wrong; show the user a "fix this field
       and re-submit" UI
  6. **Volume**: ERiC is rate-limited (~10 submissions /
     connection / 24h). For SH Leder doing 1 UStVA/month
     + 1 LStJA/year + maybe 4 ZM/year, well under.
  7. **Maintenance burden**: the ELSTER server-side
     schema changes ~1x/year (the Anlage UStVA version
     is tied to the calendar year). We have to update
     elster.service.ts each year. This is a 1-day task
     but it does recur.

### Cost

  - **Dev**: 1-2 weeks for the first integration. Mostly
    fighting the C FFI layer.
  - **Runtime**: €0 (no per-form fee; ERiC itself is free)
  - **Maintenance**: ~0.5 day/year for schema update.

## Option B: Outsource (sevDesk / lexoffice / Datev)

### The ecosystem

The German accounting SaaS market has converged around 3
incumbents for "UStVA file this for me":

  - **sevDesk** (https://sevdesk.de) — €0-30/user/mo, has
    a public API. UStVA submission included in all paid
    plans. Used by 50k+ German SMBs.
  - **lexoffice** (https://lexoffice.de) — owned by Haufe,
    €0-30/user/mo. UStVA submission is one of their
    headline features.
  - **Datev** (https://datev.de) — the accountant's tool.
    SH Leder's Steuerberater almost certainly uses Datev
    already. Datev has an API ("Datev-API" / "DATEVconnect")
    but it requires certified Datev-partner status and
    is harder to integrate with.

### How it would work for SH Leder

Two paths:

  - **B1: Steuerberater handles it.** The XML export we
    already have goes to the Steuerberater's Datev
    instance via email or shared folder. The
    Steuerberater signs and files. **Cost: €0** (already
    paying the Steuerberater). **Dev: 0 days.**
  - **B2: sevDesk/lexoffice API.** Export our UstvaData
    as JSON, POST to sevDesk, sevDesk does the filing.
    **Cost: ~€30/mo for 1 user.** **Dev: 1-2 days.**

### When B2 beats A

  - SH Leder's Steuerberater retires / quits
  - SH Leder's UStVA cadence goes monthly → daily
    (e.g. adding innergemeinschaftliche Lieferungen that
    require summary reports / ZM)
  - The ELSTER API changes in a way that requires
    ERiC upgrade within 24h
  - Compliance: a 3rd-party signatory reduces SH Leder's
    audit risk

## Recommendation

**Adopt B1 (Steuerberater files via Datev from our XML)
now. Re-evaluate A vs B2 in 6 months if/when volume
grows.**

Why B1 first:

  1. The UStVA XML endpoint already exists; nothing
     needs to be built.
  2. The Steuerberater is already a trusted party in
     the UStVA loop. They're doing the signing anyway.
  3. Until we have **multiple customers** (not just
     SH Leder GmbH), building a per-customer
     UStVA-submission flow is over-engineering.
  4. If the Steuerberater quits, B2 is a 2-day
     integration; A is a 1-2 week one. We can defer
     that decision.

## What to do today

  1. ✅ Already done: UStVA compute + XML export
  2. ✅ Already done: e2e tests for UStVA
  3. **TODO (this PR)**: e2e 49 for the XML contract
     — verify the XML output against the BMF schema,
     ensure all required fields are present, ensure
     numeric encoding is 13-digit BMF format. **Cheap,
     high value**: catches schema regressions.
  4. **TODO (deferred)**: ERiC integration (option A)
  5. **TODO (deferred)**: sevDesk / lexoffice
     integration (option B2)
  6. **TODO (deferred)**: add a "Send to Datev" button
     in the UI that emails the XML to the configured
     Steuerberater address. **Cheap, useful.**

## Quick win: e2e 49 (ELSTER XML contract)

```bash
# Pseudocode for the test
RESPONSE=$(curl $HOST/api/v1/ustva/filings/$FILING_ID/elster-xml?companyId=$COMPANY)
# 1. Content-Type is application/xml
# 2. Root element is <Datenlieferung>
# 3. <Vorgang> has <Vorgang>1</Vorgang> (or higher)
# 4. <Nutzdatenblock> contains <Umsatzsteuervoranmeldung>
# 5. <Umsatzsteuervoranmeldung> has <Steuernummer> matching
#    the company's tax number (normalized to 13 digits)
# 6. <DatenLieferant>1</DatenLieferant> (we always send
#    from the taxpayer, not the Steuerberater)
# 7. <Erstellungsdatum> matches the filing date
# 8. Each <Einzelwert> has the BMF "B"-prefix format
#    (e.g. "B 1234567890123")
# 9. <Summe> = sum of Einzelwerte (the controller
#    should compute this, not us)
# 10. <Kz81> is present (the Verbleibender Betrag)
```

We can run this against the **mock** UstvaData
(no real ELSTER submission needed) — it just verifies
our XML is well-formed and matches the BMF schema.

## Appendix: alternative library comparison

| Library | Lang | License | Maintained | Notes |
|---|---|---|---|---|
| `libericapi` (official) | C | Free for taxpayers | ✅ by BayLfSt | What we should use. Needs a wrapper. |
| `node-eric` (community) | Node | MIT | ❌ last commit 2018 | Would need to fork. |
| `erica` (open-source) | Python | AGPL | ✅ by erica-team | Not directly usable from Node. |
| `sevdesk-sdk` | Node | Apache | ✅ | Commercial API, not direct ELSTER. |
| `lexoffice` (API) | REST | Proprietary | ✅ | Commercial API, not direct ELSTER. |

**Bottom line**: there's no well-maintained Node
binding for the official ERiC library. If we go with
option A, we'd write a small `ffi-napi` wrapper around
`libericapi`, OR use a subprocess-based approach
(ERiC ships with a CLI tool that takes an XML file
and outputs the server response — we wrap that in a
Node child_process call). The CLI approach is
slower but trivially correct.

## References

  - ERiC docs: https://www.elster.de/elsterweb/infoseite/eric
  - UStVA 2026 Anlage: https://www.bundesfinanzministerium.de
  - BMF ERiC schema: ERiC_Anwenderhandbuch_2026.pdf
  - sevDesk API: https://developer.sevdesk.de
  - lexoffice API: https://developers.lexoffice.io
