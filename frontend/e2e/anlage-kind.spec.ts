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

test.describe("Anlage Kind — /dashboard/accounting", () => {
  test("Anlage Kind section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kind-section"),
    ).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows the 2 tables (kindergeld + freibetrag)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kind-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-kind-einnahmen-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-kind-ausgaben-table"),
    ).toBeVisible({ timeout: 10_000 })

    // Spot-check key Kennziffern
    await expect(
      page.getByTestId("anlage-kind-6600"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-kind-6610"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-kind-6620"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-kind-6640"),
    ).toBeVisible({ timeout: 5_000 })
  })

  test("Summary block shows Kindergeld + Kinderfreibetrag amounts", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kind-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-kind-summary"),
    ).toBeVisible({ timeout: 10_000 })
    const text = (await page
      .getByTestId("anlage-kind-summary")
      .textContent()) || ""
    expect(text).toMatch(/Kindergeld/)
    expect(text).toMatch(/Kinderfreibetrag/)
    expect(text).toMatch(/€/)
  })

  test("Kinder editor modal opens with the add-Kind button", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kind-section"),
    ).toBeVisible({ timeout: 30_000 })
    // Click the edit-Kinder button
    await page.getByTestId("anlage-kind-edit-kinder").click()
    // The Kinder modal should appear with the add button
    await expect(
      page.getByTestId("kind-add"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("kind-save"),
    ).toBeVisible({ timeout: 5_000 })
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kind-section"),
    ).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-kind-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    // The pdfUrl useEffect runs on mount with localStorage
    // possibly empty; use toHaveAttribute for auto-retry.
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/anlage-kind\.pdf/,
      { timeout: 10_000 },
    )
  })
})
