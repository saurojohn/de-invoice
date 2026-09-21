import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

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

async function injectAuth(page: Page) {
  if (!testTokens) return
  const { userId, companyId } = testTokens
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
}

test.describe("UStJA — /dashboard/accounting", () => {
  test("UStJA section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows the monthly + vordruck tables", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("ustja-monthly-table")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("ustja-vordruck-table")).toBeVisible({ timeout: 10_000 })

    // Tier 417: the rows carry the USt 2 A 2026 Kennzahlen (19 % = Kz 177).
    // The invented "Kz 66/67/68/39/69" total rows are gone — on the form
    // Kz 66 does not exist in the annual return and 68/69/39 are not totals.
    // A row per non-zero Kennzahl, or the empty-state row.
    const table = page.getByTestId("ustja-vordruck-table")
    await expect(table.locator("tbody tr").first()).toBeVisible({ timeout: 10_000 })
    for (const legacy of ["66", "67", "68", "39", "69", "81", "20"]) {
      await expect(page.getByTestId(`ustja-${legacy}`)).toHaveCount(0)
    }
  })

  test("Summary block shows Umsatzsteuer / Vorsteuer / Zahllast / Abschlusszahlung", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("ustja-summary")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("ustja-total-umsatzsteuer")).toBeVisible()
    await expect(page.getByTestId("ustja-total-vorsteuer")).toBeVisible()
    await expect(page.getByTestId("ustja-total-zahllast")).toBeVisible()
    await expect(page.getByTestId("ustja-total-abschlusszahlung")).toBeVisible()
  })

  test("12 monthly rows are visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    for (let m = 1; m <= 12; m++) {
      await expect(page.getByTestId(`ustja-month-${m}`)).toBeVisible({ timeout: 5_000 })
    }
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("ustja-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    // The pdfUrl useEffect runs on mount with localStorage
    // possibly empty; use toHaveAttribute for auto-retry.
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/ustva\/ustja\.pdf/,
      { timeout: 10_000 },
    )
  })

  test("ELSTER XML link uses full backend URL (Tier 107)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(page.getByTestId("ustja-section")).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("ustja-elster-xml-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/ustva\/ustja\/elster-xml\?.*download=1/,
      { timeout: 10_000 },
    )
  })
})
