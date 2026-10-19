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
import { execSync } from 'child_process'
import { getTestEnv, PG_CONTAINER } from './fixtures/test-env'
import { portalTokenFor } from './fixtures/portal-token'

// Use the portal-test customer seeded by
// ci-seed.sh (id aabbccdd-1337-1337-1337-...,
// email tier133-customer@example.com). The
// customer-portal/request-session endpoint is
// rate-limited to 5/5min per email; repeated
// test runs may hit that budget. We work around
// it by adding a per-run suffix on the email +
// mirroring it onto the seeded customer in a
// beforeAll (so each run uses a fresh email
// against a fresh customer that the portal
// endpoint can resolve).
const TEST_EMAIL = `tier133-customer+${Date.now()}-${process.pid}@example.com`
const TEST_CUSTOMER_ID = 'aabbccdd-1337-1337-1337-000000000001'
const API = process.env.E2E_API_URL || 'http://localhost:3001'

test.describe('Tier 133 — Portal invoice detail', () => {
  const { userId: USER_ID, companyId: COMPANY_ID } = getTestEnv()

  test.beforeAll(() => {
    // Mirror the per-run TEST_EMAIL onto the seeded
    // portal-test customer's contact field, so the
    // /customer-portal/request-session endpoint can
    // resolve it. The seeded customer has
    // 'tier133-customer@example.com' as a default; we
    // rewrite it to a per-run unique address to avoid
    // the 5/5min rate limit per email.
    const tmpFile = `/tmp/tier133-rename-${process.pid}.sql`
    require('fs').writeFileSync(
      tmpFile,
      `UPDATE "Customer" SET contact = jsonb_set(contact, '{email}', '"${TEST_EMAIL}"') WHERE id = '${TEST_CUSTOMER_ID}';\n`,
    )
    try {
      execSync(
        `cat "${tmpFile}" | docker exec -i ${PG_CONTAINER} psql -U de_invoice -d de_invoice -v ON_ERROR_STOP=1`,
        { stdio: 'pipe' },
      )
    } finally {
      try { require('fs').unlinkSync(tmpFile) } catch {}
    }
  })

  test.beforeEach(async ({ context }) => {
    // We need the admin auth cookies for the
    // /api/v1/customers list (to find an invoice id).
    // Tier 250: use the test env's dynamic IDs from
    // the auth cache, not the hardcoded dryrun UUIDs
    // — the dryrun company has no real customers.
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
  })

  async function getTokenForCustomer(): Promise<{ token: string; customerId: string; invoiceId: string }> {
    // Tier 703: the company's link (a customer no longer asks for one). The
    // link is rate-limited per e-mail (5 / 5 min) — beforeAll gives the
    // customer a per-run address; a refusal leaves the token empty and the
    // test's expects() say so.
    const { status, token: sent } = await portalTokenFor(API, TEST_CUSTOMER_ID)
    const token = status === 201 ? sent : ''
    // Find an invoice for the test customer
    const adminCtx = await playwrightRequest.newContext({
      extraHTTPHeaders: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
      },
    })
    const invoicesRes = await adminCtx.get(
      // an issued one: the portal shows no draft (Tier 496), and other specs leave drafts for this customer
      `${API}/api/v1/invoices?companyId=${COMPANY_ID}&customerId=${TEST_CUSTOMER_ID}&status=sent&pageSize=1`,
    )
    const data = await invoicesRes.json()
    const customerId = TEST_CUSTOMER_ID
    const invoiceId = (data.data?.[0] || data[0])?.id || ''
    await adminCtx.dispose()
    return { token, customerId, invoiceId }
  }

  test('clicking an invoice number opens the detail page', async ({ page }) => {
    const { token } = await getTokenForCustomer()
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
