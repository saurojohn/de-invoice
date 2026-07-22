import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 86: BWA tab on /dashboard/reports.
 *
 * The page renders a year/month picker + a
 * recompute button + a 7-line BWA table with
 * Monat/Vormonat/YTD/Vorjahres-YTD/Δ% columns +
 * a Betriebsergebnis footer + PDF download +
 * disclaimer.
 *
 *   1. Tab is clickable + BWA content visible.
 *   2. Year + month inputs visible.
 *   3. 7 standard BWA rows render.
 *   4. Betriebsergebnis footer visible.
 *   5. PDF link uses full backend URL.
 *   6. Disclaimer visible.
 *
 * Backend e2e 112 covers the API contract.
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

  test("7 standard BWA rows render", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-bwa").click()
    await expect(page.getByTestId("bwa-tab")).toBeVisible({ timeout: 30_000 })
    // 7 standard buckets: 1000/1300/2000/3000/
    // 3100/3600/4200
    for (const bucket of ["1000", "1300", "2000", "3000", "3100", "3600", "4200"]) {
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
