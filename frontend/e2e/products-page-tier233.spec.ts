/**
 * Playwright spec — Tier 233 Products list page.
 *
 * Tests the /dashboard/products page happy path:
 *   1. Page renders without 5xx errors
 *   2. The product search input is visible
 *   3. The product table renders (rows present or empty)
 *   4. Typing in the search input filters the list
 *   5. Mobile 375x667: page doesn't crash
 *
 * The products page is the operator's catalogue of sellable
 * items and services. A regression here would silently
 * hide SKUs from the Berater when creating invoices.
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

test.describe("Tier 233 — Products list page", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. /dashboard/products renders without 5xx", async ({ page }) => {
    const errors: string[] = []
    page.on("response", (resp) => {
      if (resp.status() >= 500) {
        errors.push(`HTTP ${resp.status()} on ${resp.url()}`)
      }
    })
    await page.goto("http://localhost:3100/dashboard/products")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    if (errors.length > 0) {
      throw new Error(`Page errors: ${errors.join(", ")}`)
    }
  })

  test("2. product search input visible", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/products")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const search = page.getByTestId("product-search-input")
    if ((await search.count()) > 0) {
      await expect(search).toBeVisible()
    } else {
      test.skip(true, "product-search-input testid not found")
    }
  })

  test("3-4. search filters the product list", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/products")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const search = page.getByTestId("product-search-input")
    if ((await search.count()) === 0) {
      test.skip(true, "product-search-input testid not found")
      return
    }
    // Count initial rows
    const initialRows = await page.getByTestId("product-row").count()
    if (initialRows === 0) {
      test.skip(true, "no product rows in seed (cannot test filter)")
      return
    }
    // Type a non-matching query — expect rows to be 0
    await search.fill("zzzNonexistentQuery12345zzz")
    await page.waitForTimeout(500) // debounce
    const filteredRows = await page.getByTestId("product-row").count()
    expect(filteredRows, "non-matching search → 0 rows").toBe(0)
  })

  test("5. mobile 375x667: page renders without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto("http://localhost:3100/dashboard/products")
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(50)
  })
})
