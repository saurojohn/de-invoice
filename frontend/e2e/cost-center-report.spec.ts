import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 44: Cost-Center Annual Report page.
 *
 * The page calls GET /reports/cost-center-yearly on mount
 * with the current year, and re-fires on year change.
 *
 * Tests:
 *   1. The page renders, shows the year filter and the
 *      Summe totals row.
 *   2. Switching the year select re-fires the API and
 *      updates the rendered year in the page title.
 *   3. CSV export click triggers a download with the
 *      right filename pattern (kostenstellen-<year>.csv).
 *   4. Pre-existing cost-center rows render (we don't
 *      need to seed here — the dashboard-v2 e2e + other
 *      tier tests leave residue that the report picks
 *      up; we just assert the page shape is healthy).
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

test.describe("Tier 44 — Cost-Center Annual Report", () => {
  test("page renders the report table + totals", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)

    // Register the API response listener BEFORE the
    // page mounts — the React effect fires the GET
    // synchronously on mount.
    const reportPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-yearly"),
      { timeout: 15_000 },
    )

    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(
      /\/dashboard\/cost-center-report$/,
      { timeout: 15_000 },
    )

    const res = await reportPromise
    expect(res.ok()).toBe(true)

    // The page shows the totals row (always present,
    // even when no per-cc rows exist).
    await expect(page.locator('[data-testid="cc-row-total"]')).toBeVisible({
      timeout: 10_000,
    })

    // The year select is rendered and defaults to the
    // current year.
    const yearSelect = page.locator('[data-testid="cc-year-select"]')
    await expect(yearSelect).toBeVisible()
    const currentYear = new Date().getFullYear()
    await expect(yearSelect).toHaveValue(String(currentYear))

    // The title includes the current year. We accept
    // both the i18n template form ("{year}") and the
    // resolved value.
    const heading = await page.locator("h1").first().textContent()
    expect(heading || "").toContain(String(currentYear))

    // The CSV export button is enabled when report data
    // is present.
    const exportBtn = page.locator('[data-testid="cc-export-csv"]')
    await expect(exportBtn).toBeEnabled({ timeout: 10_000 })
  })

  test("year change re-fires the API", async ({ page, context }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(
      /\/dashboard\/cost-center-report$/,
      { timeout: 15_000 },
    )

    // Wait for the first request to settle before we
    // trigger the year change.
    await page.waitForResponse(
      (r) => r.url().includes("/api/v1/reports/cost-center-yearly"),
      { timeout: 15_000 },
    )

    // Pick the year two years back (the select has
    // 5 options = current + 4 prior).
    const priorYear = new Date().getFullYear() - 2

    // Register listener BEFORE changing the value.
    const rerunPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-yearly") &&
        r.url().includes(`year=${priorYear}`),
      { timeout: 15_000 },
    )

    await page
      .locator('[data-testid="cc-year-select"]')
      .selectOption(String(priorYear))

    const res = await rerunPromise
    expect(res.ok()).toBe(true)
    expect(res.url()).toContain(`year=${priorYear}`)

    // Title updates to the new year.
    await expect(page.locator("h1").first()).toContainText(
      String(priorYear),
    )
  })

  test("CSV export triggers a download with the right filename", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(
      /\/dashboard\/cost-center-report$/,
      { timeout: 15_000 },
    )

    // Wait for the report to load so the export button
    // is enabled.
    await page.waitForResponse(
      (r) => r.url().includes("/api/v1/reports/cost-center-yearly"),
      { timeout: 15_000 },
    )

    const exportBtn = page.locator('[data-testid="cc-export-csv"]')
    await expect(exportBtn).toBeEnabled({ timeout: 10_000 })

    const downloadPromise = page.waitForEvent("download", {
      timeout: 10_000,
    })
    await exportBtn.click()
    const download = await downloadPromise
    const filename = download.suggestedFilename()
    const year = new Date().getFullYear()
    // Filename pattern: kostenstellen-auswertung-<year>.csv
    expect(filename).toMatch(
      new RegExp(`^kostenstellen-auswertung-${year}\\.csv$`),
    )
  })
})