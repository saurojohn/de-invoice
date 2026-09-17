/**
 * Playwright spec — Tier 413: the invoice detail page states the discount.
 *
 * `subtotal` is the line sum *before* the invoice-level discount, so the
 * totals card read "Zwischensumme 1.000,00 / Umsatzsteuer 171,00 /
 * Gesamtbetrag 1.071,00" — three numbers that do not add up, with the 100 €
 * reduction shown nowhere. The PDF had the same defect (backend spec 202).
 *
 * 1. A discounted invoice shows the Rabatt and the Nettobetrag, and they add
 *    up to the Gesamtbetrag.
 * 2. An invoice without a discount shows no Rabatt row.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const API_BASE = 'http://localhost:3001'

async function api() {
  return await playwrightRequest.newContext({
    extraHTTPHeaders: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
  })
}

test.describe('Tier 413 — the invoice discount on the detail page', () => {
  let discountedId = ''
  let plainId = ''

  test.beforeAll(async () => {
    const req = await api()
    const customer = await req.post(`${API_BASE}/api/v1/customers?companyId=${COMPANY_ID}`, {
      data: { name: `Tier413 Kunde ${Date.now()}`, type: 'business' },
    })
    const customerId = (await customer.json()).id
    const item = { description: 'Beratung', quantity: 1, unit: 'Stk', unitPrice: 1000, vatRate: 0.19 }
    const mk = async (body: Record<string, unknown>) => {
      const res = await req.post(`${API_BASE}/api/v1/invoices?companyId=${COMPANY_ID}`, {
        data: { customerId, issueDate: '2026-09-01', items: [item], ...body },
      })
      return (await res.json()).id as string
    }
    discountedId = await mk({ discountPercent: 10 })
    plainId = await mk({})
    await req.dispose()
  })

  test.afterAll(async () => {
    const req = await api()
    for (const id of [discountedId, plainId]) {
      await req.delete(`${API_BASE}/api/v1/invoices/${id}?companyId=${COMPANY_ID}`)
    }
    await req.dispose()
  })

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

  test('a discounted invoice shows Rabatt and Nettobetrag', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${discountedId}`)
    const row = page.getByTestId('invoice-discount-row')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Rabatt')
    await expect(row).toContainText('100.00')
    const card = row.locator('..')
    await expect(card).toContainText('Nettobetrag')
    await expect(card).toContainText('900.00')
    await expect(card).toContainText('171.00')
    await expect(card).toContainText('1071.00')
  })

  test('an invoice without a discount has no Rabatt row', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${plainId}`)
    await expect(page.getByText('Gesamtbetrag:')).toBeVisible()
    await expect(page.getByTestId('invoice-discount-row')).toHaveCount(0)
  })
})
