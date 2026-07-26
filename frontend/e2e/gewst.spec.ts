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

test.describe("GewSt-Erklärung — /dashboard/accounting", () => {
  test("GewSt section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("gewst-section")).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows the BMF Vordruck table with 5 Kz rows", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("gewst-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("gewst-vordruck-table")).toBeVisible({ timeout: 10_000 })

    // Spot-check key Kennziffern
    await expect(page.getByTestId("gewst-5")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("gewst-7")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("gewst-10")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("gewst-11")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("gewst-12")).toBeVisible({ timeout: 5_000 })
  })

  test("4 Vorauszahlung inputs (Q1-Q4) are visible + save button", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("gewst-section")).toBeVisible({ timeout: 30_000 })
    for (const q of ["q1", "q2", "q3", "q4"]) {
      await expect(page.getByTestId(`gewst-vq-${q}`)).toBeVisible({ timeout: 5_000 })
    }
    await expect(page.getByTestId("gewst-save-vorauszahlungen")).toBeVisible()
  })

  test("Summary block shows Kz 10/11/12 amounts", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("gewst-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("gewst-summary")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("gewst-kz10")).toBeVisible()
    await expect(page.getByTestId("gewst-kz11")).toBeVisible()
    await expect(page.getByTestId("gewst-kz12")).toBeVisible()
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("gewst-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("gewst-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/gewst\.pdf/,
      { timeout: 10_000 },
    )
  })
})
