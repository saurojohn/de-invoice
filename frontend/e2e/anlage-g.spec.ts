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
  // Tier 12 lesson: middleware reads cookies
  // (not localStorage) for the SSR-side
  // auth gate. Set both the cookie (for the
  // middleware) and localStorage (for the
  // client-side apiGet wrapper). Without
  // the cookie, /dashboard/* 307s to /login
  // before the React tree ever renders.
  await page.context().addCookies([
    {
      name: "x-user-id",
      value: userId,
      domain: "localhost",
      path: "/",
    },
    {
      name: "x-company-id",
      value: companyId,
      domain: "localhost",
      path: "/",
    },
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

test.describe("Anlage G — /dashboard/accounting", () => {
  test("Anlage G section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-g-section"),
    ).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows the 4 tables (einnahmen + ausgaben + hinzu + kurzungen)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-g-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-g-einnahmen-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-g-ausgaben-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-g-hinzu-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-g-kurzungen-table"),
    ).toBeVisible({ timeout: 10_000 })

    // Spot-check key Kennziffern present
    await expect(
      page.getByTestId("anlage-g-2110"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-g-2200"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-g-4100"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-g-5100"),
    ).toBeVisible({ timeout: 5_000 })
  })

  test("Gewinn/Verlust pill shows the bottom-line amount", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-g-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-g-gewinn"),
    ).toBeVisible({ timeout: 10_000 })
    // The Gewinn/Verlust text is "Gewinn: X EUR" or "Verlust: X EUR"
    const text = (await page
      .getByTestId("anlage-g-gewinn")
      .textContent()) || ""
    expect(text).toMatch(/Gewinn:.*€|Verlust:.*€/)
  })

  test("Gewerbeertrag + Gewerbesteuer-Schätzung block shows 3.5% × Hebesatz 400", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-g-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-g-gewerbeertrag"),
    ).toBeVisible({ timeout: 10_000 })
    const text = (await page
      .getByTestId("anlage-g-gewerbeertrag")
      .textContent()) || ""
    // Expect Steuermesszahl 3.5% and Hebesatz 400%.
    // The toFixed(1) in the source produces "3.5 %"
    // (period, not comma — JavaScript Intl NumberFormat
    // with de-DE style would use comma, but our explicit
    // `.toFixed(1)` keeps the period).
    expect(text).toMatch(/3\.5 %/)
    expect(text).toMatch(/400 %/)
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-g-section"),
    ).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-g-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    // The href attribute should use the full backend URL
    // (NEXT_PUBLIC_API_URL), not a relative /api path. The
    // pdfUrl useEffect runs on mount; the value is "#"
    // when companyId is not yet in localStorage. Use
    // toHaveAttribute to auto-retry until the link has
    // the proper URL.
    await expect(link).toHaveAttribute(
      "href",
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/anlage-g\.pdf/,
      { timeout: 10_000 },
    )
  })
})
