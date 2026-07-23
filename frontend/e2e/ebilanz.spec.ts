import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 88: E-Bilanz (XBRL) tab on
 * /dashboard/accounting.
 *
 * Exercises the React tab + download links.
 * The backend e2e 114 covers the API
 * contract + XML well-formedness; this file
 * checks the UI wiring.
 *
 *   1. Tab section is present on
 *      /dashboard/accounting.
 *   2. Year input visible + the
 *      computed/placeholder count summary
 *      renders.
 *   3. The mapping table has the expected
 *      4 section groups (Aktiva, Passiva,
 *      G+V, Sonstige).
 *   4. Download .xbrl link uses the full
 *      backend URL (tier-76 lesson — relative
 *      /api/v1/* paths hit Next.js dev and
 *      404).
 *   5. Download .pdf link uses the full
 *      backend URL.
 *   6. No console errors.
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

test("E-Bilanz tab section is present on /dashboard/accounting", async ({ page }) => {
  await injectAuth(page)
  await page.goto("/dashboard/accounting")
  // Wait for the accounting page to load.
  await expect(page.getByTestId("ebilanz-tab")).toBeVisible({ timeout: 30_000 })
})

test("year input visible + counts summary renders", async ({ page }) => {
  await injectAuth(page)
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("ebilanz-tab")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("ebilanz-year")).toBeVisible()
  // Counts summary is filled after the API
  // call resolves. Wait up to 10s.
  await expect(page.getByTestId("ebilanz-counts")).toBeVisible({ timeout: 10_000 })
})

test("mapping table has 4 section groups (Aktiva, Passiva, G+V, Sonstige)", async ({ page }) => {
  await injectAuth(page)
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("ebilanz-tab")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("ebilanz-table")).toBeVisible({ timeout: 10_000 })
  // The 4 section headers should be visible
  for (const section of ["bilanzAktiva", "bilanzPassiva", "guv", "sonstige"]) {
    await expect(
      page.getByTestId(`ebilanz-section-${section}`),
    ).toBeVisible({ timeout: 5_000 })
  }
})

test("Download .xbrl link uses full backend URL", async ({ page }) => {
  await injectAuth(page)
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("ebilanz-tab")).toBeVisible({ timeout: 30_000 })
  const link = page.getByTestId("ebilanz-download-xml")
  await expect(link).toBeVisible({ timeout: 10_000 })
  // Wait for the useEffect to populate
  // companyId from localStorage. The href
  // starts as "#" and updates to the full
  // URL once the client-side effect runs.
  await expect(link).toHaveAttribute(
    "href",
    /ebilanz\.xml\?companyId=.*&year=/,
    { timeout: 5_000 },
  )
  const href = await link.getAttribute("href")
  expect(href).toMatch(/^http:\/\/localhost:3001\/api\/v1\/accounting\/ebilanz\.xml/)
  expect(href).toContain("companyId=")
  expect(href).toContain("year=")
})

test("Download .pdf link uses full backend URL", async ({ page }) => {
  await injectAuth(page)
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("ebilanz-tab")).toBeVisible({ timeout: 30_000 })
  const link = page.getByTestId("ebilanz-download-pdf")
  await expect(link).toBeVisible({ timeout: 10_000 })
  await expect(link).toHaveAttribute(
    "href",
    /ebilanz\.pdf\?companyId=.*&year=/,
    { timeout: 5_000 },
  )
  const href = await link.getAttribute("href")
  expect(href).toMatch(/^http:\/\/localhost:3001\/api\/v1\/accounting\/ebilanz\.pdf/)
  expect(href).toContain("companyId=")
  expect(href).toContain("year=")
})

test("ebilanz page renders without console errors", async ({ page }) => {
  await injectAuth(page)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`)
  })
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("ebilanz-tab")).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  const real = errors.filter(
    (e) => !/hydrat/i.test(e) && !/deprecated/i.test(e) && !/favicon/i.test(e),
  )
  expect(real, `unexpected console errors: ${real.join("\n")}`).toEqual([])
})
