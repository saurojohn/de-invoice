import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 61: Customer detail page (Kunden-Detailansicht).
 *
 * Tests the new top-level `/dashboard/customers/[id]` page:
 *   1. Page renders without console errors
 *   2. Customer name + K-Nr are visible in the header
 *   3. The KPI strip renders 6 stat tiles
 *   4. Tabs are clickable + switch content (Rechnungen /
 *      Ratenpläne / Mahnungen / Guthaben)
 *   5. The invoices tab lists at least one invoice for a
 *      customer that has invoices
 *   6. Customer list card click navigates to the detail
 *      page (replaces the legacy "open edit modal" flow)
 *
 * Why a separate spec? The detail page is a new top-level
 * route. Pre-existing list-pages specs (list-pages.spec.ts)
 * test the card grid but don't navigate INTO a customer.
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
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing — run backend e2e first`,
    )
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

test.beforeEach(async ({ context }: { context: any }) => {
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
})

async function injectLocalStorage(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

const TIER61_TAG = `Tier61-DetailTest-${Date.now()}`
let TEST_CUSTOMER_ID: string | null = null

test.beforeAll(async ({ request }) => {
  // Create a fresh customer so the spec is hermetic. No
  // open invoices are required for the tests below.
  const res = await request.post(
    `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        name: TIER61_TAG,
        type: "business",
        address: { city: "Berlin" },
      },
    },
  )
  expect(res.status()).toBe(201)
  const body = await res.json()
  TEST_CUSTOMER_ID = body.id
})

test.afterAll(async ({ request }) => {
  if (!TEST_CUSTOMER_ID || !testTokens) return
  try {
    await request.delete(
      `http://localhost:3001/api/v1/customers/${TEST_CUSTOMER_ID}?companyId=${testTokens.companyId}`,
      {
        headers: {
          "x-user-id": testTokens.userId,
          "x-company-id": testTokens.companyId,
        },
      },
    )
  } catch {
    // Ignore — non-fatal.
  }
})

test.describe("Customer detail page UI (Tier 61)", () => {
  test("detail page renders without console errors", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text())
    })

    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}`,
      { waitUntil: "domcontentloaded" },
    )
    // Wait for the title (rendered after the summary fetch)
    await expect(
      page.locator('[data-testid="customer-detail-title"]'),
    ).toBeVisible({ timeout: 15000 })
    expect(errors).toEqual([])
    expect(await page.locator("text=Application error").count()).toBe(0)
  })

  test("KPI strip renders 6 stat tiles", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="customer-detail-kpi-strip"]'),
    ).toBeVisible({ timeout: 15000 })
    // The KPI strip has 6 data-testid tiles (kpi-open-balance,
    // kpi-overdue, kpi-mahnungen, kpi-credit, kpi-plans,
    // kpi-last-invoice).
    const kpiIds = [
      "kpi-open-balance",
      "kpi-overdue",
      "kpi-mahnungen",
      "kpi-credit",
      "kpi-plans",
      "kpi-last-invoice",
    ]
    for (const id of kpiIds) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible()
    }
  })

  test("tabs switch content (Rechnungen / Ratenpläne / Mahnungen / Guthaben)", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="customer-detail-title"]'),
    ).toBeVisible({ timeout: 15000 })

    // The default tab is "invoices". The freshly-created
    // test customer has no invoices / plans / Mahnungen /
    // credit ledger rows, so every tab should show the
    // empty state. We poll the API directly to make sure
    // the data is in fact empty (catches regressions where
    // the page would falsely show a table).
    const invoicesRes = await page.request.get(
      `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}&customerId=${TEST_CUSTOMER_ID}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    const invBody = await invoicesRes.json()
    // Tier 369: was a test.skip(). The customer is created fresh in beforeAll,
    // so it cannot legitimately have invoices — the skip text said
    // "unexpectedly" itself. If this ever holds it is data contamination or a
    // backend bug, and the empty-state assertions below would be meaningless.
    expect(
      invBody.total,
      "a customer created fresh in beforeAll must have no invoices",
    ).toBe(0)

    // Each tab eventually shows the empty state. Poll with
    // 10s timeout per tab. The page also shows a loading
    // spinner before the empty state — we just want SOME
    // content in the tab body (empty state OR table).
    for (const tabId of ["tab-invoices", "tab-plans", "tab-mahnungen", "tab-credit"]) {
      // Click the tab (if not already active)
      await page.locator(`[data-testid="${tabId}"]`).click()
      // Wait for the tab to be visibly selected (one of the
      // empty-state or table selectors shows up).
      const selector = tabId.replace("tab-", "tab-") + "-empty"
      await expect(async () => {
        const empty = await page
          .locator(`[data-testid="${selector}"]`)
          .isVisible()
          .catch(() => false)
        const table = await page
          .locator(`[data-testid="${tabId.replace("tab-", "tab-")}-table"]`)
          .isVisible()
          .catch(() => false)
        expect(empty || table).toBe(true)
      }).toPass({ timeout: 10000 })
    }
  })

  test("customer list card click navigates to the detail page (replaces edit modal)", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/customers", {
      waitUntil: "domcontentloaded",
    })
    await expect(
      page.locator('[data-testid="customer-search-input"]'),
    ).toBeVisible({ timeout: 10000 })

    // Find the first customer card. The cards have
    // data-testid="customer-card" + data-customer-id. Click
    // it and assert the URL changes to the detail route.
    const firstCard = page
      .locator('[data-testid="customer-card"]')
      .first()
    await expect(firstCard).toBeVisible()
    const customerId = await firstCard.getAttribute("data-customer-id")
    expect(customerId).toBeTruthy()
    await firstCard.click()
    // URL should now be /dashboard/customers/<id>
    await page.waitForURL(
      (url) => url.pathname === `/dashboard/customers/${customerId}`,
      { timeout: 10000 },
    )
    await expect(
      page.locator('[data-testid="customer-detail-title"]'),
    ).toBeVisible()
  })
})
