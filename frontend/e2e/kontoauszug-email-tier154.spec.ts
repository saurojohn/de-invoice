/**
 * Playwright spec — Tier 154 Kontoauszug email.
 *
 * The Berater's question: "I've generated the
 * Kontoauszug for BWA Test Kunde for July 2026.
 * How do I email it to them without having to
 * download the PDF and write an email by hand?"
 *
 * Tier 154 adds a "📧 Per E-Mail senden" button
 * on the statement page that wraps the new
 * POST /api/v1/customers/:id/statement.email
 * endpoint.
 *
 * Tests:
 *   1. The "Per E-Mail senden" button is
 *      visible on the statement page.
 *   2. Clicking it shows the success state
 *      ("Kontoauszug wurde an <recipient>
 *      gesendet").
 *   3. After the send, an EmailSend row exists
 *      with templateType='statement'.
 *   4. Backend: POST .../statement.email returns
 *      the expected response shape (success +
 *      emailSendId + recipient).
 *   5. Backend: missing from/to → 400.
 *   6. Backend: cross-tenant customerId → 400.
 *   7. Mobile 375x667: the action button row
 *      does not overflow.
 *
 * Pre-flight: backend on :3001, frontend on
 * :3100. BWA Test Kunde has a contact.email
 * seeded by earlier tiers, so the send path
 * doesn't trip the "no email" guard.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const BWA_CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API_BASE = 'http://localhost:3001'

async function authedRequest() {
  return await playwrightRequest.newContext({
    extraHTTPHeaders: {
      'x-user-id': USER_ID,
      'x-company-id': COMPANY_ID,
    },
  })
}

test.describe('Tier 154 — Kontoauszug email', () => {
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

  test('the Per E-Mail senden button renders on the statement page', async ({ page }) => {
    await page.goto(`/dashboard/customers/${BWA_CUSTOMER_ID}/statement`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('statement-send-email-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
  })

  test('clicking the button shows the success state', async ({ page }) => {
    await page.goto(`/dashboard/customers/${BWA_CUSTOMER_ID}/statement`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('statement-send-email-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    // Click and wait for the success banner
    await btn.click()
    await expect(
      page.getByTestId('statement-email-sent-ok'),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('after the send, an EmailSend row exists with templateType=statement', async ({ page }) => {
    await page.goto(`/dashboard/customers/${BWA_CUSTOMER_ID}/statement`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('statement-send-email-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await btn.click()
    await expect(
      page.getByTestId('statement-email-sent-ok'),
    ).toBeVisible({ timeout: 10_000 })
    // Verify the EmailSend row was written. The
    // customer detail email-Verlauf (Tier 144)
    // uses the same query we use here. The
    // response shape is { rows: [...] } (the
    // standard paginated list shape, not the
    // { emails: [...] } we initially assumed).
    const ctx = await authedRequest()
    try {
      const res = await ctx.get(
        `${API_BASE}/api/v1/customers/${BWA_CUSTOMER_ID}/emails?companyId=${COMPANY_ID}&templateType=statement`,
      )
      expect(res.status()).toBe(200)
      const body = await res.json()
      const list = body.rows || body.emails || body
      const found = (Array.isArray(list) ? list : []).find(
        (e: any) => e.templateType === 'statement',
      )
      expect(found).toBeTruthy()
      // The recipient should match BWA Test
      // Kunde's contact.email.
      expect(found.recipientEmail).toContain('@')
    } finally {
      await ctx.dispose()
    }
  })

  test('backend: POST .../statement.email returns the expected shape', async () => {
    const ctx = await authedRequest()
    try {
      const res = await ctx.post(
        `${API_BASE}/api/v1/customers/${BWA_CUSTOMER_ID}/statement.email`,
        {
          data: {
            companyId: COMPANY_ID,
            from: '2026-07-01',
            to: '2026-07-31',
            order: 'desc',
          },
        },
      )
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.emailSendId).toBeTruthy()
      expect(body.recipientEmail).toContain('@')
      expect(body.period).toHaveProperty('from')
      expect(body.period).toHaveProperty('to')
      // smtpConfigured is a boolean — false in
      // dev (no SMTP set up), true in prod.
      expect(typeof body.smtpConfigured).toBe('boolean')
    } finally {
      await ctx.dispose()
    }
  })

  test('backend: missing from/to → 400', async () => {
    const ctx = await authedRequest()
    try {
      const res = await ctx.post(
        `${API_BASE}/api/v1/customers/${BWA_CUSTOMER_ID}/statement.email`,
        {
          data: {
            companyId: COMPANY_ID,
            // from / to omitted on purpose
          },
        },
      )
      expect(res.status()).toBe(400)
    } finally {
      await ctx.dispose()
    }
  })

  test('backend: cross-tenant customerId → 400', async () => {
    // The customerId we use belongs to
    // COMPANY_ID; we pass a DIFFERENT companyId
    // in the body. The service does
    // customer.findFirst({ id, companyId }) and
    // that should return null → 400.
    const OTHER_COMPANY = '11111111-2222-3333-4444-555555555555'
    const ctx = await authedRequest()
    try {
      const res = await ctx.post(
        `${API_BASE}/api/v1/customers/${BWA_CUSTOMER_ID}/statement.email`,
        {
          data: {
            companyId: OTHER_COMPANY,
            from: '2026-07-01',
            to: '2026-07-31',
          },
        },
      )
      // The service throws 400 (Customer not
      // found in this company).
      expect([400, 404]).toContain(res.status())
    } finally {
      await ctx.dispose()
    }
  })

  test('mobile 375x667: action button row does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${BWA_CUSTOMER_ID}/statement`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('statement-send-email-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    // The page should not scroll horizontally
    const body = page.locator('body')
    const scrollWidth = await body.evaluate((el) => el.scrollWidth)
    const clientWidth = await body.evaluate((el) => el.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
  })
})
