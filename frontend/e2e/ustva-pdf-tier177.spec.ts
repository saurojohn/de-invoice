/**
 * Tier 177 — GET /api/v1/ustva/ustva.pdf
 *
 * Phase 3 Berater-Walkthrough found that USER-GUIDE
 * Pfad 4.2 promised a "UStVA-PDF" download but no
 * such endpoint existed — the only UStVA export was
 * the ELSTER-XML via /ustva/filings/:id/elster-xml.
 * This tier closes that gap with a Berater-readable
 * A4-portrait single-page summary PDF.
 *
 * month is REQUIRED (Zahllast is per-month, not per-year).
 * A user who wants "UStVA for Q3" fetches the 3 monthly
 * PDFs. The PDF is a companion to ELSTER-XML, not a
 * replacement.
 *
 * Tests:
 *   1. Unauthenticated request → 401
 *   2. Missing companyId → 400
 *   3. Missing month → 400 (Zahllast is per-month)
 *   4. month out of range (13) → 400
 *   5. year out of range → 400
 *   6. Happy path: 200 + application/pdf + PDF magic bytes
 *      + non-empty body + Content-Disposition attachment
 *   7. PDF body content sanity: A4 portrait (595×842 pt
 *      MediaBox) + FlateDecode content stream
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
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

test.describe("Tier 177 — GET /api/v1/ustva/ustva.pdf", () => {
  test("1. unauthenticated request: missing headers → 401", async ({ request }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/ustva/ustva.pdf?year=2026&month=7&companyId=anything",
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })

  test("2. missing companyId → 400", async ({ request }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/ustva/ustva.pdf?year=2026&month=7",
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected companyId error, got: ${body}`).toMatch(/companyId/i)
  })

  test("3. missing month → 400 (Zahllast is per-month)", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustva.pdf?year=2026&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    // The controller's error message must explain the
    // per-month requirement, not just say "month missing".
    expect(body, `expected per-month explanation, got: ${body}`).toMatch(/monat/i)
  })

  test("4. month out of range (13) → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustva.pdf?year=2026&month=13&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("5. year out of range (1900) → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustva.pdf?year=1900&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("6. happy path: 200 + application/pdf + PDF magic bytes + Content-Disposition", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustva.pdf?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    expect(res.headers()["content-type"], "content-type should be application/pdf").toMatch(
      /application\/pdf/,
    )
    // The filename in Content-Disposition should encode
    // year + month for the Berater's archive naming.
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition, `Content-Disposition should be attachment, got: ${disposition}`).toMatch(
      /attachment/,
    )
    expect(disposition, `filename should encode year+month, got: ${disposition}`).toMatch(
      /UStVA-2026-07/,
    )

    const body = await res.body()
    // PDF magic bytes "%PDF-1.x" (4 ASCII bytes)
    expect(body.length, `expected non-empty body, got ${body.length} bytes`).toBeGreaterThan(500)
    expect(body.slice(0, 4).toString("latin1"), "PDF should start with %PDF magic").toBe("%PDF")
    // The PDF version is in byte 5-7, e.g. "-1.3" / "-1.4" / "-1.7"
    expect(body.slice(5, 8).toString("latin1"), "PDF version should be 1.x").toMatch(/1\./)
  })

  test("7. PDF body: A4 portrait MediaBox + FlateDecode content stream", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/ustva/ustva.pdf?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status()).toBe(200)
    const body = await res.body()
    const ascii = body.toString("latin1")
    // A4 portrait: 595.28 x 841.89 points
    expect(ascii, "A4 portrait MediaBox expected").toMatch(/MediaBox\s*\[\s*0\s+0\s+595/)
    expect(ascii, "A4 height 841.89 expected").toMatch(/841\.89/)
    // Content should be Flate-compressed (PDFKit default
    // for text content)
    expect(ascii, "FlateDecode filter expected").toMatch(/FlateDecode/)
  })
})
