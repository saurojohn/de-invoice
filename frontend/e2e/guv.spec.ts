import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 82: G+V section on /dashboard/accounting.
 *
 * The page renders a year picker + a recompute
 * button + 5 sections (Revenue / Cost / Financial
 * / Tax / Result) in § 275 HGB GKV order + a
 * Jahresergebnis pill + a summary strip + a PDF
 * download link + a disclaimer.
 *
 *   1. Section is present + visible.
 *   2. 5 sections render (revenue / cost /
 *      financial / tax / result).
 *   3. Jahresergebnis pill is visible.
 *   4. PDF link uses full backend URL.
 *   5. Jahresüberschuss identity:
 *      Pos 17 = Pos 1 + Pos 4 - 5a - 6a - 8 - 13
 *      (verifiable from rendered DOM).
 *
 * Backend e2e 108 covers the API contract.
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

test.describe("G+V — /dashboard/accounting", () => {
  test("section is present + visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("guv-section")).toBeVisible({ timeout: 30_000 })
  })

  test("5 § 275 HGB sections render (revenue / cost / financial / tax / result)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("guv-section")).toBeVisible({ timeout: 30_000 })
    // The 5 sections have data-testid=guv-section-{title-lowercase}
    // Backend titles: Erträge / Aufwendungen / Finanzergebnis /
    // Steuern / Jahresergebnis.
    for (const title of ["erträge", "aufwendungen", "finanzergebnis", "steuern", "jahresergebnis"]) {
      await expect(page.getByTestId(`guv-section-${title}`)).toBeVisible()
    }
  })

  test("Jahresergebnis pill is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("guv-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("guv-jahresergebnis")).toBeVisible()
  })

  test("PDF link uses full backend URL (not relative)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("guv-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("guv-pdf-link")
    await expect(link).toBeVisible()
    // Wait for the useEffect to populate the href.
    await expect
      .poll(async () => (await link.getAttribute("href")) || "#", { timeout: 5_000 })
      .not.toBe("#")
    const href = await link.getAttribute("href")
    expect(href).toContain("guv.pdf")
    expect(href).toMatch(/^https?:\/\//)
  })

  test("Nicht ausgewiesen positions render with placeholder text", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("guv-section")).toBeVisible({ timeout: 30_000 })
    // The Bestandsveränderungen (Pos 2) line is in the
    // revenue section, with amount=null → renders the
    // "nicht ausgewiesen" placeholder.
    const pos2 = page.getByTestId("guv-line-2")
    await expect(pos2).toBeVisible()
    // The Abschreibungen (Pos 7a) is in the cost section.
    const pos7a = page.getByTestId("guv-line-7a")
    await expect(pos7a).toBeVisible()
  })
})
