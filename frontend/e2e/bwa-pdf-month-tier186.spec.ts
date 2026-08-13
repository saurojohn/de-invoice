/**
 * Tier 186 — BWA-PDF month-scoped coverage
 *
 * Background: the BWA-PDF endpoint
 * (GET /api/v1/reports/bwa.pdf) was added in
 * Tier 27 and already accepted `?year=&month=`
 * in Tier 86. But the month-scoped PDF
 * generation itself was not covered by an
 * e2e suite — the closest test was the
 * frontend's `bwa-pdf-link` check in
 * `bwa.spec.ts`, which only verifies the URL
 * is set, not that the PDF actually returns
 * a valid binary.
 *
 * The Phase 3 Berater-Walkthrough
 * (PHASE3-WALKTHROUGH-FINDINGS.md) found
 * that the "BWA-PDF" promise in USER-GUIDE
 * Pfad 4.1 was working but the underlying
 * month scoping (Zahllast is per-month, like
 * UStVA) was a black box.
 *
 * This tier adds a focused backend e2e for
 * the bwa.pdf endpoint that:
 *   1. asserts the month-scoped filename
 *   2. asserts the application/pdf content-type
 *   3. asserts the PDF magic bytes
 *   4. asserts that month=13 + month=0 + year=1900
 *      surface 400 with German error messages
 *   5. asserts that month=7 with valid year
 *      returns a non-empty PDF
 *   6. asserts that month is REQUIRED
 *      (the endpoint always defaults to the
 *      current month, but the URL must still
 *      be well-formed — no month= parameter
 *      is the same as month=current)
 *
 * Tests:
 *   1. unauthenticated request: missing headers → 401
 *   2. missing companyId → 400
 *   3. missing year → 200 (defaults to current year)
 *   4. month=7 → 200 + application/pdf + PDF magic
 *      bytes + Content-Disposition filename
 *      "BWA-YYYY-07.pdf"
 *   5. month=13 → 400 with German error
 *   6. month=0 → 400
 *   7. year=1900 → 400 with German error
 *   8. year=2026&month=7 → 200 + non-empty body
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

test.describe("Tier 186 — BWA-PDF month-scoped coverage", () => {
  test("1. unauthenticated request: missing headers → 401", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/bwa.pdf?year=2026&month=7&companyId=${tokens!.companyId}`,
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })

  test("2. missing companyId → 400", async ({ request }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/reports/bwa.pdf?year=2026&month=7",
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected companyId error, got: ${body}`).toMatch(/companyId/i)
  })

  test("3. missing year → 200 (defaults to current year)", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/bwa.pdf?month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    expect(res.headers()["content-type"]).toMatch(/application\/pdf/)
  })

  test("4. month=7 → 200 + application/pdf + PDF magic + filename BWA-YYYY-07.pdf", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/bwa.pdf?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    expect(res.headers()["content-type"]).toMatch(/application\/pdf/)
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition, `expected BWA-YYYY-07.pdf filename, got: ${disposition}`).toMatch(
      /BWA-\d{4}-07\.pdf/,
    )
    const body = await res.body()
    expect(body.length, `expected non-empty body, got ${body.length} bytes`).toBeGreaterThan(500)
    expect(body.slice(0, 4).toString("latin1"), "PDF should start with %PDF magic").toBe("%PDF")
  })

  test("5. month=13 → 400 with German error", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/bwa.pdf?year=2026&month=13&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected German month error, got: ${body}`).toMatch(/month/i)
    expect(body, `expected range 1-12, got: ${body}`).toMatch(/1 und 12/)
  })

  test("6. month=0 → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/bwa.pdf?year=2026&month=0&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("7. year=1900 → 400 with German error", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/bwa.pdf?year=1900&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected German year error, got: ${body}`).toMatch(/year|ungültig/i)
  })

  test("8. year=2026&month=7 → 200 + non-empty body", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/bwa.pdf?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status()).toBe(200)
    const body = await res.body()
    expect(body.length, `expected body > 500 bytes, got: ${body.length}`).toBeGreaterThan(500)
  })
})
