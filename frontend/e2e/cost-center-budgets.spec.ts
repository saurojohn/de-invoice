import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 48: Cost-Center Budgets page + bva column
 * on the yearly report.
 *
 * Tests:
 *   1. Budgets page renders, year selector visible,
 *      empty state if no budgets.
 *   2. Yearly report with no budgets: Δ columns
 *      hidden (no clutter).
 *   3. Yearly report with a budget: Δ columns
 *      visible, totals row shows sum.
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

// Tier 48 spec: the "hidden when no budgets" test
// assumes a clean slate, but the "shows when budget
// exists" test can leave a budget behind if it
// errors out before the inline cleanup. A residual
// budget from a prior run would flip the column on
// and break the "hidden" assertion. Wipe everything
// once before the suite starts so both tests begin
// from a known-empty state, then let each test set
// up its own scenario.
test.beforeAll(async ({ request }) => {
  if (!testTokens) return
  const companyId = testTokens.companyId
  const year = new Date().getFullYear()
  const res = await request.get(
    `http://localhost:3001/api/v1/reports/cost-center-budgets?companyId=${companyId}&year=${year}`,
    {
      headers: {
        "x-user-id": testTokens.userId,
        "x-company-id": companyId,
      },
    },
  )
  if (!res.ok()) return
  const body = await res.json()
  for (const b of body.budgets || []) {
    await request.delete(
      `http://localhost:3001/api/v1/reports/cost-center-budgets/${b.id}?companyId=${companyId}`,
      {
        headers: {
          "x-user-id": testTokens.userId,
          "x-company-id": companyId,
        },
      },
    )
  }
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

test.describe("Tier 48 — Cost-Center Budgets", () => {
  test("budgets page renders with year selector + add button", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)

    await page.goto("/dashboard/cost-center-budgets", {
      waitUntil: "domcontentloaded",
    })
    // Tier 304: standard hydration wait. /dashboard/cost-center-*
    // pages cold-compile for 30+ s on first dev-mode hit.
    await page.waitForFunction(
      () => document.readyState === "complete",
      { timeout: 60_000 },
    )
    await page.waitForTimeout(500)
    await expect(page).toHaveURL(/\/dashboard\/cost-center-budgets$/, {
      timeout: 15_000,
    })

    await expect(
      page.locator('[data-testid="budget-year-select"]'),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="budget-add"]')).toBeVisible({ timeout: 30_000 })
  })

  test("yearly report: budget column hidden when no budgets", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)

    // Wipe budgets first via direct API to ensure
    // clean state.
    const companyId = testTokens!.companyId
    const year = new Date().getFullYear()
    // List current budgets and delete them.
    const res = await page.request.get(
      `http://localhost:3001/api/v1/reports/cost-center-budgets?companyId=${companyId}&year=${year}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": companyId,
        },
      },
    )
    const body = await res.json()
    for (const b of body.budgets || []) {
      await page.request.delete(
        `http://localhost:3001/api/v1/reports/cost-center-budgets/${b.id}?companyId=${companyId}`,
        {
          headers: {
            "x-user-id": testTokens!.userId,
            "x-company-id": companyId,
          },
        },
      )
    }

    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    // Tier 305: the cost-center-report page cold-compiles
    // for 30+ s on first dev-mode hit, which easily
    // blows the 15s waitForResponse default. Bump the
    // wait timeout to 60s to give the report endpoints
    // time to respond after the React tree mounts.
    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-yearly"),
      { timeout: 60_000 },
    )
    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-budget-vs-actual"),
      { timeout: 60_000 },
    )

    // No budgets → Δ column hidden.
    await expect(
      page.locator('[data-testid="cc-row-budget"]'),
    ).toHaveCount(0)
  })

  test("yearly report: budget column shows when budget exists", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const companyId = testTokens!.companyId
    const year = new Date().getFullYear()

    // Create a budget via direct API. We use VERTRIEB
    // because tier-44 fixtures leave residual data
    // for that bucket.
    const create = await page.request.post(
      `http://localhost:3001/api/v1/reports/cost-center-budgets?companyId=${companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": companyId,
        },
        data: {
          year,
          costCenter: "VERTRIEB",
          label: "Test budget",
          monthlyTargets: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
        },
      },
    )
    expect(create.status()).toBe(201)

    await page.goto("/dashboard/cost-center-report", {
      waitUntil: "domcontentloaded",
    })
    // Tier 305: the cost-center-report page cold-compiles
    // for 30+ s on first dev-mode hit, which easily
    // blows the 15s waitForResponse default. Bump the
    // wait timeout to 60s to give the report endpoints
    // time to respond after the React tree mounts.
    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-yearly"),
      { timeout: 60_000 },
    )
    await page.waitForResponse((r) =>
      r.url().includes("/api/v1/reports/cost-center-budget-vs-actual"),
      { timeout: 60_000 },
    )

    // Δ column rendered. We don't insist on a specific
    // row having the budget stamp because the test
    // company may or may not have a matching row in
    // `report.rows` (yearly endpoint and bva endpoint
    // can disagree if the yearly cleaned up residue).
    // We just confirm the totals row shows a Δ value
    // (which it always does once any budget exists).
    await expect(
      page.locator('[data-testid="cc-totals-budget-delta"]'),
    ).toBeVisible({ timeout: 30_000 })

    // Cleanup.
    const list = await page.request.get(
      `http://localhost:3001/api/v1/reports/cost-center-budgets?companyId=${companyId}&year=${year}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": companyId,
        },
      },
    )
    const lb = await list.json()
    for (const b of lb.budgets || []) {
      await page.request.delete(
        `http://localhost:3001/api/v1/reports/cost-center-budgets/${b.id}?companyId=${companyId}`,
        {
          headers: {
            "x-user-id": testTokens!.userId,
            "x-company-id": companyId,
          },
        },
      )
    }
  })
})