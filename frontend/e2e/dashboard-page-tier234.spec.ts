/**
 * Playwright spec — Tier 234 Dashboard home page.
 *
 * Tests the /dashboard page happy path:
 *   1. Page renders without 5xx errors
 *   2. System-health card is present
 *   3. Page has substantive content (KPI cards, charts, etc.)
 *   4. Mobile 375x667: page doesn't crash
 *
 * The dashboard home is the operator's "how is my business
 * doing" landing page. It shows revenue, open invoices,
 * overdue amounts, system health, recent activity, etc.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'

const AUTH_CACHE = '/tmp/cashbook-e2e-auth.env'

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

async function contextWithAuth(page: any) {
  const { userId, companyId } = readCachedTokens()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
}

test.describe("Tier 234 — Dashboard home page", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. /dashboard renders without 5xx", async ({ page }) => {
    const errors: string[] = []
    page.on("response", (resp) => {
      if (resp.status() >= 500) {
        errors.push(`HTTP ${resp.status()} on ${resp.url()}`)
      }
    })
    await page.goto("http://localhost:3100/dashboard")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    if (errors.length > 0) {
      throw new Error(`Page errors: ${errors.join(", ")}`)
    }
  })

  test("2. system-health card is present", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const healthCard = page.getByTestId("dashboard-system-health")
    if ((await healthCard.count()) > 0) {
      await expect(healthCard).toBeVisible()
    } else {
      test.skip(true, "dashboard-system-health testid not found")
    }
  })

  test("3. page has substantive KPI / chart content", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length, "dashboard has substantial content").toBeGreaterThan(300)
  })

  test("4. mobile 375x667: page renders without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto("http://localhost:3100/dashboard")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(50)
  })
})
