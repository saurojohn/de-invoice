/**
 * Playwright spec — Tier 234 Accounting overview page.
 *
 * Tests the /dashboard/accounting page happy path:
 *   1. Page renders without 5xx errors
 *   2. Page has substantive content (the accounting tab list)
 *   3. Mobile 375x667: page doesn't crash
 *
 * The accounting page is the Berater's main Buchhaltung
 * entry point — links to BWA, Bilanz, GuV, UStVA, Anlage
 * S/V, E-Bilanz, DATEV export, voucher list, journal, etc.
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

test.describe("Tier 234 — Accounting overview page", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. /dashboard/accounting renders without 5xx", async ({ page }) => {
    const errors: string[] = []
    page.on("response", (resp) => {
      if (resp.status() >= 500) {
        errors.push(`HTTP ${resp.status()} on ${resp.url()}`)
      }
    })
    await page.goto("http://localhost:3100/dashboard/accounting")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    if (errors.length > 0) {
      throw new Error(`Page errors: ${errors.join(", ")}`)
    }
  })

  test("2. page has substantive content (accounting links)", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/accounting")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const bodyText = await page.locator("body").innerText()
    // The accounting page should have substantial content
    // (BWA, Bilanz, GuV, UStVA, etc. links)
    expect(bodyText.length, "accounting page has content").toBeGreaterThan(200)
  })

  test("3. mobile 375x667: page renders without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto("http://localhost:3100/dashboard/accounting")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(50)
  })
})
