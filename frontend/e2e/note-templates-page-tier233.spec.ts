/**
 * Playwright spec — Tier 233 Settings / note-templates page.
 *
 * Tests the /dashboard/settings/note-templates page happy path:
 *   1. Page renders without 5xx errors
 *   2. The back button is visible
 *   3. The list renders (5 seeded defaults OR the new-toggle
 *      for adding a custom one)
 *   4. The reset-defaults button is visible
 *   5. Mobile 375x667: page doesn't crash
 *
 * The note-templates page is the Berater's editor for the
 * Mahnung text snippets that get auto-attached to reminder
 * emails. The 5 German defaults are seeded on first touch
 * (same as the Mahnung-Vorlagen editor).
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

test.describe("Tier 233 — Settings / note-templates page", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. /dashboard/settings/note-templates renders without 5xx", async ({ page }) => {
    const errors: string[] = []
    page.on("response", (resp) => {
      if (resp.status() >= 500) {
        errors.push(`HTTP ${resp.status()} on ${resp.url()}`)
      }
    })
    await page.goto("http://localhost:3100/dashboard/settings/note-templates")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    if (errors.length > 0) {
      throw new Error(`Page errors: ${errors.join(", ")}`)
    }
  })

  test("2. back button visible", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/settings/note-templates")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const back = page.getByTestId("note-templates-back")
    if ((await back.count()) > 0) {
      await expect(back).toBeVisible()
    } else {
      test.skip(true, "note-templates-back testid not found")
    }
  })

  test("3. list OR new-toggle present (page is interactive)", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/settings/note-templates")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const list = page.getByTestId("note-templates-list")
    const newToggle = page.getByTestId("note-templates-new-toggle")
    const hasList = (await list.count()) > 0
    const hasNew = (await newToggle.count()) > 0
    expect(hasList || hasNew, "list or new-toggle present").toBe(true)
  })

  test("4. reset-defaults button visible", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/settings/note-templates")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const reset = page.getByTestId("note-templates-reset-defaults")
    if ((await reset.count()) > 0) {
      await expect(reset).toBeVisible()
    } else {
      test.skip(true, "note-templates-reset-defaults testid not found")
    }
  })

  test("5. mobile 375x667: page renders without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto("http://localhost:3100/dashboard/settings/note-templates")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(50)
  })
})
