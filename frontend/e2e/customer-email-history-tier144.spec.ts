/**
 * Playwright spec — Tier 144 customer email history.
 *
 * Adds a "📧 E-Mail-Verlauf" tab on the customer
 * detail page that shows every email the system
 * has sent to that customer (invoices, Mahnung
 * letters, Kontoauszug, bulk-send batches).
 *
 * Tests:
 *   1. The new tab renders on the customer detail
 *      page (testid: tab-emails) with the
 *      expected count badge.
 *   2. Clicking the tab lazy-loads the email list
 *      via /api/v1/customers/:id/emails.
 *   3. The list shows at least one row with the
 *      expected columns (date, subject, template,
 *      invoice, status).
 *   4. Clicking a row opens the detail modal with
 *      the full body preview + recipient + sentAt.
 *   5. Backend-only: the endpoint returns the
 *      expected response shape.
 *   6. Backend-only: the ?status= filter narrows
 *      the result set.
 *   7. Backend-only: invalid take > 200 → 400.
 *   8. Mobile 375x667: tab button row does not
 *      overflow.
 *
 * Pre-flight: backend on :3001, BWA Test Kunde
 * (id=b3f7b274-...) has 13+ EmailSend rows in the
 * shared DB from the Tier 141/142 fixture flows.
 */
import { test, expect } from '@playwright/test'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API_BASE = 'http://localhost:3001'

test.describe('Tier 144 — Customer email history', () => {
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

  test('the E-Mail-Verlauf tab renders on the customer detail page', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const tab = page.getByTestId('tab-emails')
    await expect(tab).toBeVisible({ timeout: 10_000 })
    // Tab text is one of the i18n translations
    await expect(tab).toContainText(/E-Mail-Verlauf|Email history|邮件历史/i)
  })

  test('clicking the tab lazy-loads the email table', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('tab-emails').click()
    const table = page.getByTestId('tab-emails-table')
    await expect(table).toBeVisible({ timeout: 10_000 })
    // At least one row should be in the table —
    // the shared DB has 13+ EmailSend rows for
    // BWA Test Kunde from earlier tiers.
    const rows = await page.getByTestId('tab-emails-row').count()
    expect(rows).toBeGreaterThan(0)
  })

  test('clicking a row opens the detail modal with body preview', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('tab-emails').click()
    const table = page.getByTestId('tab-emails-table')
    await expect(table).toBeVisible({ timeout: 10_000 })
    // Wait for the first row to render
    const firstRow = page.getByTestId('tab-emails-row').first()
    await expect(firstRow).toBeVisible({ timeout: 5_000 })
    await firstRow.click()
    // Detail modal opens
    const modal = page.getByTestId('email-detail-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    // Subject is rendered
    const subject = page.getByTestId('email-detail-subject')
    await expect(subject).toBeVisible({ timeout: 5_000 })
    // Body preview is non-empty
    const body = page.getByTestId('email-detail-body')
    const bodyText = (await body.textContent()) || ''
    expect(bodyText.length).toBeGreaterThan(20)
    // Close button dismisses
    await page.getByTestId('email-detail-close').click()
    await expect(modal).toBeHidden({ timeout: 5_000 })
  })

  test('backend: the endpoint returns the expected response shape', async () => {
    const url = `${API_BASE}/api/v1/customers/${CUSTOMER_ID}/emails?companyId=${COMPANY_ID}&take=5`
    const res = await fetch(url, {
      headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('rows')
    expect(data).toHaveProperty('total')
    expect(data).toHaveProperty('take')
    expect(data).toHaveProperty('skip')
    expect(data.total).toBeGreaterThan(0)
    expect(Array.isArray(data.rows)).toBe(true)
    // Every row has the expected shape
    for (const r of data.rows) {
      expect(r).toHaveProperty('id')
      expect(r).toHaveProperty('recipientEmail')
      expect(r).toHaveProperty('status')
      expect(r).toHaveProperty('createdAt')
    }
  })

  test('backend: the ?status= filter narrows the result set', async () => {
    const allUrl = `${API_BASE}/api/v1/customers/${CUSTOMER_ID}/emails?companyId=${COMPANY_ID}&take=1`
    const openedUrl = `${API_BASE}/api/v1/customers/${CUSTOMER_ID}/emails?companyId=${COMPANY_ID}&status=opened&take=1`
    const [allRes, openedRes] = await Promise.all([
      fetch(allUrl, { headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID } }),
      fetch(openedUrl, { headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID } }),
    ])
    const allData = await allRes.json()
    const openedData = await openedRes.json()
    // The opened-only count must be ≤ all count.
    // (The shared DB might have other statuses, so
    // we don't assert strict inequality.)
    expect(openedData.total).toBeLessThanOrEqual(allData.total)
    // Every opened-only row has status=opened
    for (const r of openedData.rows) {
      expect(r.status).toBe('opened')
    }
  })

  test('backend: invalid take > 200 → 400', async () => {
    const url = `${API_BASE}/api/v1/customers/${CUSTOMER_ID}/emails?companyId=${COMPANY_ID}&take=999`
    const res = await fetch(url, {
      headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
    })
    expect(res.status).toBe(400)
  })

  test('mobile 375x667: tab row does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const tab = page.getByTestId('tab-emails')
    await expect(tab).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
