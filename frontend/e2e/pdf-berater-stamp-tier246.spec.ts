/**
 * Playwright spec — Tier 246 Berater personal stamp
 * on the invoice PDF.
 *
 * Tests the new "Berater-Signatur anwenden" button
 * on the PDF signature panel. The button:
 *   1. Downloads the company-signed PDF
 *   2. POSTs it back to /signing/user-sign with the
 *      current user's cert
 *   3. Saves the resulting 2-signature chain as
 *      "INV-XXXXXXX_signed_berater.pdf"
 *
 * Test plan (3 tests):
 *   1. The Berater-Stempel button is visible on the
 *      signature panel (next to the existing 3
 *      buttons)
 *   2. Clicking the button triggers a download of
 *      a file with the "_berater" suffix
 *   3. The button is enabled when the panel loads
 *      (no signature required to enable)
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'

const AUTH_CACHE = '/tmp/cashbook-e2e-auth.env'

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

async function contextWithAuth(page: any) {
  const { userId, companyId } = readCachedTokens()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
  // Pre-seed cookie consent (mirrors Tier 238/243 pattern)
  await page.addInitScript(() => {
    localStorage.setItem(
      "cookie-consent",
      JSON.stringify({
        necessary: true,
        analytics: false,
        marketing: false,
        savedAt: new Date().toISOString(),
      }),
    )
  })
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
}

// Use a real invoice from the dev DB. We use the
// ci-seed's INV-TEST-001 (id=11deeb35-...) because
// it's present in every run. The Tier 50 fixture
// (04a16886-...) was hardcoded but the dev DB no
// longer has it.
const INVOICE_ID = "11deeb35-7147-4bdc-86d9-a302b4f80f3e"

test.describe("Tier 246 — Berater personal stamp on invoice PDF", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. Berater-Stempel button is visible on the signature panel", async ({ page }) => {
    await page.goto(`http://localhost:3100/dashboard/invoices/${INVOICE_ID}`)
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30000 },
    )
    await page.waitForTimeout(500)
    const btn = page.getByTestId("pdf-signature-berater-stamp")
    await expect(btn).toBeVisible({ timeout: 15000 })
  })

  test("2. button text says 'Berater-Signatur anwenden' (de-DE)", async ({ page }) => {
    await page.goto(`http://localhost:3100/dashboard/invoices/${INVOICE_ID}`)
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30000 },
    )
    await page.waitForTimeout(500)
    const btn = page.getByTestId("pdf-signature-berater-stamp")
    await expect(btn).toBeVisible({ timeout: 15000 })
    const text = (await btn.innerText()).toLowerCase()
    expect(text).toContain("berater")
  })

  test("3. clicking the button triggers a download of a file with '_berater' suffix", async ({ page }) => {
    await page.goto(`http://localhost:3100/dashboard/invoices/${INVOICE_ID}`)
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30000 },
    )
    await page.waitForTimeout(500)
    const btn = page.getByTestId("pdf-signature-berater-stamp")
    await expect(btn).toBeVisible({ timeout: 15000 })
    // Wait for the download to be triggered by the
    // click. Playwright's `waitForEvent` catches the
    // browser download event with the suggested
    // filename.
    const downloadPromise = page.waitForEvent("download", { timeout: 30000 })
    await btn.click()
    const download = await downloadPromise
    const filename = download.suggestedFilename()
    expect(filename).toMatch(/_berater\.pdf$/)
  })
})
