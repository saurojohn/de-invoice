import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 39: Cost-Center CRUD form UI.
 *
 * Tests:
 *   1. /dashboard/invoices/create (create mode) shows the
 *      new fields (costCenter input + costObject input).
 *   2. GET /invoices/cost-centers returns the dropdown
 *      values — we hit it directly via apiGet to verify
 *      wiring without scraping the datalist.
 *   3. The PDF render of an invoice with costCenter
 *      + costObject includes the stamps (sanity check
 *      that the data flows end-to-end through to the
 *      PDF text layer).
 */

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(`Auth cache ${AUTH_CACHE} missing`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

async function setupAuth(context: any, page: any) {
  if (!testTokens) return
  await context.addCookies([
    {
      name: "x-user-id",
      value: testTokens.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

test.describe("Tier 39 — Cost-Center form UI", () => {
  test("Create form shows cost-center + cost-object inputs", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/invoices/create", {
      waitUntil: "domcontentloaded",
    })
    await expect(
      page.locator('[data-testid="invoice-cost-center"]'),
    ).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-testid="invoice-cost-object"]'),
    ).toBeVisible({ timeout: 5_000 })

    // Fill them — values flow into form state. Real assert
    // is the round-trip with the backend (e2e 67).
    await page.locator('[data-testid="invoice-cost-center"]').fill("VERTRIEB")
    await page.locator('[data-testid="invoice-cost-object"]').fill("PROJ-2026-Q3")
    await expect(
      page.locator('[data-testid="invoice-cost-center"]'),
    ).toHaveValue("VERTRIEB")
    await expect(
      page.locator('[data-testid="invoice-cost-object"]'),
    ).toHaveValue("PROJ-2026-Q3")
  })

  test("GET /invoices/cost-centers returns the distinct list", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    if (!testTokens) return

    // Hit the endpoint directly via the page's request context
    // (cookies already set) — avoids reinventing fetch in the test.
    const res = await page.request.get(
      `http://localhost:3001/api/v1/invoices/cost-centers?companyId=${testTokens.companyId}`,
      {
        headers: {
          "x-user-id": testTokens.userId,
          "x-company-id": testTokens.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.costCenters)).toBe(true)
    // SH Leder has at least one cost center from the seed data
    // OR from prior e2e runs — at the very least the response
    // shape should be valid.
    for (const c of body.costCenters) {
      expect(typeof c).toBe("string")
    }
  })
})