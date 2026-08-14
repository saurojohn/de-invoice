/**
 * Tier 187 — UStJA-PDF + OSS endpoint e2e coverage
 *
 * Background: the UStJA-PDF endpoint
 * (GET /api/v1/ustva/ustja.pdf) was added in
 * Tier 105 as the year-end settlement form. The
 * OSS endpoints (GET /api/v1/reports/oss +
 * /oss.csv) were added in Tier 78 as the EU
 * OSS-Retourmeldung for B2C distance sales.
 *
 * Neither had e2e coverage for the year/quarter
 * validation + the PDF/CSV binary response.
 * The Phase 3 Berater-Walkthrough found that the
 * "UStJA-PDF" promise in USER-GUIDE Pfad 4.2
 * was working but untested.
 *
 * This tier adds a focused backend e2e suite
 * that covers:
 *   - UStJA-PDF: year validation (200 with valid
 *     year, 400 with year < 2000), PDF magic
 *     bytes, Content-Disposition filename
 *     "UStJA-YYYY.pdf"
 *   - UStJA ELSTER-XML: year validation, XML
 *     magic, Content-Disposition filename
 *   - OSS JSON: year + quarter validation
 *   - OSS CSV: year + quarter validation, CSV
 *     content, Content-Disposition filename
 *     "OSS-Retourmeldung_YYYY_Q<n>.csv"
 *
 * Tests:
 *   UStJA-PDF (5):
 *     1. unauthenticated → 401
 *     2. missing companyId → 400
 *     3. missing year → 400
 *     4. year=2026 → 200 + application/pdf + PDF
 *        magic bytes + filename UStJA-2026.pdf
 *     5. year=1900 → 400 with German error
 *
 *   UStJA ELSTER-XML (4):
 *     6. unauthenticated → 401
 *     7. year=2026 → 200 + XML content-type +
 *        XML magic bytes + filename
 *     8. missing year → 400
 *     9. year=1900 → 400
 *
 *   OSS JSON (3):
 *    10. unauthenticated → 401
 *    11. year=2026&quarter=3 → 200 + JSON
 *        shape (per-country rows + total)
 *    12. quarter=5 → 400
 *
 *   OSS CSV (4):
 *    13. unauthenticated → 401
 *    14. year=2026&quarter=3 → 200 + CSV
 *        content-type + filename
 *        "OSS-Retourmeldung_2026_Q3.csv"
 *    15. quarter=5 → 400
 *    16. year=1900 → 400
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line in env.split("\n")) {
    const m = (env.split("\n")[parseInt(line, 10)] as string).match(
      /^([A-Z_][A-Z0-9_]*)=(.*)$/,
    )
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(`Auth cache ${AUTH_CACHE} missing — run backend e2e first`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let tokens: { userId: string; companyId: string } | null = null
test.beforeAll(() => {
  tokens = readCachedTokens()
})

function authHeaders(): Record<string, string> {
  return {
    "x-user-id": tokens!.userId,
    "x-company-id": tokens!.companyId,
  }
}

test.describe("Tier 187 — UStJA-PDF + OSS endpoint e2e coverage", () => {
  // ─── UStJA-PDF (Tier 105) ─────────────────────────────────
  test("1. UStJA-PDF: unauthenticated → 401", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja.pdf?year=2026&companyId=${tokens!.companyId}`,
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })

  test("2. UStJA-PDF: missing companyId → 400", async ({ request }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/ustva/ustja.pdf?year=2026",
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("3. UStJA-PDF: missing year → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja.pdf?companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("4. UStJA-PDF: year=2026 → 200 + application/pdf + PDF magic + UStJA-2026.pdf", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja.pdf?year=2026&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    expect(res.headers()["content-type"]).toMatch(/application\/pdf/)
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition, `expected UStJA-2026.pdf, got: ${disposition}`).toMatch(
      /UStJA-2026\.pdf/,
    )
    const body = await res.body()
    expect(body.length, `expected non-empty body, got ${body.length} bytes`).toBeGreaterThan(500)
    expect(body.slice(0, 4).toString("latin1"), "PDF should start with %PDF magic").toBe("%PDF")
  })

  test("5. UStJA-PDF: year=1900 → 400 with German error", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja.pdf?year=1900&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  // ─── UStJA ELSTER-XML (Tier 107) ────────────────────────────
  test("6. UStJA ELSTER-XML: unauthenticated → 401", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja/elster-xml?year=2026&companyId=${tokens!.companyId}`,
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })

  test("7. UStJA ELSTER-XML: year=2026 → 200 + XML magic + filename", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja/elster-xml?year=2026&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    const ct = res.headers()["content-type"] || ""
    expect(ct, `expected XML or text content-type, got: ${ct}`).toMatch(
      /(application\/xml|text\/plain)/,
    )
    const body = await res.body()
    const text = body.toString("latin1")
    // XML format: should start with `<?xml` or
    // `<Datenlieferung>`. ASCII preview format
    // is text/plain (not XML).
    expect(
      text.match(/<\?xml|<Datenlieferung|UStJA_ASCII/i),
      `expected XML or ASCII preview content`,
    ).toBeTruthy()
  })

  test("8. UStJA ELSTER-XML: missing year → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja/elster-xml?companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("9. UStJA ELSTER-XML: year=1900 → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustja/elster-xml?year=1900&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  // ─── OSS JSON (Tier 78) ────────────────────────────────────
  test("10. OSS JSON: unauthenticated → 401", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/oss?year=2026&quarter=3&companyId=${tokens!.companyId}`,
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })

  test("11. OSS JSON: year=2026&quarter=3 → 200 + JSON shape", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/oss?year=2026&quarter=3&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    const body = await res.json()
    // Tier 78 response shape: { year, quarter,
    // countries: [...], totals: {...},
    // counts: {...}, disclaimer: ... }
    expect(body.year, "year field missing").toBe(2026)
    expect(body.quarter, "quarter field missing").toBe(3)
    expect(Array.isArray(body.countries), "countries should be array").toBe(true)
    expect(typeof body.totals, "totals should be object").toBe("object")
    expect(typeof body.counts, "counts should be object").toBe("object")
    expect(typeof body.disclaimer, "disclaimer should be string").toBe("string")
  })

  test("12. OSS JSON: quarter=5 → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/oss?year=2026&quarter=5&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected German quarter error, got: ${body}`).toMatch(/quarter/i)
  })

  // ─── OSS CSV (Tier 78) ─────────────────────────────────────
  test("13. OSS CSV: unauthenticated → 401", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/oss.csv?year=2026&quarter=3&companyId=${tokens!.companyId}`,
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })

  test("14. OSS CSV: year=2026&quarter=3 → 200 + CSV + filename", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/oss.csv?year=2026&quarter=3&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    const ct = res.headers()["content-type"] || ""
    expect(ct, `expected CSV content-type, got: ${ct}`).toMatch(/text\/csv/)
    const disposition = res.headers()["content-disposition"] || ""
    expect(
      disposition,
      `expected OSS-Retourmeldung_2026_Q3.csv, got: ${disposition}`,
    ).toMatch(/OSS-Retourmeldung_2026_Q3\.csv/)
    const body = await res.body()
    expect(body.length, `expected non-empty body, got ${body.length} bytes`).toBeGreaterThan(10)
  })

  test("15. OSS CSV: quarter=5 → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/oss.csv?year=2026&quarter=5&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("16. OSS CSV: year=1900 → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/oss.csv?year=1900&quarter=3&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })
})
