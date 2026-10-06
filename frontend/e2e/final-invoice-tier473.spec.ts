import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

/**
 * Tier 473 — "Schlussrechnung erstellen" on a Proforma.
 *
 * Tier 472 added POST /invoices/:proforma/final-invoice; the Proforma's
 * detail page had no way to reach it. The button creates the draft final
 * invoice and opens it; that page names its Proforma.
 */

const { userId: USER_ID, companyId: COMPANY_ID } = getTestEnv()
const API = 'http://localhost:3001'
const HEADERS = { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID }

test('a paid Proforma gets its final invoice from the detail page', async ({ page }) => {
  const api = await playwrightRequest.newContext({ extraHTTPHeaders: HEADERS })
  const tag = `pw-473-${Date.now()}`
  const customer = await (await api.post(`${API}/api/v1/customers?companyId=${COMPANY_ID}`, {
    data: { name: `${tag} Kunde`, type: 'business', address: { street: 'Teststr. 9', postalCode: '10115', city: 'Berlin', country: 'DE' } },
  })).json()
  const pi = await (await api.post(`${API}/api/v1/invoices?companyId=${COMPANY_ID}`, {
    data: {
      customerId: customer.id,
      type: 'PI',
      issueDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date()),
      items: [{ description: `${tag} Maschine`, quantity: 1, unit: 'Stk', unitPrice: 1000, vatRate: 0.19 }],
    },
  })).json()
  expect((await api.put(`${API}/api/v1/invoices/${pi.id}/status?companyId=${COMPANY_ID}`, {
    data: { status: 'sent' },
  })).status()).toBe(200)
  expect((await api.post(`${API}/api/v1/invoices/${pi.id}/payments?companyId=${COMPANY_ID}`, {
    data: { amount: 1190, paymentDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date()), paymentMethod: 'bank_transfer' },
  })).status()).toBe(201)

  await page.context().addCookies([
    { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
  ])
  await page.addInitScript(({ userId, companyId }) => {
    localStorage.setItem('userId', userId)
    localStorage.setItem('companyId', companyId)
  }, { userId: USER_ID, companyId: COMPANY_ID })
  await page.goto(`/dashboard/invoices/${pi.id}`)
  const button = page.getByTestId('final-invoice-button')
  await expect(button).toBeVisible({ timeout: 15_000 })
  await button.click()

  await expect(page).not.toHaveURL(new RegExp(`/dashboard/invoices/${pi.id}$`), { timeout: 15_000 })
  await expect(page.getByTestId('final-invoice-of')).toContainText(pi.invoiceNumber, { timeout: 15_000 })

  const finalId = page.url().split('/').pop()!.split('?')[0]
  const final = await (await api.get(`${API}/api/v1/invoices/${finalId}?companyId=${COMPANY_ID}`)).json()
  expect(final.type).toBe('INV')
  expect(final.status).toBe('draft')
  expect(final.advanceInvoiceId).toBe(pi.id)
  await api.dispose()
})

/** Tier 475 — "Anzahlung zurückzahlen" on a paid Proforma. */
test('a paid Proforma pays its advance back from the detail page', async ({ page }) => {
  const api = await playwrightRequest.newContext({ extraHTTPHeaders: HEADERS })
  const tag = `pw-475-${Date.now()}`
  const customer = await (await api.post(`${API}/api/v1/customers?companyId=${COMPANY_ID}`, {
    data: { name: `${tag} Kunde`, type: 'business', address: { street: 'Teststr. 9', postalCode: '10115', city: 'Berlin', country: 'DE' } },
  })).json()
  const pi = await (await api.post(`${API}/api/v1/invoices?companyId=${COMPANY_ID}`, {
    data: {
      customerId: customer.id,
      type: 'PI',
      issueDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date()),
      items: [{ description: `${tag} Maschine`, quantity: 1, unit: 'Stk', unitPrice: 100, vatRate: 0.19 }],
    },
  })).json()
  await api.put(`${API}/api/v1/invoices/${pi.id}/status?companyId=${COMPANY_ID}`, { data: { status: 'sent' } })
  await api.post(`${API}/api/v1/invoices/${pi.id}/payments?companyId=${COMPANY_ID}`, {
    data: { amount: 119, paymentDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date()), paymentMethod: 'bank_transfer' },
  })

  await page.context().addCookies([
    { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
  ])
  await page.addInitScript(({ userId, companyId }) => {
    localStorage.setItem('userId', userId)
    localStorage.setItem('companyId', companyId)
  }, { userId: USER_ID, companyId: COMPANY_ID })
  await page.goto(`/dashboard/invoices/${pi.id}`)
  page.once('dialog', (d) => d.accept('119.00'))
  await page.getByTestId('advance-refund-button').click({ timeout: 15_000 })
  // everything paid back: the button goes away
  await expect(page.getByTestId('advance-refund-button')).toHaveCount(0, { timeout: 15_000 })

  const payments = await (await api.get(`${API}/api/v1/invoices/${pi.id}/payments?companyId=${COMPANY_ID}`)).json()
  const list = Array.isArray(payments) ? payments : payments.data
  expect(list.map((p: any) => Number(p.amount)).sort()).toEqual([-119, 119])
  await api.dispose()
})
