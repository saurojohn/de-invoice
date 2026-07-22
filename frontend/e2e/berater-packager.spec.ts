import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 85: Anlage Steuererklärung packager
 * section on /dashboard/accounting.
 *
 * Top-of-page callout with year picker + a
 * "Berater-Paket herunterladen" button that
 * links to the full backend URL. Click
 * triggers a download of the multi-PDF ZIP.
 *
 *   1. Section is present + visible.
 *   2. Year input is visible.
 *   3. Download button is visible + has a
 *      full URL (not relative).
 *   4. Download URL contains berater-packager.
 *   5. Contents <details> element is visible.
 *   6. Disclaimer is visible.
 *
 * Backend e2e 111 covers the API contract.
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

test.describe("Berater-Paket — /dashboard/accounting", () => {
  test("section is present + visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("berater-packager-section")).toBeVisible({ timeout: 30_000 })
  })

  test("year input is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("berater-packager-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("berater-packager-year")).toBeVisible()
  })

  test("download button has full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("berater-packager-section")).toBeVisible({ timeout: 30_000 })
    // The download is an <a> tag wrapping the
    // <Button>. We grab the <a> via testid.
    const link = page.getByTestId("berater-packager-download")
    await expect(link).toBeVisible()
    await expect
      .poll(async () => (await link.getAttribute("href")) || "#", { timeout: 5_000 })
      .not.toBe("#")
    const href = await link.getAttribute("href")
    expect(href).toContain("berater-packager")
    expect(href).toMatch(/^https?:\/\//)
  })

  test("contents <details> element visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("berater-packager-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("berater-packager-contents")).toBeVisible()
  })

  test("disclaimer is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("berater-packager-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("berater-packager-disclaimer")).toBeVisible()
  })
})
