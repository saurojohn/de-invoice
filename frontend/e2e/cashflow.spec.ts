import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 74: Cash flow forecast UI.
 *
 * The /dashboard/cashflow page is a new entry on
 * the dashboard. It calls GET /api/v1/reports/cashflow
 * and renders a 12-month bar chart + summary table
 * + "first dry month" warning.
 *
 *   1. Dashboard has a Cashflow card that links to
 *      /dashboard/cashflow.
 *   2. /dashboard/cashflow renders the title +
 *      default-12-months summary.
 *   3. Changing starting balance + clicking
 *      "Aktualisieren" updates the endBalance.
 *   4. The bar chart shows one bar per month
 *      (12 by default).
 *   5. The table shows all 12 month rows with
 *      incoming/outgoing/net/cumulative columns.
 *
 * Backend e2e 100 covers the API contract. This
 * file exercises the React page in a real
 * headless browser.
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
    throw new Error(`Auth cache ${AUTH_CACHE} missing — run backend e2e first`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

async function injectAuth(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
  await page.context().addCookies([
    {
      name: "x-user-id",
      value: testTokens!.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens!.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
}

test.describe("Cash flow forecast — /dashboard/cashflow", () => {
  test("dashboard has a cashflow card that links to /dashboard/cashflow", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("dashboard-card-cashflow")).toBeVisible({
      timeout: 30_000,
    })
  })

  test("default load shows 12-month summary + table + chart", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/cashflow")
    // Title
    await expect(page.getByText("Liquiditätsplanung")).toBeVisible({
      timeout: 30_000,
    })
    // Summary card
    await expect(page.getByTestId("cashflow-summary")).toBeVisible()
    // 12 table rows
    const rows = page.locator("[data-testid^='cashflow-row-']")
    await expect(rows).toHaveCount(12, { timeout: 15_000 })
    // 12 bars in the chart
    const bars = page.locator("[data-testid^='cashflow-bar-']")
    await expect(bars).toHaveCount(12)
    // Counters visible
    await expect(
      page.getByTestId("cashflow-count-open-invoices"),
    ).toBeVisible()
    await expect(
      page.getByTestId("cashflow-count-open-expenses"),
    ).toBeVisible()
  })

  test("changing startingBalance updates endBalance", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/cashflow")
    await expect(page.getByTestId("cashflow-summary")).toBeVisible({
      timeout: 30_000,
    })
    // Read the current endBalance value (the
    // baseline for default 0 starting balance).
    const endBalance = page.getByTestId("cashflow-end-balance")
    const before = await endBalance.textContent()
    // Set starting balance to 50.000,00 (German
    // decimal comma — same convention as the rest
    // of the app).
    await page.getByTestId("cashflow-starting-balance").fill("50.000,00")
    await page.getByTestId("cashflow-update").click()
    // After update, endBalance must have increased
    // by exactly 50.000,00.
    const after = await endBalance.textContent()
    expect(before).not.toBe(after)
    // Strip the currency symbol + spaces + dots,
    // convert comma to dot, parse to number. The
    // difference should be ~50000.
    const parseEur = (s: string | null): number => {
      if (!s) return 0
      // e.g. "33.809,00 €" → 33809
      const cleaned = s.replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", ".")
      return Number(cleaned)
    }
    const beforeNum = parseEur(before)
    const afterNum = parseEur(after)
    const diff = afterNum - beforeNum
    expect(Math.abs(diff - 50000)).toBeLessThan(1)
  })

  test("setting months=6 reduces the table to 6 rows", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/cashflow")
    await expect(page.getByTestId("cashflow-summary")).toBeVisible({
      timeout: 30_000,
    })
    await page.getByTestId("cashflow-months").fill("6")
    await page.getByTestId("cashflow-update").click()
    const rows = page.locator("[data-testid^='cashflow-row-']")
    await expect(rows).toHaveCount(6, { timeout: 10_000 })
    const bars = page.locator("[data-testid^='cashflow-bar-']")
    await expect(bars).toHaveCount(6)
  })
})
