/**
 * Playwright spec — Tier 141 bulk-send-by-filter button.
 *
 * The new endpoint POST /api/v1/invoices/bulk-send-by-filter
 * chains findForExport + bulkSendEmails so the user can
 * email ALL invoices in a date range (with type/status
 * filter) in one click — no need to tick rows one by one.
 *
 * UI: a new "📧 E-Mails senden" button in the date-range
 * export bar (the green pill that appears when dateFrom or
 * dateTo is set, next to CSV / ZIP (PDF) / ZIP (ZUGFeRD)).
 *
 * Tests:
 *   1. Button is hidden when no date range is set.
 *   2. Button renders when dateFrom is set.
 *   3. Clicking the button + accepting the confirm() dialog
 *      shows the bulk-send progress modal with total /
 *      succeeded / failed tiles.
 *   4. Mobile 375x667: no horizontal overflow with the
 *      new 4th button in the export bar.
 *
 * Pre-flight: backend on :3001, at least one invoice
 * in the 2026-01-01..2026-12-31 range (Tier 133 fixture
 * INV-2026-000203..000206 are seeded by the global-setup).
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
test.describe('Tier 141 — Bulk-send-by-filter', () => {
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

  test('button is hidden when no date range is set', async ({ page }) => {
    await page.goto('/dashboard/invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Wait for the table to load (otherwise the date-range bar
    // conditional `dateFrom || dateTo` would be 0/false even
    // if the user already filled the inputs but they're
    // reflected through setDateFrom; this is a state-only test).
    await page.waitForTimeout(500)
    await expect(page.getByTestId('bulk-send-range')).toHaveCount(0)
  })

  test('button renders in the date-range export bar when dateFrom is set', async ({ page }) => {
    await page.goto('/dashboard/invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Fill the date-from input. The export bar appears whenever
    // dateFrom OR dateTo is non-empty.
    const dateFromInput = page.locator('input[type="date"]').first()
    await expect(dateFromInput).toBeVisible({ timeout: 10_000 })
    await dateFromInput.fill('2026-01-01')
    // Now the green bar should be visible + our new button inside.
    const btn = page.getByTestId('bulk-send-range')
    await expect(btn).toBeVisible({ timeout: 5_000 })
    await expect(btn).toContainText(/E-Mails senden|Send emails|发送邮件/i)
  })

  test('clicking the button (confirm=accept) shows the progress modal', async ({ page }) => {
    await page.goto('/dashboard/invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const dateFromInput = page.locator('input[type="date"]').first()
    await expect(dateFromInput).toBeVisible({ timeout: 10_000 })
    await dateFromInput.fill('2026-01-01')
    const btn = page.getByTestId('bulk-send-range')
    await expect(btn).toBeVisible({ timeout: 5_000 })
    // Auto-accept the "send N invoices?" confirm.
    page.on('dialog', (d) => d.accept().catch(() => {}))
    await btn.click()
    // The progress modal opens; we wait for the results tile
    // (total > 0) to confirm the POST round-trip succeeded.
    const modal = page.getByTestId('bulk-send-modal')
    await expect(modal).toBeVisible({ timeout: 15_000 })
    const total = page.getByTestId('bulk-send-total')
    await expect(total).toBeVisible({ timeout: 15_000 })
    // The Tier 133 fixtures seeded 4 invoices in this range;
    // we just assert total > 0 to stay robust against future
    // fixture additions.
    const totalText = (await total.textContent()) || '0'
    expect(Number(totalText)).toBeGreaterThan(0)
  })

  test('mobile 375x667: export bar (4 buttons) does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const dateFromInput = page.locator('input[type="date"]').first()
    await expect(dateFromInput).toBeVisible({ timeout: 10_000 })
    await dateFromInput.fill('2026-01-01')
    // Wait for the export bar to render + new button
    const btn = page.getByTestId('bulk-send-range')
    await expect(btn).toBeVisible({ timeout: 5_000 })
    await page.waitForTimeout(800)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
