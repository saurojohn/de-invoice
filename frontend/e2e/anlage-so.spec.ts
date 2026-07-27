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

test.describe("Anlage SO — /dashboard/accounting", () => {
  test("Anlage SO section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-so-section")).toBeVisible({ timeout: 30_000 })
  })

  test("year picker + PDF link are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-so-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-so-year-input")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("anlage-so-pdf-link")).toBeVisible()
  })

  test("transactions editor + wiederkehrende inputs are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-so-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-so-transactions-editor")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("anlage-so-wiederkehrende-editor")).toBeVisible()
    await expect(page.getByTestId("anlage-so-bezuege-input")).toBeVisible()
    await expect(page.getByTestId("anlage-so-werbungskosten-input")).toBeVisible()
    await expect(page.getByTestId("anlage-so-save")).toBeVisible()
  })

  test("BMF Vordruck table + summary block are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-so-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-so-vordruck-table")).toBeVisible({ timeout: 10_000 })
    // Spot-check key Kennziffern
    await expect(page.getByTestId("anlage-so-32")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-so-41")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-so-20")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-so-11")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("anlage-so-summary")).toBeVisible()
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-so-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-so-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/anlage-so\.pdf/,
      { timeout: 10_000 },
    )
  })
})
