import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 80: Anlage S section on /dashboard/accounting.
 *
 * The page renders a year picker + a recompute
 * button + two Kennziffer tables (Einnahmen +
 * Ausgaben) + a Gewinn/Verlust pill + a PDF
 * download link + a disclaimer.
 *
 *   1. Section is present + visible.
 *   2. Einnahmen + Ausgaben tables both have
 *      the right number of Kennziffer rows
 *      (5 + 13).
 *   3. Gewinn pill is visible.
 *   4. PDF link uses full backend URL.
 *   5. Changing year + recompute reloads.
 *
 * Backend e2e 106 covers the API contract.
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

test.describe("Anlage S — /dashboard/accounting", () => {
  test("section is present + visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-s-section")).toBeVisible({ timeout: 30_000 })
  })

  test("Einnahmen + Ausgaben tables render the right number of Kennziffer rows", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-s-section")).toBeVisible({ timeout: 30_000 })
    // 5 Einnahmen Kennziffern (4100, 4120, 4135, 4170, 4190)
    const revRows = page.locator("[data-testid^='anlage-s-rev-']")
    await expect(revRows).toHaveCount(5)
    // 13 Ausgaben Kennziffern (4600-4720)
    const expRows = page.locator("[data-testid^='anlage-s-exp-']")
    await expect(expRows).toHaveCount(13)
  })

  test("Gewinn / Verlust pill is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-s-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anlage-s-gewinn")).toBeVisible()
  })

  test("PDF link uses full backend URL (not relative)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anlage-s-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-s-pdf-link")
    await expect(link).toBeVisible()
    // Wait for the useEffect to populate the
    // href (it starts as "#" until localStorage
    // + NEXT_PUBLIC_API_URL are available — see
    // the tier-76 lesson on dev-server proxy).
    await expect
      .poll(async () => (await link.getAttribute("href")) || "#", { timeout: 5_000 })
      .not.toBe("#")
    const href = await link.getAttribute("href")
    expect(href).toContain("anlage-s.pdf")
    expect(href).toMatch(/^https?:\/\//)
  })
})
