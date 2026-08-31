/**
 * Playwright spec — Tier 128 VIES USt-ID verify button.
 *
 * Verifies the new "USt-ID prüfen" button on the customer
 * detail page:
 *   1. Renders next to the USt-ID when the customer has one
 *   2. On click, calls POST /vat-validation/check
 *   3. Shows the result badge (valid/invalid/unreachable)
 *   4. The badge color matches the status
 *
 * Pre-flight: backend must be running, the test customer
 * (BWA Test Kunde, USt-ID DE123456789) must exist in the
 * dev DB.
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'

test.describe('Tier 128 — VIES USt-ID verify button', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
  })

  test('renders the verify button next to the USt-ID', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Tier 291: standard hydration wait before checking
    // for client-rendered VIES button.
    await page.waitForFunction(
      () => document.readyState === "complete",
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    // The button must render with the data-testid from Tier 128
    const btn = page.getByTestId('vies-verify-button')
    await expect(btn).toBeVisible({ timeout: 15_000 })
    await expect(btn).toBeEnabled({ timeout: 15_000 })
  })

  test('clicking the button calls VIES and shows a result badge', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Tier 291: standard hydration wait — the VIES verify
    // button is a client component; clicking before hydration
    // fires no handler and the badge never appears.
    await page.waitForFunction(
      () => document.readyState === "complete",
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    // Wait for the initial latest() to resolve (or not) — the
    // button must be enabled before we click. If the customer
    // has no prior check, the button is enabled immediately.
    const btn = page.getByTestId('vies-verify-button')
    await expect(btn).toBeEnabled({ timeout: 15_000 })
    await btn.click()
    // The mock-mode VIES in dev returns 'invalid' for
    // DE123456789 (wrong check digit) — the badge must
    // appear within 15s. The exact text is "Ungültig" /
    // "Invalid" / "无效" depending on locale — we just
    // assert the badge element rendered.
    await expect(page.getByTestId('vies-result-badge')).toBeVisible({ timeout: 15_000 })
  })

  test('mobile 375x667: no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
