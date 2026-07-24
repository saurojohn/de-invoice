import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 76: Anlage EÜR (Einnahmen-Überschuss-Rechnung).
 *
 * The /dashboard/accounting page now has an EÜR
 * section at the bottom that calls
 * GET /api/v1/accounting/euer. Renders:
 *   - year input + "Berechnen" button
 *   - einnahmen table (Kz 4100-4190)
 *   - ausgaben table (Kz 4300-5900)
 *   - Gewinn/Verlust total
 *   - "Vom Steuerberater prüfen lassen" disclaimer
 *   - PDF download link
 *
 *   1. The EÜR section is present on the
 *      /dashboard/accounting page.
 *   2. Default load shows 4 revenue Kennziffern
 *      and 6 expense Kennziffern in the two tables.
 *   3. The Gewinn/Verlust total = einnahmenTotal
 *      − ausgabenTotal.
 *   4. Changing the year + clicking "Berechnen"
 *      reloads the data.
 *   5. The PDF link points to the right URL.
 *
 * Backend e2e 102 covers the API contract + PDF
 * byte-level check.
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
    {
      name: "x-user-id",
      value: testTokens!.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens!.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
}

test.describe("Anlage EÜR — /dashboard/accounting", () => {
  test("EÜR section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("euer-section")).toBeVisible({
      timeout: 30_000,
    })
    // Disclaimer is always visible
    await expect(page.getByTestId("euer-disclaimer")).toBeVisible()
  })

  test("default load shows 4 revenue Kz + 6 expense Kz", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    const revTable = page.getByTestId("euer-einnahmen-table")
    await expect(revTable).toBeVisible({ timeout: 30_000 })
    // 4 revenue Kennziffern
    const revRows = page.locator("[data-testid^='euer-rev-']")
    await expect(revRows).toHaveCount(4)
    // 6 expense Kennziffern
    const expRows = page.locator("[data-testid^='euer-exp-']")
    await expect(expRows).toHaveCount(6)
  })

  test("Gewinn/Verlust total = einnahmenTotal − ausgabenTotal", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("euer-gewinn")).toBeVisible({
      timeout: 30_000,
    })
    // Read the displayed total. The format is
    // "Gewinn: 1.234,56 €" or "Verlust: 1.234,56 €".
    const totalText = (await page.getByTestId("euer-gewinn").textContent()) || ""
    const parseEur = (s: string): number => {
      const cleaned = s.replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", ".")
      return Number(cleaned) || 0
    }
    // The total is just "Gewinn: X €" or "Verlust: X €"
    // — abs() the value to compare absolute amounts.
    const total = parseEur(totalText)
    // Scope h3 lookups to the euer-section so
    // other Anlage forms on /dashboard/accounting
    // (Anlage S, Anlage V, BWA, etc.) don't
    // confuse the parser. v1 flake fix: the
    // page-wide h3 query returned the FIRST
    // h3 on the page which was the wrong one
    // after tier 92+ added more sections.
    const euerSection = page.getByTestId("euer-section")
    const einnahmenText = (await euerSection.locator("h3").filter({ hasText: /Einnahmen|Betriebseinnahmen/ }).textContent()) || ""
    const ausgabenText = (await euerSection.locator("h3").filter({ hasText: /Ausgaben|Betriebsausgaben/ }).textContent()) || ""
    const einn = parseEur(einnahmenText)
    const ausg = parseEur(ausgabenText)
    const expectedGewinn = Math.abs(einn - ausg)
    expect(Math.abs(total - expectedGewinn)).toBeLessThan(0.5)
  })

  test("changing year + recompute reloads the data", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("euer-section")).toBeVisible({
      timeout: 30_000,
    })
    // Set year to 2025
    await page.getByTestId("euer-year").fill("2025")
    await page.getByTestId("euer-recompute").click()
    // The card title should update to show 2025
    await expect(
      page.getByTestId("euer-section").locator("h2, h3, [class*='CardTitle']").filter({ hasText: "2025" }),
    ).toBeVisible({ timeout: 10_000 })
  })

  test("PDF download link points to euer.pdf endpoint", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    // The PDF link's href is computed in a useEffect
    // (so localStorage is reliably available). Wait
    // for the href to be populated with the right
    // URL prefix — the useEffect runs synchronously
    // after mount, so a 2-second wait is plenty.
    const link = page.getByTestId("euer-pdf-link")
    await expect(link).toBeVisible({ timeout: 30_000 })
    await expect(link).toHaveAttribute(
      "href",
      /\/api\/v1\/accounting\/euer\.pdf\?companyId=.*&year=/,
      { timeout: 5_000 },
    )
    const href = await link.getAttribute("href")
    expect(href).toContain("/api/v1/accounting/euer.pdf")
    expect(href).toContain("companyId=")
    expect(href).toContain("year=")
  })
})
