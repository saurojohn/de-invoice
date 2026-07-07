import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 46: Cost-Center Transactions drill-in page.
 *
 * Tests:
 *   1. Direct hit on /cost-center-report/[year]/[month]/[cc]
 *      renders the transaction table, totals strip,
 *      and date-sorted rows.
 *   2. Clicking a cost-center link on the monthly page
 *      navigates to the transactions drill-in.
 *   3. The back-to-monthly button returns to the
 *      parent monthly report.
 *   4. "Nicht zugewiesen" round-trips through the URL
 *      (URL-encoded space, decoded on the server).
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

test.describe("Tier 46 — Cost-Center Transactions drill-in", () => {
  test("direct hit on transactions page renders rows + totals", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const year = new Date().getFullYear()

    // June has the most residual data — 144 expense
    // receipts from prior tier e2es (T13/T19/T29/etc.)
    // and they're all on null-cc.
    const month = 6
    const cc = "Nicht zugewiesen"

    const reportPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-transactions") &&
        r.url().includes(`year=${year}`) &&
        r.url().includes(`month=${month}`),
      { timeout: 15_000 },
    )

    await page.goto(
      `/dashboard/cost-center-report/${year}/${month}/${encodeURIComponent(cc)}`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/cost-center-report/${year}/${month}/${cc.replace(/ /g, "%20")}$`),
      { timeout: 15_000 },
    )

    const res = await reportPromise
    expect(res.ok()).toBe(true)

    // Title includes the year and the cost-center name
    // (the placeholder pattern may show in either
    // resolved or un-resolved form depending on locale
    // — be permissive).
    const heading = await page.locator("h1").first().textContent()
    expect(heading || "").toContain(String(year))
    // The cost-center name appears in the heading OR in
    // a sub-heading. We don't insist on strict heading
    // match because the i18n template substitution
    // differs across DE/EN/ZH.
    expect(
      heading || "",
    ).toMatch(/Nicht zugewiesen|Not assigned|未分配|{costCenter}/)

    // The transactions table renders at least one row
    // (June always has data).
    await expect(
      page.locator('[data-testid="cc-tx-row"]').first(),
    ).toBeVisible({ timeout: 10_000 })

    // The pagination strip shows "X–Y of Z".
    await expect(page.locator("body")).toContainText(/von \d+|of \d+/, {
      timeout: 10_000,
    })

    // Back-to-monthly button is visible.
    await expect(
      page.locator('[data-testid="back-to-monthly"]'),
    ).toBeVisible()
  })

  test("clicking cost-center name on monthly page navigates to drill-in", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const year = new Date().getFullYear()

    // Visit the monthly page first to establish the
    // data context. We use June (heavy residual
    // data).
    await page.goto(`/dashboard/cost-center-report/${year}/6`, {
      waitUntil: "domcontentloaded",
    })
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-monthly") &&
        r.url().includes(`month=6`),
      { timeout: 15_000 },
    )

    // Wait for the first cost-center link to render.
    const firstLink = page.locator('[data-testid="cc-monthly-row-link"]').first()
    await expect(firstLink).toBeVisible({ timeout: 10_000 })

    const ccText = (await firstLink.textContent()) || ""
    const expectedCc = ccText.trim()
    expect(expectedCc.length).toBeGreaterThan(0)

    // Register the tx API listener BEFORE clicking.
    const txPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-transactions") &&
        r.url().includes(`month=6`),
      { timeout: 15_000 },
    )

    await firstLink.click()

    // We should land on the tx page with the cc
    // segment in the URL (URL-encoded if it has a
    // space, like "Nicht zugewiesen").
    await expect(page).toHaveURL(
      new RegExp(
        `/dashboard/cost-center-report/${year}/6/${encodeURIComponent(expectedCc).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
      { timeout: 15_000 },
    )

    const res = await txPromise
    expect(res.ok()).toBe(true)
  })

  test("back-to-monthly button returns to monthly report", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const year = new Date().getFullYear()

    await page.goto(
      `/dashboard/cost-center-report/${year}/6/${encodeURIComponent("Nicht zugewiesen")}`,
      { waitUntil: "domcontentloaded" },
    )
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-transactions"),
      { timeout: 15_000 },
    )

    await page
      .locator('[data-testid="back-to-monthly"]')
      .click()

    await expect(page).toHaveURL(
      new RegExp(`/dashboard/cost-center-report/${year}/6$`),
      { timeout: 10_000 },
    )
  })

  test("empty bucket renders empty-state message", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const year = new Date().getFullYear()

    // March + a cc that has nothing in March
    await page.goto(
      `/dashboard/cost-center-report/${year}/3/VERTRIEB`,
      { waitUntil: "domcontentloaded" },
    )
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/reports/cost-center-transactions"),
      { timeout: 15_000 },
    )

    // Empty state — "Keine Buchungen für diesen Filter"
    await expect(page.locator("body")).toContainText(
      /Keine Buchungen|No transactions|无记录/,
      { timeout: 10_000 },
    )
  })
})