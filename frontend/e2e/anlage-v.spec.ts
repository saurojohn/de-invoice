import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 92: Anlage V section on /dashboard/accounting.
 *
 * Einkünfte aus Vermietung und Verpachtung
 * (§ 21 EStG). The page renders a year picker
 * + a recompute button + two Kennziffer tables
 * (Einnahmen + Werbungskosten) + an
 * Überschuss/Verlust pill + a PDF download
 * link + a disclaimer + an AfA source badge.
 *
 *   1. Section is present + visible.
 *   2. Einnahmen + Werbungskosten tables both
 *      have the right number of Kennziffer
 *      rows (4 + 9).
 *   3. Überschuss pill is visible.
 *   4. AfA source badge is visible (booked /
 *      computed / nicht_gebucht).
 *   5. PDF link uses full backend URL.
 *
 * Backend e2e 118 covers the API contract.
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

test.describe("Anlage V — /dashboard/accounting", () => {
  test("section is present + visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-v-section")).toBeVisible({ timeout: 30_000 })
  })

  test("Einnahmen + Werbungskosten tables render the right number of Kennziffer rows", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-v-section")).toBeVisible({ timeout: 30_000 })
    // 4 Einnahmen Kennziffern (8100, 8120, 8135, 8190)
    const revRows = page.locator("[data-testid^='anlage-v-rev-']")
    await expect(revRows).toHaveCount(4)
    // 9 Werbungskosten Kennziffern (8600-8690)
    const expRows = page.locator("[data-testid^='anlage-v-exp-']")
    await expect(expRows).toHaveCount(9)
  })

  test("Überschuss / Verlust pill is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-v-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-v-ueberschuss")).toBeVisible()
  })

  test("AfA source badge is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-v-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-v-afa-source-badge")).toBeVisible()
  })

  test("PDF link uses full backend URL (not relative)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-v-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-v-pdf-link")
    await expect(link).toBeVisible()
    // Wait for the useEffect to populate the
    // href (it starts as "#" until localStorage
    // + NEXT_PUBLIC_API_URL are available — see
    // the tier-76 lesson on dev-server proxy).
    await expect
      .poll(async () => (await link.getAttribute("href")) || "#", { timeout: 5_000 })
      .not.toBe("#")
    const href = await link.getAttribute("href")
    expect(href).toContain("anlage-v.pdf")
    expect(href).toMatch(/^https?:\/\//)
  })

  test("disclaimer is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-v-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-v-disclaimer")).toBeVisible()
  })
})
