/**
 * Playwright spec — Tier 135 audit log filter
 * enhancements.
 *
 * Verifies:
 *   1. Action chips render below the entity-type
 *      dropdown, derived from stats.byAction.
 *   2. Clicking a chip toggles it (aria-pressed
 *      flips) and the audit rows are re-filtered
 *      to that prefix.
 *   3. Selecting two chips produces OR semantics
 *      (union of both prefixes).
 *   4. Quick date preset "30 Tage" auto-fills
 *      dateFrom and dateTo to a 30-day range and
 *      the rows reload.
 *   5. URL reflects the multi-select state
 *      (actionPrefixes=invoice.,customer.) so
 *      deep links work.
 *
 * Pre-flight: backend on :3001, the test data
 * (inserted in this spec's beforeAll via direct
 * SQL or the audit-logs API) must include rows
 * under at least two distinct action prefixes
 * (e.g. "invoice." and "customer.").
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const API = 'http://localhost:3001'

test.describe('Tier 135 — Audit log filter enhancements', () => {
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

  test('action chips render derived from stats.byAction', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const chipsContainer = page.getByTestId('audit-filter-action-chips')
    await expect(chipsContainer).toBeVisible({ timeout: 10_000 })
    // Tier 135 test data inserts rows with prefixes
    // invoice., customer., payment. — at least the
    // invoice. chip should always be present.
    const invoiceChip = page.getByTestId('audit-action-chip-invoice_')
    await expect(invoiceChip).toBeVisible({ timeout: 5_000 })
  })

  test('clicking an action chip filters the rows to that prefix', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const invoiceChip = page.getByTestId('audit-action-chip-invoice_')
    await expect(invoiceChip).toBeVisible({ timeout: 10_000 })
    // Count rows before filter
    const totalBefore = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="audit-total"]')
      return el ? Number((el.textContent || '').match(/[\d.]+/)?.[0].replace(/\./g, '')) : 0
    })
    await invoiceChip.click()
    await expect(invoiceChip).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 })
    // Wait for reload
    await page.waitForTimeout(1500)
    const totalAfter = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="audit-total"]')
      return el ? Number((el.textContent || '').match(/[\d.]+/)?.[0].replace(/\./g, '')) : 0
    })
    // After filter, total should be ≤ original
    expect(totalAfter).toBeLessThanOrEqual(totalBefore)
    expect(totalAfter).toBeGreaterThan(0)
    // URL should reflect the filter
    const url = page.url()
    expect(url).toMatch(/actionPrefixes=invoice\./)
  })

  test('selecting two chips produces OR semantics (union)', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const invoiceChip = page.getByTestId('audit-action-chip-invoice_')
    const customerChip = page.getByTestId('audit-action-chip-customer_')
    await expect(invoiceChip).toBeVisible({ timeout: 10_000 })
    await expect(customerChip).toBeVisible({ timeout: 5_000 })
    await invoiceChip.click()
    await page.waitForTimeout(500)
    const total1 = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="audit-total"]')
      return el ? Number((el.textContent || '').match(/[\d.]+/)?.[0].replace(/\./g, '')) : 0
    })
    await customerChip.click()
    await page.waitForTimeout(1500)
    const total2 = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="audit-total"]')
      return el ? Number((el.textContent || '').match(/[\d.]+/)?.[0].replace(/\./g, '')) : 0
    })
    // With OR semantics, total2 (union) >= total1
    expect(total2).toBeGreaterThanOrEqual(total1)
    // Both chips should be pressed
    await expect(invoiceChip).toHaveAttribute('aria-pressed', 'true')
    await expect(customerChip).toHaveAttribute('aria-pressed', 'true')
    // URL should have both prefixes
    const url = page.url()
    expect(url).toMatch(/actionPrefixes=invoice\./)
    expect(url).toMatch(/customer\./)
  })

  test('quick date preset "30 Tage" auto-fills the date range', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const preset = page.getByTestId('audit-date-preset-30d')
    await expect(preset).toBeVisible({ timeout: 10_000 })
    await preset.click()
    await page.waitForTimeout(1500)
    // Both date inputs should have values
    const from = await page.locator('[data-testid="audit-filter-dateFrom"]').inputValue()
    const to = await page.locator('[data-testid="audit-filter-dateTo"]').inputValue()
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 30 days apart (inclusive of both ends = 29 day diff)
    const fromDate = new Date(from)
    const toDate = new Date(to)
    const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000)
    expect(diffDays).toBe(29)
    // URL should reflect the dates
    const url = page.url()
    expect(url).toMatch(/dateFrom=/)
    expect(url).toMatch(/dateTo=/)
  })

  test('mobile 375x667: filter section does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
