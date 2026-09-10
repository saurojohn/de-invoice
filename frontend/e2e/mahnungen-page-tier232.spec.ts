/**
 * Playwright spec — Tier 232 Mahnungen (Reminders) list page.
 *
 * Tests the /dashboard/mahnungen page happy path:
 *   1. Page renders without 5xx errors
 *   2. The settings (Einstellungen) button is visible
 *   3. The status filter tabs are present
 *   4. The table or empty state is shown
 *   5. Mobile 375x667: page doesn't crash
 *
 * The Mahnung page is the Berater's main "who owes me money
 * and how late" view. A regression here would silently hide
 * overdue invoices from the operator.
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

test.describe("Tier 232 — Mahnungen (Reminders) list page", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. /dashboard/mahnungen renders without 5xx", async ({ page }) => {
    const errors: string[] = []
    page.on("response", (resp) => {
      if (resp.status() >= 500) {
        errors.push(`HTTP ${resp.status()} on ${resp.url()}`)
      }
    })
    await page.goto("http://localhost:3100/dashboard/mahnungen")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    if (errors.length > 0) {
      throw new Error(`Page errors: ${errors.join(", ")}`)
    }
  })

  test("2-3. settings button + filter tabs visible", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/mahnungen")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const settingsBtn = page.getByTestId("mahnung-settings-button")
    await expect(settingsBtn).toBeVisible({ timeout: 15000 })
    const filterTabs = page.getByTestId("mahnung-filter-tabs")
    await expect(filterTabs).toBeVisible({ timeout: 15000 })
  })

  test("4. table or empty state is shown", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/mahnungen")
    // Tier 341: the empty-state div is only rendered
    // when (!loading && !error && rows.length === 0).
    // On a cold-compiled Next.js dev server, the page
    // mounts with loading=true and doesn't switch to
    // false until the /reminders API roundtrip lands
    // (200-500ms locally, 1-2s on cold CI). Wait for
    // either the table or the empty state to actually
    // appear in the DOM, with a 15s ceiling.
    await expect(
      page.locator('[data-testid="mahnhistorie-table"], [data-testid="mahnhistorie-empty"]').first(),
    ).toBeVisible({ timeout: 15_000 })
    // Either the table or the empty state must be present.
    const table = page.getByTestId("mahnhistorie-table")
    const empty = page.getByTestId("mahnhistorie-empty")
    const tableCount = await table.count()
    const emptyCount = await empty.count()
    expect(tableCount + emptyCount, "table or empty state present").toBeGreaterThan(0)
  })

  test("5. mobile 375x667: page renders without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto("http://localhost:3100/dashboard/mahnungen")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(50)
  })
})
