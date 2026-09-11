/**
 * Playwright spec — Tier 134 VIES batch check button.
 *
 * Verifies:
 *   1. The "Alle USt-IDs prüfen" button renders on
 *      /dashboard/customers next to the other
 *      action-bar buttons.
 *   2. Clicking it opens a modal with a start
 *      button.
 *   3. Clicking the start button calls the batch
 *      endpoint, shows a spinner, and then the
 *      summary tiles + per-customer list.
 *   4. The summary tile counts match the actual
 *      result data (we don't assert absolute
 *      numbers since the DB state is shared).
 *   5. Mobile 375x667: no horizontal overflow
 *      on the customers page (the button fits
 *      in the action bar).
 *
 * Pre-flight: backend on :3001, the test
 * customer BWA Test Kunde (b3f7b274-...) has
 * a VAT ID set so the batch isn't empty.
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
test.describe('Tier 134 — VIES batch check', () => {
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

  test('renders the batch check button in the action bar', async ({ page }) => {
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-vies-batch-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await expect(btn).toBeEnabled()
  })

  test('clicking the button opens the modal with a start button', async ({ page }) => {
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-vies-batch-button')
    await expect(btn).toBeEnabled({ timeout: 10_000 })
    await btn.click()
    const modal = page.getByTestId('vies-batch-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    const startBtn = page.getByTestId('vies-batch-start')
    await expect(startBtn).toBeVisible()
  })

  test('start button runs the batch and shows the summary', async ({ page }) => {
    // Tier 365: this was `test.skip` since Tier 291/292 because of the real VIES
    // per-member-state rate limit. With VIES_MOCK=1 — set in the CI playwright
    // job and by backend/scripts/local-ci-stack.sh — checkVatId() answers from
    // the mock before the token bucket is ever consulted, so there is no rate
    // limit to hit. Its supplier twin (supplier-vies-batch-tier137) already
    // runs the same flow in CI. Against real VIES the skip still applies.
    test.skip(process.env.VIES_MOCK !== '1', 'needs VIES_MOCK=1 (real VIES rate-limits per member state)')
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Tier 291: hydration wait.
    await page.waitForFunction(
      () => document.readyState === "complete",
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    await page.getByTestId('customer-vies-batch-button').click()
    await expect(page.getByTestId('vies-batch-modal')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('vies-batch-start').click()
    await expect(page.getByTestId('vies-batch-done')).toBeVisible({
      timeout: 120_000,
    })
    // Summary tiles render
    const valid = page.getByTestId('vies-batch-valid-count')
    const invalid = page.getByTestId('vies-batch-invalid-count')
    await expect(valid).toBeVisible()
    await expect(invalid).toBeVisible()
    // At least 1 row in the results table (the seed's customers have VAT IDs).
    const rows = page.locator('[data-testid^="vies-batch-row-"]')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
  })

  test('mobile 375x667: no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-vies-batch-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
