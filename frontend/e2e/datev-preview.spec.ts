import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 69: DATEV-Export Preview UI.
 *
 * The /dashboard/reports page now has a
 * "DATEV-Export" tab. Clicking it shows a
 * "Vorschau" button that hits the new
 * /reports/datev-preview endpoint. The user
 * sees header info, totals, per-account
 * summary, first 5 rows, and any validation
 * issues — before they download the CSV.
 *
 * Backend e2e 96 covers the API contract.
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
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing — run backend e2e first`,
    )
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
      value: testTokens.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
}

test.describe("DATEV-Export Preview", () => {
  test("DATEV tab renders + preview button loads the data", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    // Switch to the DATEV tab.
    await page.getByTestId("tab-datev").click()
    await expect(page.getByTestId("datev-tab")).toBeVisible({
      timeout: 10_000,
    })
    // The Vorschau button is present.
    await expect(page.getByTestId("datev-preview-btn")).toBeVisible()
    // The download buttons are present.
    await expect(page.getByTestId("datev-download-csv-btn")).toBeVisible()
    await expect(page.getByTestId("datev-download-bundle-btn")).toBeVisible()

    // Click Vorschau — the preview fetches in <2s.
    await page.getByTestId("datev-preview-btn").click()
    // The header card renders Berater-Nr + Mandanten-Nr.
    await expect(page.getByTestId("datev-header-card")).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId("datev-beraterNr")).not.toHaveText("")
    await expect(page.getByTestId("datev-mandantenNr")).not.toHaveText("")
    // The row count is non-zero (SH Leder has 1000+
    // paid invoices from prior tiers).
    const rc = await page.getByTestId("datev-rowCount").textContent()
    const n = parseInt((rc || "0").replace(/[^\d]/g, ""), 10)
    expect(n, "rowCount > 100").toBeGreaterThan(100)
    // The balance line shows the Soll/Haben check.
    await expect(page.getByTestId("datev-balance")).toBeVisible()
  })

  test("preview shows per-account table + first rows", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-datev").click()
    await expect(page.getByTestId("datev-tab")).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId("datev-preview-btn").click()
    // The per-account summary table is visible.
    await expect(page.getByTestId("datev-byAccount")).toBeVisible({
      timeout: 10_000,
    })
    // The first-rows preview table is visible.
    await expect(page.getByTestId("datev-firstRows")).toBeVisible()
  })

  test("issues card is shown when there are validation issues", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports")
    await page.getByTestId("tab-datev").click()
    await expect(page.getByTestId("datev-tab")).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId("datev-preview-btn").click()
    // The preview fetches in <2s. The issues card
    // is conditional — it only appears when the
    // issues array is non-empty. For the SH Leder
    // seed data we know there's at least one
    // "Betrag ≤ 0" warning from earlier expense
    // fixtures, so the card must be visible.
    await expect(page.getByTestId("datev-issues-card")).toBeVisible({
      timeout: 10_000,
    })
    // The first issue row is visible.
    await expect(page.getByTestId("datev-issue").first()).toBeVisible()
  })
})
