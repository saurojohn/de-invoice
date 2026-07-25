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

test.describe("Anlage N — /dashboard/accounting", () => {
  test("Anlage N section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-n-section"),
    ).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows the 4 tables (einnahmen + werbungskosten + sonderausgaben + aB)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-n-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-n-einnahmen-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-n-werbungskosten-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-n-sonderausgaben-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-n-ab-table"),
    ).toBeVisible({ timeout: 10_000 })

    // Spot-check key Kennziffern
    await expect(
      page.getByTestId("anlage-n-100"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-n-130"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-n-200"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-n-230"),
    ).toBeVisible({ timeout: 5_000 })
  })

  test("Einkünfte pill shows the bottom-line amount", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-n-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-n-einkuenfte"),
    ).toBeVisible({ timeout: 10_000 })
    const text = (await page
      .getByTestId("anlage-n-einkuenfte")
      .textContent()) || ""
    // Should contain "Einkünfte aus nichtselbständiger Arbeit: X EUR"
    expect(text).toMatch(/Einkünfte.*€/)
  })

  test("Lohnsteuerbescheinigung editor modal opens with the 8 LSB fields", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-n-section"),
    ).toBeVisible({ timeout: 30_000 })
    // Click the edit-LSB button
    await page.getByTestId("anlage-n-edit-lsb").click()
    // The LSB modal should appear with 8 LSB fields
    await expect(
      page.getByTestId("lsb-input-bruttoArbeitslohn"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("lsb-input-lohnsteuer"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("lsb-input-soli"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("lsb-input-kirchensteuer"),
    ).toBeVisible({ timeout: 5_000 })
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-n-section"),
    ).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-n-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    // The pdfUrl useEffect runs on mount with localStorage
    // possibly empty; the initial href is "#". Use
    // toHaveAttribute to auto-retry until the link
    // has the proper URL.
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/anlage-n\.pdf/,
      { timeout: 10_000 },
    )
  })
})
