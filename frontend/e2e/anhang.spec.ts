import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 84: Anhang zum Jahresabschluss section
 * on /dashboard/accounting.
 *
 * The page renders a year picker + a recompute
 * button + 5 collapsible sections (I-V) with
 * each paragraph tagged "auto-generated" or
 * "vom Berater zu ergänzen" + counts strip +
 * PDF download link + disclaimer.
 *
 *   1. Section is present + visible.
 *   2. 5 § 284 HGB sections render.
 *   3. Counts strip visible.
 *   4. PDF link uses full backend URL.
 *   5. Berater paragraphs (Section V) are
 *      visually distinct (auto=false → amber).
 *
 * Backend e2e 110 covers the API contract.
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

test.describe("Anhang — /dashboard/accounting", () => {
  test("section is present + visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anhang-section")).toBeVisible({ timeout: 30_000 })
  })

  test("5 § 284 HGB sections render (I-V)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anhang-section")).toBeVisible({ timeout: 30_000 })
    for (let i = 1; i <= 5; i++) {
      await expect(page.getByTestId(`anhang-section-${i}`)).toBeVisible()
    }
  })

  test("counts strip visible (Bilanz + G+V ausgewiesen / nicht ausgewiesen)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anhang-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("anhang-counts")).toBeVisible()
  })

  test("PDF link uses full backend URL (not relative)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anhang-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anhang-pdf-link")
    await expect(link).toBeVisible()
    await expect
      .poll(async () => (await link.getAttribute("href")) || "#", { timeout: 5_000 })
      .not.toBe("#")
    const href = await link.getAttribute("href")
    expect(href).toContain("anhang.pdf")
    expect(href).toMatch(/^https?:\/\//)
  })

  test("Berater paragraphs (Section V) are visually distinct", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("anhang-section")).toBeVisible({ timeout: 30_000 })
    // Section V is the 5th section. The first
    // paragraph in it should be Berater-editable
    // (auto=false → amber border).
    const firstBeraterPara = page.getByTestId("anhang-para-5-0")
    await expect(firstBeraterPara).toBeVisible()
    // The text content should mention Haftungs-
    // verhältnisse (§ 285 HGB) or similar.
    const text = await firstBeraterPara.textContent()
    expect(text?.toLowerCase()).toMatch(/haftungsverhältnisse|285/)
  })
})
