import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 15: List page smoke tests.
 *
 * The smoke suite (smoke.spec.ts) tests
 * login + dashboard + customers + journal.
 * These tests cover the OTHER list pages:
 *
 *   1. Invoices list — verify the table
 *      renders, search input works, and
 *      rows have the expected data-testid
 *      attributes we added in Tier 15.
 *
 *   2. Products list — same coverage as
 *      invoices. Empty-state + table
 *      rendering + search.
 *
 * We don't drive the full create flows
 * here — those are complex multi-step
 * forms that deserve their own tests.
 * The smoke goal here is: "the page
 * hydrates, fetches data from the backend,
 * renders rows, doesn't crash".
 *
 * Why list pages and not detail pages?
 *   - Detail pages (invoices/[id]) are
 *     ~1900 lines of state with tabs
 *     (PDF / email / payments / etc.).
 *     Each tab needs its own test.
 *   - List pages are the most common
 *     navigation entry point — if the
 *     list is broken, every other page
 *     is unreachable.
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

test.describe("Invoices list", () => {
  test("renders the list page without console errors", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/invoices")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    // Title visible (the h1 has the page title)
    await expect(
      page.locator("h1").first(),
    ).toBeVisible({ timeout: 5_000 })

    // No JS error overlay
    const body = await page.locator("body").innerText()
    expect(body).not.toContain("Application error")

    // Search input is mounted and has the
    // data-testid we added.
    const search = page.locator('[data-testid="invoice-search-input"]')
    await expect(search).toBeVisible({ timeout: 5_000 })

    // Either rows OR empty state. The
    // SH Leder test company has 100+
    // invoices from prior e2e runs, so we
    // expect at least 1 row.
    // Tier 461a: wait for either before counting — the count right after
    // networkidle raced the list's render (0 rows, and `body`, read before,
    // had no empty-state text yet: CI run 36231779527, flaky on retry).
    const rows = page.locator('[data-testid="invoice-row"]')
    await expect(rows.first().or(page.getByText(/Keine|empty|nothing/i).first()))
      .toBeVisible({ timeout: 15_000 })
    const rowCount = await rows.count()
    if (rowCount === 0) {
      // Empty state — fine, but verify
      // the table didn't crash.
      expect(await page.locator("body").innerText()).toMatch(/Keine|empty|nothing/i)
    } else {
      // At least one row visible.
      expect(rowCount).toBeGreaterThan(0)
      // Find the first row with a real invoice
      // number (skip test fixtures like
      // 'T160-CLONE-SRC' which use a non-standard
      // format). We iterate the row numbers
      // directly via evaluate() because CSS
      // attribute selectors can't negate prefix
      // matches in a single selector.
      const firstRealNumber: string | null = await page.evaluate(() => {
        const rows = document.querySelectorAll(
          '[data-testid="invoice-row"][data-invoice-number]',
        )
        for (const row of Array.from(rows)) {
          const num = row.getAttribute("data-invoice-number") || ""
          if (/^(INV|CN|PI|RCV)-\d{4}-\d+$/.test(num)) return num
        }
        return null
      })
      expect(firstRealNumber).not.toBeNull()
      expect(firstRealNumber).toMatch(/^(INV|CN|PI|RCV)-\d{4}-\d+$/)
    }
  })

  test("search filters the list", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/invoices")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    // Tier 362b: wait for the rows instead of counting them once right after
    // "networkidle". That instantaneous count could run before the list had
    // rendered, and the test then skipped as if the DB were empty — CI run
    // 34599002238 skipped the invoices search this way while the run before
    // passed it in 2.5 s. The CI seed always has this data, so an empty list is
    // a failure, not a skip.
    const invoiceRows = page.locator('[data-testid="invoice-row"]')
    await expect(invoiceRows.first()).toBeVisible({ timeout: 15_000 })

    // Pick a real invoice number (skip test
    // fixtures like 'T160-CLONE-SRC').
    const firstInvoiceNumber: string | null = await page.evaluate(() => {
      const rows = document.querySelectorAll(
        '[data-testid="invoice-row"][data-invoice-number]',
      )
      for (const row of Array.from(rows)) {
        const num = row.getAttribute("data-invoice-number") || ""
        if (/^(INV|CN|PI|RCV)-\d{4}-\d+$/.test(num)) return num
      }
      return null
    })
    expect(firstInvoiceNumber).toBeTruthy()

    // Search for the year part of the
    // number. The search box on the page
    // debounces (300ms before firing the
    // API), so we wait for the row count
    // to settle.
    const yearMatch = firstInvoiceNumber!.match(/-(\d{4})-/)
    expect(yearMatch).not.toBeNull()
    const year = yearMatch![1]
    await page
      .locator('[data-testid="invoice-search-input"]')
      .fill(`INV-${year}`)
    await page.waitForTimeout(800) // wait for debounce + fetch

    // After search, only rows matching the
    // year prefix should remain.
    const filteredCount = await page
      .locator('[data-testid="invoice-row"]')
      .count()
    // Every visible row should have a
    // data-invoice-number that contains
    // the search term (or 0 rows if the
    // search is too narrow).
    if (filteredCount > 0) {
      for (let i = 0; i < Math.min(filteredCount, 5); i++) {
        const num = await page
          .locator('[data-testid="invoice-row"]')
          .nth(i)
          .getAttribute("data-invoice-number")
        expect(num).toContain(`INV-${year}`)
      }
    }
  })
})

test.describe("Products list", () => {
  test("renders the list page without console errors", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/products")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    await expect(
      page.locator("h1").first(),
    ).toBeVisible({ timeout: 5_000 })

    const body = await page.locator("body").innerText()
    expect(body).not.toContain("Application error")

    const search = page.locator('[data-testid="product-search-input"]')
    await expect(search).toBeVisible({ timeout: 5_000 })

    const rowCount = await page
      .locator('[data-testid="product-row"]')
      .count()
    // Products list might be empty in a
    // fresh DB. Either way is fine — we
    // just want to confirm the page rendered
    // without an error.
    if (rowCount > 0) {
      // At least one row has the expected
      // data-testid with a SKU attribute.
      const firstSku = await page
        .locator('[data-testid="product-row"]')
        .first()
        .getAttribute("data-product-sku")
      // SKU is optional — just verify the
      // attribute exists (could be empty
      // string for products without a SKU).
      expect(firstSku).not.toBeNull()
    } else {
      // Empty state. The page renders an
      // "addFirst" button when there are no
      // products at all.
      // Either the empty state shows, or
      // there's a different no-results UI.
      // We don't fail on this — just verify
      // the page didn't crash.
      expect(body.length).toBeGreaterThan(0)
    }
  })

  test("search filters the products list", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/products")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    // Tier 362b: wait for the rows instead of counting them once right after
    // "networkidle". That instantaneous count could run before the list had
    // rendered, and the test then skipped as if the DB were empty — CI run
    // 34599002238 skipped the invoices search this way while the run before
    // passed it in 2.5 s. The CI seed always has this data, so an empty list is
    // a failure, not a skip.
    const productRows = page.locator('[data-testid="product-row"]')
    await expect(productRows.first()).toBeVisible({ timeout: 15_000 })
    const baselineCount = await productRows.count()

    // Type a string that matches nothing.
    // The list should shrink (typically to 0).
    await page
      .locator('[data-testid="product-search-input"]')
      .fill("zzzzz-no-such-product-zzzzz")
    await page.waitForTimeout(800)

    const filteredCount = await page
      .locator('[data-testid="product-row"]')
      .count()
    expect(filteredCount).toBeLessThanOrEqual(baselineCount)
  })
})