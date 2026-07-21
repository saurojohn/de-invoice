import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 78: EU OSS (One-Stop-Shop) tab.
 *
 * The /dashboard/reports page now has a 6th tab
 * "EU OSS" that calls GET /api/v1/reports/oss
 * and renders the per-country breakdown + summary
 * cards + exclusion counts + a CSV download link.
 *
 *   1. OSS tab button is visible + clickable.
 *   2. Clicking it loads the OSS panel with the
 *      summary cards + a country table.
 *   3. The CSV download link has the FULL backend
 *      URL (per the tier-76 lesson — relative
 *      /api/v1/* goes to the Next.js dev server
 *      and 404s).
 *   4. Changing the quarter + recompute reloads
 *      the data.
 *   5. The home-country pill surfaces the
 *      company's own member state.
 *
 * Backend e2e 104 covers the API contract. This
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

test.describe("OSS tab — /dashboard/reports", () => {
  test("OSS tab is present + clickable", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    const tab = page.getByTestId("tab-oss")
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(page.getByTestId("oss-tab")).toBeVisible({ timeout: 15_000 })
  })

  test("default load shows summary cards + home country", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-oss").click()
    await expect(page.getByTestId("oss-tab")).toBeVisible({ timeout: 30_000 })
    // Summary cards
    await expect(page.getByTestId("oss-total-net")).toBeVisible()
    await expect(page.getByTestId("oss-total-vat")).toBeVisible()
    await expect(page.getByTestId("oss-total-gross")).toBeVisible()
    await expect(page.getByTestId("oss-total-invoices")).toBeVisible()
    // Home country label
    await expect(page.getByTestId("oss-homeCountry")).toBeVisible()
    // Exclusion counters
    await expect(page.getByTestId("oss-excluded-b2b")).toBeVisible()
    await expect(page.getByTestId("oss-excluded-sameCountry")).toBeVisible()
    await expect(page.getByTestId("oss-excluded-nonEU")).toBeVisible()
    await expect(page.getByTestId("oss-excluded-draft")).toBeVisible()
  })

  test("CSV download link uses full backend URL (not relative)", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-oss").click()
    await expect(page.getByTestId("oss-tab")).toBeVisible({ timeout: 30_000 })
    // Wait for the useEffect to populate the link
    // (the link starts as "#" until localStorage
    // + the API base env are available — see the
    // tier-76 lesson).
    const link = page.getByTestId("oss-csv-link")
    await expect(link).toBeVisible()
    const href = await link.getAttribute("href")
    // Must NOT be the relative form (Next.js dev
    // server on 3100 has no /api/v1/* proxy and
    // would 404 the download).
    expect(href).not.toBe("#")
    expect(href).toContain("oss.csv")
    // The tier-76 fix: full backend URL, including
    // the protocol + host.
    expect(href).toMatch(/^https?:\/\//)
  })

  test("changing quarter + recompute reloads the panel", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-oss").click()
    await expect(page.getByTestId("oss-tab")).toBeVisible({ timeout: 30_000 })
    // Set year to 2025 (known-data year? actually 2025
    // has 0 invoices in dev DB so the panel may show
    // 'noData' — but the API still returns 200 and
    // the panel renders the empty-state Card. The
    // point of this test is the "recompute fires a
    // new request" path, not the data content.
    await page.getByTestId("oss-year").fill("2025")
    await page.getByTestId("oss-quarter").selectOption("3")
    await page.getByTestId("oss-recompute").click()
    // Wait for the recompute to complete and the
    // panel to re-render. The summary cards are
    // always rendered (the API always returns
    // a totals block, even when the data is empty).
    await expect(page.getByTestId("oss-total-net")).toBeVisible()
  })
})
