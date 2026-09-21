/**
 * Playwright spec — Tier 415: the invoice form's live totals match the invoice.
 *
 * The form's VAT was computed on the lines before the invoice discount, so
 * 1 000 € at 10 % off showed "USt 190,00 / Gesamt 1.090,00" while the invoice
 * it created said 171,00 / 1.071,00. The form now uses the backend's
 * arithmetic (src/lib/invoice-amounts.ts; backend spec 204 checks the copy).
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId

test.describe('Tier 415 — invoice form totals', () => {
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

  test('a 10 % discount lowers the VAT in the summary', async ({ page }) => {
    await page.goto('/dashboard/invoices/create', { waitUntil: 'domcontentloaded' })
    const price = page.getByTestId('item-unit-price').first()
    await expect(price).toBeVisible({ timeout: 15_000 })
    // A fill that lands before hydration is reset by React (measured: the
    // summary stayed 0,00), so fill-and-check is retried as one step.
    await expect(async () => {
      await price.fill('1000')
      await page.getByTestId('discount-percent').fill('10')
      await expect(page.getByTestId('summary-subtotal')).toContainText('1.000,00', { timeout: 1_000 })
      await expect(page.getByTestId('discount-percent')).toHaveValue('10', { timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await expect(page.getByTestId('summary-vat')).toContainText('171,00')
    await expect(page.getByTestId('summary-total')).toContainText('1.071,00')
  })

  test('amounts are rounded to cents per rate', async ({ page }) => {
    await page.goto('/dashboard/invoices/create', { waitUntil: 'domcontentloaded' })
    const qty = page.getByTestId('item-quantity').first()
    await expect(qty).toBeVisible({ timeout: 15_000 })
    // 3 × 33,33 = 99,99; 19 % = 18,9981 → 19,00; total 118,99
    await expect(async () => {
      await qty.fill('3')
      await page.getByTestId('item-unit-price').first().fill('33.33')
      await expect(page.getByTestId('summary-subtotal')).toContainText('99,99', { timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await expect(page.getByTestId('summary-vat')).toContainText('19,00')
    await expect(page.getByTestId('summary-total')).toContainText('118,99')
  })
})
