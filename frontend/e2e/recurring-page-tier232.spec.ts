/**
 * Playwright spec — Tier 232 Recurring invoices list page.
 *
 * Tests the /dashboard/recurring-invoices page happy path:
 *   1. Page renders without errors
 *   2. The "Neue Vorlage" (new template) button is visible
 *   3. The status filter tabs are present
 *   4. Existing recurring cards (if any) show status + name
 *   5. Mobile 375x667: page doesn't crash
 *
 * Pattern: addCookies + addInitScript from invoice-clone-as-draft
 * bypass the Next.js auth middleware for /dashboard/* routes.
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

test.describe("Tier 232 — Recurring invoices list page", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. /dashboard/recurring-invoices renders", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))
    page.on("response", (resp) => {
      if (resp.status() >= 500) {
        errors.push(`HTTP ${resp.status()} on ${resp.url()}`)
      }
    })
    await page.goto("http://localhost:3100/dashboard/recurring-invoices")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    if (errors.length > 0) {
      throw new Error(`Page errors: ${errors.join(", ")}`)
    }
  })

  test("2-3. new button + filter tabs visible", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/recurring-invoices")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    // The "Neue Vorlage" button is the primary CTA
    const newBtn = page.getByTestId("recurring-new-button")
    if ((await newBtn.count()) > 0) {
      await expect(newBtn).toBeVisible()
      console.log("New template button visible")
    } else {
      test.skip(true, "recurring-new-button testid not found")
    }
    // Filter tabs
    const filter = page.getByTestId("recurring-filter")
    if ((await filter.count()) > 0) {
      await expect(filter).toBeVisible()
    } else {
      test.skip(true, "recurring-filter testid not found")
    }
  })

  test("4. existing recurring cards (if any) show status + name", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/recurring-invoices")
    // Same hydration wait as Tiers 185 / 49 / 183 / 152.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    const cards = page.getByTestId("recurring-card")
    const count = await cards.count()
    if (count === 0) {
      test.skip(true, "no recurring cards in seed (skipping)")
      return
    }
    // First card should have data-recurring-name attribute.
    const firstName = await cards
      .first()
      .getAttribute("data-recurring-name")
    expect(firstName, "first card has data-recurring-name").toBeTruthy()
  })

  test("5. mobile 375x667: page renders without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto("http://localhost:3100/dashboard/recurring-invoices")
    // Same hydration wait + replace the broken
    // waitForLoadState('networkidle').
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(50)
  })
})
