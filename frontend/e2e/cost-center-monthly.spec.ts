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

// Tier 45 spec used to assume July always had residual
// data from prior tier e2es (29/38/41 etc.). That
// assumption broke when the test ran in isolation or
// before those seeders — the page rendered the empty
// state and cc-monthly-total never mounted. Seed a
// fresh July invoice + matching expense in beforeAll
// so the spec is self-sufficient regardless of test
// ordering. Uses the same cost-center as the backend
// e2e (VERTRIEB) so the row assertion is stable.
test.beforeAll(async ({ request }) => {
  if (!testTokens) return
  const companyId = testTokens.companyId
  const year = new Date().getFullYear()
  // Pick any customer — the cost-center endpoint
  // groups by costCenter, not customer, so the
  // identity of the customer is irrelevant.
  const custRes = await request.get(
    `http://localhost:3001/api/v1/customers?companyId=${companyId}`,
    {
      headers: {
        "x-user-id": testTokens.userId,
        "x-company-id": companyId,
      },
    },
  )
  if (!custRes.ok()) return
  const cdata = await custRes.json()
  const customers = Array.isArray(cdata)
    ? cdata
    : cdata.data ?? cdata.items ?? cdata.customers ?? []
  const cust = customers[0]
  if (!cust) return
  // Create a single July invoice (119€ gross, 19% VAT)
  // and a single July expense (50€) for VERTRIEB so
  // the monthly report returns ≥1 row.
  const day = 15
  const issueDate = new Date(Date.UTC(year, 6, day, 12, 0, 0)).toISOString()
  const dueDate = new Date(Date.UTC(year, 7, day, 12, 0, 0)).toISOString()
  await request.post(
    `http://localhost:3001/api/v1/invoices?companyId=${companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": testTokens.userId,
        "x-company-id": companyId,
      },
      data: {
        customerId: cust.id,
        issueDate,
        dueDate,
        type: "INV",
        costCenter: "VERTRIEB",
        items: [
          {
            description: "Tier45 playwright seed",
            quantity: 1,
            unitPrice: 100,
            vatRate: 0.19,
          },
        ],
      },
    },
  )
  // The single invoice is enough for the row assertion.
  // The expense seed would also be needed to cover the
  // expenseCount assertion, but the spec only checks
  // for ≥1 cc-monthly-row, not for a specific count.
})

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
    // Tier 358c: register the waiter BEFORE navigating. It used to be set up
    // after goto + toHaveURL, by which point the yearly request could
    // already have completed.
    const yearlyResponse = page.waitForResponse(
      (r) => r.url().includes("/api/v1/reports/cost-center-yearly"),
      { timeout: 15_000 },
    )
    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(/\/dashboard\/cost-center-report$/, {
      timeout: 15_000,
    })
    await yearlyResponse

    // Tier 358c: this was `await monthLinks.count()` followed by
    // test.skip("no seeded data for current year") on 0. The response having
    // arrived does not mean React has rendered the rows, and count() does not
    // wait — so the test intermittently skipped with data present (CI run
    // 34572785139 skipped it; the run before did not). The data is not in
    // question: this file's beforeAll creates a VERTRIEB invoice dated
    // July 15 of the current year on every run. A web-first wait covers the
    // render, and fails loudly if that seed ever stops producing a row.
    const monthLinks = page.locator('[data-testid^="cc-row-month-link-"]')
    await expect(monthLinks.first()).toBeVisible({ timeout: 15_000 })

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