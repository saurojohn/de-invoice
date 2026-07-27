import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[m.length - 1]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(`Auth cache ${AUTH_CACHE} missing — run backend e2e first`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

async function injectAuth(page: Page) {
  if (!testTokens) return
  const { userId, companyId } = testTokens
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
}

test.describe("Anlage AUS — /dashboard/accounting", () => {
  test("Anlage AUS section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-aus-section")).toBeVisible({ timeout: 30_000 })
  })

  test("year picker + PDF link are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-aus-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-aus-year-input")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("anlage-aus-pdf-link")).toBeVisible()
  })

  test("entries editor + add-row button are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-aus-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-aus-entries-editor")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("anlage-aus-add-row")).toBeVisible()
    await expect(page.getByTestId("anlage-aus-save")).toBeVisible()
  })

  test("BMF Vordruck table + summary block are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-aus-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-aus-vordruck-table")).toBeVisible({ timeout: 10_000 })
    // Spot-check key Kennziffern
    await expect(page.getByTestId("anlage-aus-5")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-aus-6")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-aus-13")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-aus-20")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-aus-summary")).toBeVisible()
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-aus-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-aus-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/anlage-aus\.pdf/,
      { timeout: 10_000 },
    )
  })
})
