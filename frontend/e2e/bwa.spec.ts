import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 86 + 93: BWA tab on /dashboard/reports.
 *
 * The page renders a year/month picker + a
 * recompute button + a 14-line BWA table
 * (was 7 in tier 86, extended in tier 93)
 * with Monat/Vormonat/YTD/Vorjahres-YTD/Δ%
 * columns + a Betriebsergebnis footer +
 * Finanzergebnis / Steuern / Jahresergebnis
 * rows + PDF download + disclaimer.
 *
 *   1. Tab is clickable + BWA content visible.
 *   2. Year + month inputs visible.
 *   3. 14 standard BWA rows render
 *      (1000/1300/2000/3000/3100/3200/3300/
 *       3400/3500/3600/4100/4200/5000/5100).
 *   4. Betriebsergebnis footer visible.
 *   5. Jahresergebnis footer visible
 *      (tier 93: betr + fin - steuern).
 *   6. PDF link uses full backend URL.
 *   7. Disclaimer visible.
 *
 * Backend e2e 119 covers the API contract.
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

test.describe("BWA — /dashboard/reports", () => {
  test("BWA tab is present + clickable", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await expect(page.getByTestId("tab-bwa")).toBeVisible({ timeout: 30_000 })
  })

  test("clicking BWA tab shows BWA content", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-bwa").click()
    await expect(page.getByTestId("bwa-tab")).toBeVisible({ timeout: 30_000 })
  })

  test("year + month inputs visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-bwa").click()
    await expect(page.getByTestId("bwa-year")).toBeVisible()
    await expect(page.getByTestId("bwa-month")).toBeVisible()
  })

  test("14 standard BWA rows render (tier 93: 3200/3300/3400/3500/4100/5000/5100 added)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-bwa").click()
    await expect(page.getByTestId("bwa-tab")).toBeVisible({ timeout: 30_000 })
    // 14 standard buckets (tier 86 had 7; tier
    // 93 added 7 more for the full DATEV
    // breakdown).
    const buckets = [
      "1000", "1300", "2000", "3000", "3100",
      "3200", "3300", "3400", "3500", "3600",
      "4100", "4200", "5000", "5100",
    ]
    for (const bucket of buckets) {
      await expect(page.getByTestId(`bwa-row-${bucket}`)).toBeVisible()
    }
  })

  test("Betriebsergebnis footer visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-bwa").click()
    await expect(page.getByTestId("bwa-tab")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("bwa-betriebsergebnis-monat")).toBeVisible()
    await expect(page.getByTestId("bwa-betriebsergebnis-ytd")).toBeVisible()
  })

  test("Tier 93: Jahresergebnis footer visible (betr + fin - steuern)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-bwa").click()
    await expect(page.getByTestId("bwa-tab")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("bwa-jahresergebnis-monat")).toBeVisible()
    await expect(page.getByTestId("bwa-jahresergebnis-ytd")).toBeVisible()
    // Finanzergebnis + Steuern rows are the
    // intermediate tfoot rows.
    await expect(page.getByTestId("bwa-finanzergebnis-monat")).toBeVisible()
    await expect(page.getByTestId("bwa-finanzergebnis-ytd")).toBeVisible()
    await expect(page.getByTestId("bwa-steuern-monat")).toBeVisible()
    await expect(page.getByTestId("bwa-steuern-ytd")).toBeVisible()
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-bwa").click()
    await expect(page.getByTestId("bwa-tab")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("bwa-pdf-link")
    await expect(link).toBeVisible()
    await expect
      .poll(async () => (await link.getAttribute("href")) || "#", { timeout: 5_000 })
      .not.toBe("#")
    const href = await link.getAttribute("href")
    expect(href).toContain("bwa.pdf")
    expect(href).toMatch(/^https?:\/\//)
  })
})
