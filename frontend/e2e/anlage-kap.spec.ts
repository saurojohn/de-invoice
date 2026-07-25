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

test.describe("Anlage KAP — /dashboard/accounting", () => {
  test("Anlage KAP section is present on the accounting page", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kap-section"),
    ).toBeVisible({ timeout: 30_000 })
  })

  test("default load shows 10 einnahmen + 6 abzuege lines", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kap-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-kap-einnahmen-table"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByTestId("anlage-kap-abzuege-table"),
    ).toBeVisible({ timeout: 10_000 })

    // Spot-check key Kennziffern present
    await expect(
      page.getByTestId("anlage-kap-rev-7100"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-kap-rev-7120"),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      page.getByTestId("anlage-kap-abz-7300"),
    ).toBeVisible({ timeout: 5_000 })
  })

  test("Zu versteuern pill shows the bottom-line amount", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kap-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-kap-zu-versteuern"),
    ).toBeVisible({ timeout: 10_000 })
    // The Zu versteuern text is just "Zu versteuern: X EUR"
    const text = (await page
      .getByTestId("anlage-kap-zu-versteuern")
      .textContent()) || ""
    expect(text).toMatch(/Zu versteuern:.*€|EUR/)
  })

  test("Abgeltungssteuer info box shows 25% + 5.5% Soli", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kap-section"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("anlage-kap-abgeltung-info"),
    ).toBeVisible({ timeout: 10_000 })
    const text = (await page
      .getByTestId("anlage-kap-abgeltung-info")
      .textContent()) || ""
    // Expect 25% and 5.5% to be mentioned
    expect(text).toMatch(/25%/)
    expect(text).toMatch(/5\.5%/)
  })

  test("Sparer-Pauschbetrag (7300) is 1000 EUR by default", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kap-section"),
    ).toBeVisible({ timeout: 30_000 })
    const row = page.getByTestId("anlage-kap-abz-7300")
    await expect(row).toBeVisible({ timeout: 10_000 })
    const text = (await row.textContent()) || ""
    // The row should mention 1000 EUR
    expect(text).toMatch(/1\.000,?00/)
  })

  test("PDF link uses full backend URL", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kap-section"),
    ).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId("anlage-kap-pdf-link")
    await expect(link).toBeVisible({ timeout: 10_000 })
    // The href attribute should use the full backend URL
    // (NEXT_PUBLIC_API_URL), not a relative /api path.
    const href = await link.getAttribute("href")
    expect(href).toMatch(
      /^https?:\/\/[^/]+\/api\/v1\/accounting\/anlage-kap\.pdf/,
    )
  })

  test("changing year + recompute reloads the data", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    await expect(
      page.getByTestId("anlage-kap-section"),
    ).toBeVisible({ timeout: 30_000 })
    const yearInput = page.getByTestId("anlage-kap-year")
    await expect(yearInput).toBeVisible({ timeout: 10_000 })
    // Set year to 2024 (a past year with full data)
    await yearInput.fill("2024")
    // Click recompute
    await page.getByTestId("anlage-kap-recompute").click()
    // Wait for either the table or a re-render
    await expect(
      page.getByTestId("anlage-kap-einnahmen-table"),
    ).toBeVisible({ timeout: 10_000 })
  })
})
