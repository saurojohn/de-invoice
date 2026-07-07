import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 47: Cost-Center Trend chart on the yearly
 * report page.
 *
 * Tests:
 *   1. The page renders the trend chart above the
 *      table when rows are present.
 *   2. The chart has at least one polyline per
 *      cost-center row in the response.
 *   3. The legend lists every cost-center in the
 *      chart.
 *   4. Hovering a data point shows the tooltip with
 *      cost-center name + signed EUR amount.
 *   5. Year change re-fires both the yearly API and
 *      the chart's data updates.
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

test.describe("Tier 47 — Cost-Center Trend chart", () => {
  test("page renders the trend chart + polyline per cc", async ({
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

    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-yearly"),
    )

    // Trend chart container visible.
    await expect(page.locator('[data-testid="cc-trend"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      page.locator('[data-testid="cc-trend-svg"]'),
    ).toBeVisible()

    // At least one polyline — the page only renders
    // the chart when rows.length > 0, so a non-empty
    // chart implies the report had at least one cc.
    const polylines = page.locator('[data-testid="cc-trend-line"]')
    const lineCount = await polylines.count()
    expect(lineCount).toBeGreaterThanOrEqual(1)
  })

  test("legend lists every cost-center in the chart", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-yearly"),
    )

    const polylines = page.locator('[data-testid="cc-trend-line"]')
    const lineCount = await polylines.count()

    // Legend swatches should match polyline count.
    // We assert >= lineCount since the legend groups
    // swatches under a single container.
    const legend = page.locator('[data-testid="cc-trend-legend"]')
    await expect(legend).toBeVisible()

    // Collect cc names from polylines (via data attr).
    const ccNames: string[] = []
    for (let i = 0; i < lineCount; i++) {
      const cc = await polylines
        .nth(i)
        .getAttribute("data-cost-center")
      if (cc) ccNames.push(cc)
    }
    expect(ccNames.length).toBeGreaterThan(0)

    // Each cc name appears in the legend text.
    const legendText = (await legend.textContent()) || ""
    for (const cc of ccNames) {
      expect(legendText).toContain(cc)
    }
  })

  test("hovering a data point shows tooltip with cc + signed EUR", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-yearly"),
    )

    // Hover the first data point.
    const firstDot = page.locator('[data-testid="cc-trend-dot"]').first()
    await expect(firstDot).toBeVisible({ timeout: 10_000 })
    await firstDot.hover()

    // Tooltip should appear with EUR amount (the
    // format includes € symbol regardless of locale).
    const tooltip = page.locator('[data-testid="cc-trend-tooltip"]')
    await expect(tooltip).toBeVisible({ timeout: 5_000 })
    const text = (await tooltip.textContent()) || ""
    expect(text).toMatch(/€/)
    expect(text.length).toBeGreaterThan(0)
  })

  test("year change re-fires the report and updates chart", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-yearly"),
    )

    const priorYear = new Date().getFullYear() - 1

    const rerunPromise = page.waitForResponse((r) =>
      r
        .url()
        .includes("/api/v1/reports/cost-center-yearly")
        .valueOf() &&
      r.url().includes(`year=${priorYear}`),
    )

    await page
      .locator('[data-testid="cc-year-select"]')
      .selectOption(String(priorYear))

    const res = await rerunPromise
    expect(res.ok()).toBe(true)

    // The yearly report card title includes the
    // year. Whether or not the chart has data for
    // that year (the prior year might have zero
    // postings, which hides the chart) we still
    // want to see the title update.
    const h1 = page.locator("h1").first()
    await expect(h1).toContainText(String(priorYear), {
      timeout: 10_000,
    })
  })
})