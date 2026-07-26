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

test.describe("KSt 1 — /dashboard/accounting", () => {
  test("KSt 1 section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("kst1-section"),
    ).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows the Jahresüberschuss + Korrekturen table", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("kst1-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("kst1-jahresueberschuss"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("kst1-korrekturen-table"),
    ).toBeVisible({ timeout: 10_000 })

    // Spot-check key Korrektur Kz present
    await expect(
      page.getByTestId("kst1-30"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("kst1-50"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("kst1-80"),
    ).toBeVisible({ timeout: 5_000 })
  })

  test("KSt + Soli + GewSt blocks render the computed amounts", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("kst1-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("kst1-kst-block"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("kst1-soli-block"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("kst1-gewst-block"),
    ).toBeVisible({ timeout: 10_000 })
  })

  test("KSt-Anrechnung block shows 3.8 × Messbetrag cap", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("kst1-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("kst1-anrechnung-block"),
    ).toBeVisible({ timeout: 10_000 })
    const text = (await page
      .getByTestId("kst1-anrechnung-block")
      .textContent()) || ""
    // Expect "3,8 × Messbetrag" in the text
    expect(text).toMatch(/3[,.]8/)
  })

  test("Zu zahlen pill shows the bottom-line amount", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("kst1-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("kst1-zu-zahlen"),
    ).toBeVisible({ timeout: 10_000 })
    const text = (await page
      .getByTestId("kst1-zu-zahlen")
      .textContent()) || ""
    expect(text).toMatch(/Zu zahlen.*€/)
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("kst1-section"),
    ).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("kst1-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    // The pdfUrl useEffect runs on mount with localStorage
    // possibly empty; use toHaveAttribute for auto-retry.
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/kst1\.pdf/,
      { timeout: 10_000 },
    )
  })
})
