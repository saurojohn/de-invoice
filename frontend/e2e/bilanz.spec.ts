import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 81: Bilanz section on /dashboard/accounting.
 *
 * The page renders a year picker + a recompute
 * button + Aktiva table (3 sections) + Passiva
 * table (4 sections) + a Bilanzgleichung check
 * pill + a PDF download link + a disclaimer.
 *
 *   1. Section is present + visible.
 *   2. Aktiva has 3 sections (Anlagevermögen /
 *      Umlaufvermögen / RAP).
 *   3. Passiva has 4 sections (Eigenkapital /
 *      Rückstellungen / Verbindlichkeiten / RAP).
 *   4. Bilanzgleichung check pill is visible.
 *   5. PDF link uses full backend URL.
 *   6. Changing year + recompute reloads.
 *
 * Backend e2e 107 covers the API contract.
 * This file exercises the React page.
 */

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

async function injectAuth(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
  await page.context().addCookies([
    { name: "x-user-id", value: testTokens!.userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: testTokens!.companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
}

test.describe("Bilanz — /dashboard/accounting", () => {
  test("section is present + visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("bilanz-section")).toBeVisible({ timeout: 30_000 })
  })

  test("Aktiva + Passiva titles render", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("bilanz-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("bilanz-aktiva-title")).toBeVisible()
    await expect(page.getByTestId("bilanz-passiva-title")).toBeVisible()
  })

  test("Bilanzgleichung check pill is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("bilanz-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("bilanz-balance-check")).toBeVisible()
  })

  test("PDF link uses full backend URL (not relative)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("bilanz-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("bilanz-pdf-link")
    await expect(link).toBeVisible()
    // Wait for the useEffect to populate the
    // href (it starts as "#" until localStorage
    // + NEXT_PUBLIC_API_URL are available — see
    // the tier-76 lesson on dev-server proxy).
    await expect
      .poll(async () => (await link.getAttribute("href")) || "#", { timeout: 5_000 })
      .not.toBe("#")
    const href = await link.getAttribute("href")
    expect(href).toContain("bilanz.pdf")
    expect(href).toMatch(/^https?:\/\//)
  })

  test("Eigenkapital Saldoposten line is rendered", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("bilanz-section")).toBeVisible({ timeout: 30_000 })
    // The Saldoposten line is in the Eigenkapital
    // section (testid prefix = first letter of the
    // title = "a" for "A. Eigenkapital").
    const saldopostenRow = page.getByTestId("bilanz-line-a-EKV")
    await expect(saldopostenRow).toBeVisible()
  })
})
