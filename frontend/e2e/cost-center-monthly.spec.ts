import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 45: Cost-Center Monthly drill-in page +
 * yearly-table click-through.
 *
 * Tests:
 *   1. Direct hit on /cost-center-report/[year]/[month]
 *      renders the single-month report, fires the
 *      right API call, and shows the totals row.
 *   2. Clicking a non-empty month-cell on the yearly
 *      table navigates to the monthly drill-in page.
 *   3. The back-to-yearly button on the monthly page
 *      navigates back to /cost-center-report.
 *   4. Bad month param (e.g. /13) renders an inline
 *      error message, doesn't crash.
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

test.describe("Tier 45 — Cost-Center Monthly drill-in", () => {
  test("direct hit on monthly page renders single-month table", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const year = new Date().getFullYear()
    // Use a month that always has data — the prior
    // tier e2es (29/38/41 etc.) seed July invoices
    // (5 in 2026). A direct hit on a known-empty
    // month like 1 in 2026 would render an empty
    // report and skip the rows/heading assertions.
    const month = 7

    const reportPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-monthly") &&
        r.url().includes(`year=${year}`) &&
        r.url().includes(`month=${month}`),
      { timeout: 15_000 },
    )

    await page.goto(
      `/dashboard/cost-center-report/${year}/${month}`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/cost-center-report/${year}/${month}$`),
      { timeout: 15_000 },
    )

    const res = await reportPromise
    expect(res.ok()).toBe(true)

    // Title includes the year.
    const heading = await page.locator("h1").first().textContent()
    expect(heading || "").toContain(String(year))

    // The totals row is always present.
    await expect(
      page.locator('[data-testid="cc-monthly-total"]'),
    ).toBeVisible({ timeout: 10_000 })

    // At least one cc-monthly-row should be rendered
    // (July always has residual data from prior tier
    // tests).
    await expect(
      page.locator('[data-testid="cc-monthly-row"]').first(),
    ).toBeVisible({ timeout: 10_000 })

    // The back-to-yearly button is visible.
    await expect(
      page.locator('[data-testid="back-to-yearly"]'),
    ).toBeVisible()
  })

  test("clicking a month-cell on yearly table navigates to drill-in", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(/\/dashboard\/cost-center-report$/, {
      timeout: 15_000,
    })

    // Wait for the yearly report to load.
    await page.waitForResponse(
      (r) => r.url().includes("/api/v1/reports/cost-center-yearly"),
      { timeout: 15_000 },
    )

    // Find the first non-empty month-cell link (the
    // first row's first month with a value > 0).
    // We scan for any month link that exists.
    const monthLinks = page.locator('[data-testid^="cc-row-month-link-"]')
    const count = await monthLinks.count()
    if (count === 0) {
      // No data this year — skip (the test isn't
      // meaningful without seed). Mark as a soft pass.
      test.skip(true, "no seeded data for current year")
      return
    }

    // Pick the first link.
    const firstLink = monthLinks.first()
    const dataMonth = await firstLink.getAttribute("data-month")
    const year = new Date().getFullYear()

    // Register listener BEFORE the click.
    const monthlyApiPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-monthly") &&
        r.url().includes(`month=${dataMonth}`),
      { timeout: 15_000 },
    )

    await firstLink.click()

    await expect(page).toHaveURL(
      new RegExp(
        `/dashboard/cost-center-report/${year}/${dataMonth}$`,
      ),
      { timeout: 15_000 },
    )

    const res = await monthlyApiPromise
    expect(res.ok()).toBe(true)

    // The monthly page renders the totals row.
    await expect(
      page.locator('[data-testid="cc-monthly-total"]'),
    ).toBeVisible({ timeout: 10_000 })
  })

  test("back-to-yearly button returns to yearly report", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const year = new Date().getFullYear()

    await page.goto(`/dashboard/cost-center-report/${year}/3`, {
      waitUntil: "domcontentloaded",
    })
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-monthly"),
      { timeout: 15_000 },
    )

    await page
      .locator('[data-testid="back-to-yearly"]')
      .click()

    await expect(page).toHaveURL(
      /\/dashboard\/cost-center-report$/,
      { timeout: 10_000 },
    )
  })

  test("invalid month param (13) renders inline error", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const year = new Date().getFullYear()

    // Hit the page; the useEffect validates month=13
    // client-side and sets the error state without
    // firing the API call.
    await page.goto(`/dashboard/cost-center-report/${year}/13`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/cost-center-report/${year}/13$`),
      { timeout: 15_000 },
    )

    // The page should render the error message —
    // either the inline "Ungültiger Monat" or the
    // backend's 400 message — within the main area.
    await expect(page.locator("body")).toContainText(
      /(Ungültiger Monat|Bericht konnte nicht geladen werden)/,
      { timeout: 10_000 },
    )
  })
})