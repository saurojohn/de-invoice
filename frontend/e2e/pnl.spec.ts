import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 75: P&L (Gewinn- und Verlustrechnung) tab.
 *
 * The /dashboard/reports page now has a 5th tab
 * "GuV (P&L)" that calls GET /api/v1/reports/pnl
 * and renders a 12-month table + YTD row +
 * prior-year comparison.
 *
 *   1. P&L tab button is visible on /dashboard/reports.
 *   2. Clicking it loads the table with 12 month
 *      rows + a YTD row.
 *   3. The YTD operating result matches the sum
 *      of the 12 monthly operating results.
 *   4. Changing the year input and clicking
 *      "Berechnen" reloads the data.
 *
 * Backend e2e 101 covers the API contract. This
 * file exercises the React page.
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

test.describe("P&L tab — /dashboard/reports", () => {
  test("P&L tab is present + clickable", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    const tab = page.getByTestId("tab-pnl")
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(page.getByTestId("pnl-tab")).toBeVisible({ timeout: 15_000 })
  })

  test("default load shows 12 month rows + YTD row", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-pnl").click()
    await expect(page.getByTestId("pnl-tab")).toBeVisible({ timeout: 30_000 })
    // 12 month rows
    const rows = page.locator("[data-testid^='pnl-row-2026-']")
    await expect(rows).toHaveCount(12, { timeout: 15_000 })
    // YTD row
    await expect(page.getByTestId("pnl-ytd-row")).toBeVisible()
  })

  test("YTD operating result = sum of monthly operating results", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-pnl").click()
    await expect(page.getByTestId("pnl-ytd-row")).toBeVisible({
      timeout: 30_000,
    })
    // Read each monthly operating result from the
    // 5th cell of each row, then read the YTD.
    const monthlyCells = await page
      .locator("[data-testid^='pnl-row-2026-'] td:nth-child(5)")
      .allTextContents()
    // Strip currency formatting and sum.
    const parseEur = (s: string) => {
      const cleaned = s.replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", ".")
      return Number(cleaned) || 0
    }
    const sum = monthlyCells.reduce((s, c) => s + parseEur(c), 0)
    const ytdText = await page.getByTestId("pnl-ytd-result").textContent()
    const ytd = parseEur(ytdText || "")
    expect(Math.abs(sum - ytd)).toBeLessThan(1)
  })

  test("changing year + recompute reloads the table", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-pnl").click()
    await expect(page.getByTestId("pnl-tab")).toBeVisible({ timeout: 30_000 })
    // Change year to 2025
    await page.getByTestId("pnl-year").fill("2025")
    await page.getByTestId("pnl-recompute").click()
    // Wait for the rows to reflect 2025
    await expect(
      page.locator("[data-testid^='pnl-row-2025-']"),
    ).toHaveCount(12, { timeout: 15_000 })
  })
})
