import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
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

test.describe("UStJA — /dashboard/accounting", () => {
  test("UStJA section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows the monthly + vordruck tables", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("ustja-monthly-table")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("ustja-vordruck-table")).toBeVisible({ timeout: 10_000 })

    // Spot-check key Kennziffern
    await expect(page.getByTestId("ustja-66")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("ustja-67")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("ustja-68")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("ustja-39")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("ustja-69")).toBeVisible({ timeout: 5_000 })
  })

  test("Summary block shows Kz 66/67/68/69 amounts", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("ustja-summary")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("ustja-kz66")).toBeVisible()
    await expect(page.getByTestId("ustja-kz67")).toBeVisible()
    await expect(page.getByTestId("ustja-kz68")).toBeVisible()
    await expect(page.getByTestId("ustja-kz69")).toBeVisible()
  })

  test("12 monthly rows are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    for (let m = 1; m <= 12; m++) {
      await expect(page.getByTestId(`ustja-month-${m}`)).toBeVisible({ timeout: 5_000 })
    }
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("ustja-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    // The pdfUrl useEffect runs on mount with localStorage
    // possibly empty; use toHaveAttribute for auto-retry.
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/ustva\/ustja\.pdf/,
      { timeout: 10_000 },
    )
  })
})
