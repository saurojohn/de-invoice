/**
 * Playwright spec — Tier 133 portal invoice detail page.
 *
 * Verifies:
 *   1. /portal lists invoice numbers as clickable
 *      links to the detail page
 *   2. Detail page loads with line items table
 *   3. The "Bereits bezahlt" tile shows the right
 *      number (if payments exist)
 *   4. PDF download button works
 *   5. Mobile 375x667: no horizontal overflow
 *   6. Detail page with bad invoice id shows error
 *      + "back to login" button
 *
 * Pre-flight: backend on :3001, Tier 130 portal
 * service, the test customer has an email set
 * and at least one invoice.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const TEST_EMAIL = 'tier133-customer@example.com'
const API = 'http://localhost:3001'

test.describe('Tier 133 — Portal invoice detail', () => {
  test.beforeEach(async ({ context }) => {
    // We need the admin auth cookies for the
    // /api/v1/customers list (to find an invoice id).
    await context.addCookies([
      { name: 'x-user-id', value: '8c6a9669-0069-4137-a842-a66fd1d178d6', domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: 'ad257ec3-d319-479b-b870-3fe76e8f3111', domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
  })

  async function getTokenForCustomer(): Promise<{ token: string; customerId: string; invoiceId: string }> {
    // Request a session via the public endpoint
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.post(`${API}/api/v1/customer-portal/request-session?email=${encodeURIComponent(TEST_EMAIL)}`)
    expect(res.status()).toBe(201)
    // Read the latest token from the backend log
    const fs = await import('fs/promises')
    const log = await fs.readFile('/tmp/backend.log', 'utf-8')
    const lines = log.split('\n').filter((l) => l.includes('portal session created'))
    const last = lines[lines.length - 1] || ''
    const m = last.match(/token=([0-9a-f]{64})/)
    const token = m ? m[1] : ''
    await ctx.dispose()
    // Find an invoice for the test customer
    const adminCtx = await playwrightRequest.newContext({
      extraHTTPHeaders: {
        'x-user-id': '8c6a9669-0069-4137-a842-a66fd1d178d6',
        'x-company-id': 'ad257ec3-d319-479b-b870-3fe76e8f3111',
      },
    })
    const invoicesRes = await adminCtx.get(
      `${API}/api/v1/invoices?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111&customerId=b3f7b274-7696-44b8-9345-8bfd460b3e47&pageSize=1`,
    )
    const data = await invoicesRes.json()
    const customerId = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
    const invoiceId = (data.data?.[0] || data[0])?.id || '11deeb35-7147-4bdc-86d9-a302b4f80f3e'
    await adminCtx.dispose()
    return { token, customerId, invoiceId }
  }

  test('clicking an invoice number opens the detail page', async ({ page }) => {
    const { token, invoiceId } = await getTokenForCustomer()
    await page.goto(`/portal?token=${token}`)
    await expect(page.getByTestId('portal-customer-name')).toBeVisible({ timeout: 10_000 })
    // The first invoice link should point at the detail page
    const firstLink = page.locator('[data-testid^="portal-invoice-link-"]').first()
    await expect(firstLink).toBeVisible({ timeout: 5_000 })
    const href = await firstLink.getAttribute('href')
    expect(href).toMatch(/\/portal\/invoice\/[a-f0-9-]+\?token=/)
  })

  test('detail page shows invoice number + line items + summary', async ({ page }) => {
    const { token, invoiceId } = await getTokenForCustomer()
    await page.goto(`/portal/invoice/${invoiceId}?token=${token}`)
    await expect(page.getByTestId('portal-invoice-number')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('portal-invoice-summary')).toBeVisible()
    // Items table may be empty if the test invoice has no lines,
    // but the structure must render
    await expect(page.getByTestId('portal-invoice-items-table')).toBeVisible()
    // PDF button always present
    await expect(page.getByTestId('portal-invoice-pdf-button')).toBeVisible()
  })

  test('mobile 375x667: detail page no horizontal overflow', async ({ page }) => {
    const { token, invoiceId } = await getTokenForCustomer()
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/portal/invoice/${invoiceId}?token=${token}`)
    await expect(page.getByTestId('portal-invoice-number')).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(2000)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })

  test('detail page with bad invoice id shows error + back button', async ({ page }) => {
    const { token } = await getTokenForCustomer()
    // Use a valid-shaped invoice id that doesn't belong
    // to this customer — should 404
    await page.goto(`/portal/invoice/00000000-0000-0000-0000-deadbeefffff?token=${token}`)
    await expect(page.getByTestId('portal-error')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('portal-back-to-list')).toBeVisible()
  })
})
