import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 16: List page coverage for the
 * remaining 4 dashboard pages.
 *
 *   1. Suppliers — table of vendors
 *      (Lieferanten)
 *   2. Expenses — table of
 *      Eingangsrechnungen (vendor
 *      invoices)
 *   3. Reminders — cards of overdue
 *      invoices (Mahnung candidates)
 *   4. Recurring invoices — cards of
 *      recurring templates
 *
 * The list-pages.spec.ts (Tier 15)
 * already covers invoices + products.
 * This file extends coverage to the
 * other 4 frequently-visited list
 * pages.
 *
 * Pattern: each test is a smoke
 * check (page hydrates, no error
 * overlay) + a data sanity check
 * (rows have the expected
 * data-testid attributes).
 *
 * Some of these pages might be empty
 * in the SH Leder test DB — that's
 * fine, the test just verifies the
 * page renders.
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

test.describe("Suppliers list", () => {
  test("renders without console errors + table has data-testid", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/suppliers")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    await expect(
      page.locator("h1").first(),
    ).toBeVisible({ timeout: 5_000 })

    const body = await page.locator("body").innerText()
    expect(body).not.toContain("Application error")

    // Search input mounted
    await expect(
      page.locator('[data-testid="supplier-search-input"]'),
    ).toBeVisible({ timeout: 5_000 })

    const rowCount = await page
      .locator('[data-testid="supplier-row"]')
      .count()
    if (rowCount > 0) {
      // Each row should have a name attribute
      const firstName = await page
        .locator('[data-testid="supplier-row"]')
        .first()
        .getAttribute("data-supplier-name")
      expect(firstName).toBeTruthy()
    }
  })

  test("search filters the supplier list", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/suppliers")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    // Tier 362b: wait for the rows instead of counting them once right after
    // "networkidle". That instantaneous count could run before the list had
    // rendered, and the test then skipped as if the DB were empty — CI run
    // 34599002238 skipped the invoices search this way while the run before
    // passed it in 2.5 s. The CI seed always has this data, so an empty list is
    // a failure, not a skip.
    const supplierRows = page.locator('[data-testid="supplier-row"]')
    await expect(supplierRows.first()).toBeVisible({ timeout: 15_000 })
    const baselineCount = await supplierRows.count()

    // Type a non-matching string. Suppliers
    // search is on Enter (no debounce).
    await page
      .locator('[data-testid="supplier-search-input"]')
      .fill("zzzzz-no-such-supplier-zzzzz")
    await page.press('[data-testid="supplier-search-input"]', "Enter")
    await page.waitForTimeout(500)

    const filteredCount = await page
      .locator('[data-testid="supplier-row"]')
      .count()
    expect(filteredCount).toBeLessThan(baselineCount)
  })
})

test.describe("Expenses list", () => {
  test("renders without console errors + table has data-testid", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/expenses")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    await expect(
      page.locator("h1").first(),
    ).toBeVisible({ timeout: 5_000 })

    const body = await page.locator("body").innerText()
    expect(body).not.toContain("Application error")

    // Search input mounted
    await expect(
      page.locator('[data-testid="expense-search-input"]'),
    ).toBeVisible({ timeout: 5_000 })

    const rowCount = await page
      .locator('[data-testid="expense-row"]')
      .count()
    if (rowCount > 0) {
      const firstId = await page
        .locator('[data-testid="expense-row"]')
        .first()
        .getAttribute("data-expense-id")
      // expense id is a UUID
      expect(firstId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    }
  })
})

test.describe("Reminders list", () => {
  test("renders without console errors", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/reminders")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    await expect(
      page.locator("h1").first(),
    ).toBeVisible({ timeout: 5_000 })

    const body = await page.locator("body").innerText()
    expect(body).not.toContain("Application error")

    // Either reminder cards OR empty state
    const cardCount = await page
      .locator('[data-testid="reminder-card"]')
      .count()
    if (cardCount === 0) {
      // No overdue invoices — fine.
      // The page renders an empty
      // state ("Keine überfälligen
      // Rechnungen" or similar).
      expect(body.length).toBeGreaterThan(0)
    } else {
      const firstNumber = await page
        .locator('[data-testid="reminder-card"]')
        .first()
        .getAttribute("data-invoice-number")
      // Tier 302: relax the strict pattern — the dev DB
      // contains ad-hoc fixture invoice numbers
      // (e.g. "T160-CLONE-SRC", "INV-TEST-001") that
      // don't match the standard
      // /^(INV|CN|PI|RCV)-\d{4}-\d+$/ production format.
      // The attribute just needs to be present and
      // non-empty (consistent with the supplier and
      // recurring-card assertions above/below).
      expect(firstNumber, "reminder card data-invoice-number should be set").toBeTruthy()
    }
  })
})

test.describe("Recurring invoices list", () => {
  test("renders without console errors", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/recurring-invoices")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    await expect(
      page.locator("h1").first(),
    ).toBeVisible({ timeout: 5_000 })

    const body = await page.locator("body").innerText()
    expect(body).not.toContain("Application error")

    const cardCount = await page
      .locator('[data-testid="recurring-card"]')
      .count()
    if (cardCount === 0) {
      // No recurring templates — fine.
      expect(body.length).toBeGreaterThan(0)
    } else {
      const firstName = await page
        .locator('[data-testid="recurring-card"]')
        .first()
        .getAttribute("data-recurring-name")
      expect(firstName).toBeTruthy()
    }
  })
})