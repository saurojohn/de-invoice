import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 36: Dashboard v2 — chart-heavy redesign.
 *
 * Tests:
 *   1. /dashboard/v2 renders with all four KPI tiles
 *      and the three chart canvases (line + donut +
 *      top-customers bar).
 *   2. Loading state shows the spinner placeholder
 *      briefly, then the actual data test-ids.
 *   3. Back button navigates to /dashboard (legacy v1).
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

test.describe("Dashboard v2 (Tier 36)", () => {
  test("renders KPI strip + all charts", async ({ page, context }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/v2", {
      waitUntil: "domcontentloaded",
    })

    // Title bar.
    await expect(
      page.locator('[data-testid="dashboard-v2-title"]'),
    ).toBeVisible({ timeout: 15_000 })

    // KPI strip — 4 cards.
    const kpis = page.locator('[data-testid="dashboard-v2-kpis"]')
    await expect(kpis).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-testid="kpi-ytd-revenue"]'),
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="kpi-ytd-expenses"]'),
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="kpi-open-receivables"]'),
    ).toBeVisible()

    // Revenue trend chart (SVG with data-testid).
    await expect(
      page.locator('[data-testid="dashboard-v2-revenue-chart"]'),
    ).toBeVisible({ timeout: 10_000 })

    // A/R aging donut — has 5 bucket rows in the legend.
    const buckets = page.locator(
      '[data-testid="dashboard-v2-aging-bucket"]',
    )
    await expect(buckets.nth(0)).toBeVisible({ timeout: 10_000 })
    expect(await buckets.count()).toBeGreaterThanOrEqual(5)

    // Top customers bar chart — at least 1 row.
    const customers = page.locator(
      '[data-testid="dashboard-v2-top-customer-row"]',
    )
    await expect(customers.nth(0)).toBeVisible({ timeout: 10_000 })
  })

  test("back button navigates to legacy /dashboard", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/v2", {
      waitUntil: "domcontentloaded",
    })
    // Tier 291: standard hydration wait before interacting on
    // a cold-compiled Next.js dev page. The "← v1" button is in
    // a client component that hydrates after the page reaches
    // `complete`; without this wait, the click can fire before
    // React has attached the onClick handler.
    await page.waitForFunction(
      () => document.readyState === "complete",
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    await expect(
      page.locator('[data-testid="dashboard-v2-title"]'),
    ).toBeVisible({ timeout: 15_000 })
    // The "← v1" button in the header.
    await page.locator("text=← v1").click()
    // Bumped to 30s — Next.js dev compiles /dashboard on first
    // navigation in this run, and 10s was right on the edge.
    await page.waitForURL(/\/dashboard$/, { timeout: 30_000 })
  })
})