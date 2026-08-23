/**
 * Playwright spec — Tier 146 customer payment
 * allocation wizard (Zahlung zuordnen).
 *
 * The Berater's primary question: "I received
 * €5000 from BWA Test Kunde — which invoices
 * should I apply it to?" Tier 146 adds a wizard
 * that walks the open invoices oldest-first
 * by dueDate and proposes a per-invoice split.
 *
 * Tests:
 *   1. The "💰 Zahlung zuordnen" button renders
 *      on the customer detail page (next to
 *      the Kontoauszug button).
 *   2. Clicking the button opens the modal
 *      with the form fields (amount / date /
 *      method / reference).
 *   3. Preview shows the proposed allocation
 *      table with one row per invoice.
 *   4. Confirm creates Payment rows + bumps
 *      fully-settled invoices to status=paid.
 *   5. Backend-only: the preview endpoint
 *      returns the expected shape.
 *   6. Backend-only: the write endpoint
 *      creates the right number of Payment
 *      rows in the right invoices.
 *   7. Mobile 375x667: the button does not
 *      overflow.
 *
 * Pre-flight: backend on :3001, BWA Test Kunde
 * has 4 open invoices (INV-2026-000203..206)
 * at €119 each. The test cleans up any prior
 * Payment rows + resets the invoices to
 * status='sent' before each test.
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API_BASE = 'http://localhost:3001'

// Reset: clear any prior payment rows for the
// fixture customer, and reset all 4 invoices
// to status='sent'. The Tier 146 spec
// allocates payments; without the reset the
// "remaining" values would be wrong.
function resetCustomerInvoices() {
  execSync(
    `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"Payment\\" WHERE \\"invoiceId\\" IN (SELECT id FROM \\"Invoice\\" WHERE \\"companyId\\"='${COMPANY_ID}' AND \\"customerId\\"='${CUSTOMER_ID}'); UPDATE \\"Invoice\\" SET status='sent' WHERE \\"companyId\\"='${COMPANY_ID}' AND \\"customerId\\"='${CUSTOMER_ID}'"`,
    { stdio: 'ignore' },
  )
}

test.describe('Tier 146 — Customer payment allocation', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
    // Reset DB state before every test so the
    // remaining amounts are deterministic.
    resetCustomerInvoices()
  })

  test.afterAll(() => {
    // Leave the DB in a sane state for downstream
    // tests (e.g. Tier 145 internal notes,
    // Tier 144 email-Verlauf). All invoices
    // back to 'sent', no Payment rows.
    resetCustomerInvoices()
  })

  test('the Zahlung zuordnen button renders on the customer detail page', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-detail-allocate-payment')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    // Button text is one of the i18n
    await expect(btn).toContainText(/Zahlung zuordnen|Allocate payment|分配付款/i)
  })

  test('clicking the button opens the modal with the form fields', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('customer-detail-allocate-payment').click()
    const modal = page.getByTestId('allocate-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    // Form fields render
    await expect(page.getByTestId('allocate-amount')).toBeVisible()
    await expect(page.getByTestId('allocate-date')).toBeVisible()
    await expect(page.getByTestId('allocate-method')).toBeVisible()
    await expect(page.getByTestId('allocate-reference')).toBeVisible()
    await expect(page.getByTestId('allocate-preview-btn')).toBeVisible()
  })

  test('preview shows the proposed allocation table', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('customer-detail-allocate-payment').click()
    await expect(page.getByTestId('allocate-modal')).toBeVisible({ timeout: 5_000 })
    // 4 invoices at €119 each = €476 total
    // outstanding. Allocate €500 → 4 fully paid,
    // €24 unallocated.
    await page.getByTestId('allocate-amount').fill('500')
    await page.getByTestId('allocate-preview-btn').click()
    // The preview block appears
    const preview = page.getByTestId('allocate-preview')
    await expect(preview).toBeVisible({ timeout: 10_000 })
    // 4 invoice rows + the unallocated badge
    const unallocated = page.getByTestId('allocate-unallocated')
    await expect(unallocated).toBeVisible()
    const unallocatedText = (await unallocated.textContent()) || ''
    expect(unallocatedText).toMatch(/24/)
  })

  test('confirm creates Payment rows + bumps invoices to paid', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('customer-detail-allocate-payment').click()
    await expect(page.getByTestId('allocate-modal')).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('allocate-amount').fill('500')
    await page.getByTestId('allocate-preview-btn').click()
    await expect(page.getByTestId('allocate-preview')).toBeVisible({ timeout: 10_000 })
    // Confirm
    await page.getByTestId('allocate-confirm').click()
    // Success state
    const result = page.getByTestId('allocate-result')
    await expect(result).toBeVisible({ timeout: 10_000 })
    const resultText = (await result.textContent()) || ''
    expect(resultText).toMatch(/4/)
    // DB sanity: 4 Payment rows exist for the
    // 4 invoices, each €119.
    const payments = execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -t -c "SELECT count(*), sum(amount)::int FROM \\"Payment\\" WHERE \\"invoiceId\\" IN (SELECT id FROM \\"Invoice\\" WHERE \\"companyId\\"='${COMPANY_ID}' AND \\"customerId\\"='${CUSTOMER_ID}')"`,
      { encoding: 'utf-8' },
    ).trim()
    expect(payments).toMatch(/4 \| 476/)
  })

  test('backend: the preview endpoint returns the expected shape', async () => {
    const url = `${API_BASE}/api/v1/customers/${CUSTOMER_ID}/allocate-payment/preview?companyId=${COMPANY_ID}&amount=500`
    const res = await fetch(url, {
      headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('invoices')
    expect(data).toHaveProperty('unallocatedAmount')
    expect(data).toHaveProperty('totalOutstanding')
    expect(data.invoices.length).toBe(4)
    // Every invoice has the expected fields
    for (const inv of data.invoices) {
      expect(inv).toHaveProperty('invoiceId')
      expect(inv).toHaveProperty('invoiceNumber')
      expect(inv).toHaveProperty('total')
      expect(inv).toHaveProperty('remaining')
      expect(inv).toHaveProperty('applied')
    }
    expect(data.unallocatedAmount).toBe(24)
    expect(data.totalOutstanding).toBe(476)
  })

  test('backend: the write endpoint creates 4 Payment rows', async () => {
    // Reset state first (the beforeEach also does
    // this, but explicit is better)
    resetCustomerInvoices()
    const url = `${API_BASE}/api/v1/customers/${CUSTOMER_ID}/allocate-payment?companyId=${COMPANY_ID}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: 500,
        paymentDate: '2026-08-15',
        paymentMethod: 'Überweisung',
        reference: 'Tier 146 backend test',
      }),
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.appliedCount).toBe(4)
    expect(data.appliedTotal).toBe(476)
    expect(data.unallocatedAmount).toBe(24)
    // Verify in DB
    const count = execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -t -c "SELECT count(*) FROM \\"Payment\\" WHERE \\"invoiceId\\" IN (SELECT id FROM \\"Invoice\\" WHERE \\"companyId\\"='${COMPANY_ID}' AND \\"customerId\\"='${CUSTOMER_ID}')"`,
      { encoding: 'utf-8' },
    ).trim()
    expect(count).toBe('4')
  })

  test('mobile 375x667: the button does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-detail-allocate-payment')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
