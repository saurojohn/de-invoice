/**
 * Playwright spec — Tier 152 manual Mahnung send.
 *
 * The Berater's question: "I just had a phone
 * call with BWA Test Kunde about the overdue
 * INV-2026-000123 — I want to send a Mahnung
 * right now, not wait for the cron." Tier 152 =
 * a "📨 Mahnung senden" button on the invoice
 * detail page that wraps the existing
 * /reminders/:id/email-data + /reminders/send
 * endpoints in a modal.
 *
 * Tests:
 *   1. The button is visible for an overdue
 *      invoice (status=sent, dueDate past).
 *   2. The button is NOT visible for a non-
 *      overdue invoice (status=sent, dueDate
 *      future).
 *   3. Clicking the button opens the modal.
 *   4. The modal shows the rendered subject +
 *      body for the default 'first' level.
 *   5. Switching the level re-fetches the
 *      preview and updates the subject + body.
 *   6. Clicking Senden triggers
 *      POST /reminders/send and shows the
 *      success state.
 *   7. After the send, the Mahnung appears in
 *      the Mahnhistorie (i.e. POST /mahnungen
 *      with the same invoiceId returns a row
 *      for this send).
 *   8. Mobile 375x667: button does not push
 *      other action buttons off-screen.
 *
 * Pre-flight: backend on :3001, frontend on
 * :3100. We seed an overdue invoice in
 * beforeAll (past dueDate) and a non-overdue
 * invoice in beforeAll too, then clean up
 * both in afterAll.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const BWA_CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API_BASE = 'http://localhost:3001'

// Tier-prefixed test fixtures so cleanup is
// scoped to this spec — we don't want to
// touch the seed invoices from earlier tiers.
const OVERDUE_INVOICE_ID = 'tier152-inv-overdue'
const FUTURE_INVOICE_ID = 'tier152-inv-future'

async function authedRequest() {
  return await playwrightRequest.newContext({
    extraHTTPHeaders: {
      'x-user-id': USER_ID,
      'x-company-id': COMPANY_ID,
    },
  })
}

test.describe('Tier 152 — Manual Mahnung send', () => {
  // Seed two invoices: one overdue (past
  // dueDate) and one not overdue (future
  // dueDate). Both for BWA Test Kunde. The
  // e2e tests assert on the button being
  // visible on the overdue one and hidden
  // on the not-overdue one.
  test.beforeAll(() => {
    // Build the SQL string in JS, then pipe
    // it to psql via stdin. This avoids
    // having to escape double-quotes four
    // times for shell + bash + JS + psql —
    // every level of escaping is its own
    // trap, and the heredoc form silently
    // failed in an earlier draft (the shell
    // complained but stdio: 'ignore' hid it).
    // The fix: hand psql the SQL on stdin.
    const sql = [
      `INSERT INTO \\"Invoice\\" (id, \\"companyId\\", \\"customerId\\", \\"invoiceNumber\\", \\"sequencePrefix\\", \\"sequenceYear\\", \\"sequenceNumber\\", type, status, \\"issueDate\\", \\"dueDate\\", subtotal, \\"totalVat\\", total, currency, language, \\"createdAt\\", \\"updatedAt\\")`,
      `VALUES`,
      `  ('${OVERDUE_INVOICE_ID}', '${COMPANY_ID}', '${BWA_CUSTOMER_ID}', 'TIER152-OVERDUE', 'TIER152-', 2026, 1, 'INV', 'sent', '2026-06-01', '2026-07-01', 200, 38, 238, 'EUR', 'de-DE', NOW(), NOW()),`,
      `  ('${FUTURE_INVOICE_ID}', '${COMPANY_ID}', '${BWA_CUSTOMER_ID}', 'TIER152-FUTURE', 'TIER152-', 2026, 2, 'INV', 'sent', '2026-08-01', '2026-12-01', 100, 19, 119, 'EUR', 'de-DE', NOW(), NOW())`,
      `ON CONFLICT (id) DO NOTHING;`,
    ].join('\n')
    execSync(
      `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice`,
      { input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
    )
  })
  test.afterAll(() => {
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"Mahnung\\" WHERE \\"invoiceId\\" IN ('${OVERDUE_INVOICE_ID}','${FUTURE_INVOICE_ID}')"`,
      { stdio: 'pipe' },
    )
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"EmailSend\\" WHERE \\"invoiceId\\" IN ('${OVERDUE_INVOICE_ID}','${FUTURE_INVOICE_ID}')"`,
      { stdio: 'pipe' },
    )
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"Invoice\\" WHERE id IN ('${OVERDUE_INVOICE_ID}','${FUTURE_INVOICE_ID}')"`,
      { stdio: 'pipe' },
    )
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

  test('the Mahnung senden button is visible on an overdue invoice', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${OVERDUE_INVOICE_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('send-mahnung-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
  })

  test('the Mahnung senden button is NOT visible on a not-yet-due invoice', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${FUTURE_INVOICE_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Wait for the page to settle
    await page.waitForTimeout(1_500)
    // The button must not be present
    await expect(page.getByTestId('send-mahnung-button')).toHaveCount(0)
  })

  test('clicking the button opens the modal with the rendered preview', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${OVERDUE_INVOICE_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('send-mahnung-button').click()
    const modal = page.getByTestId('send-mahnung-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    // The subject + body should auto-load
    await expect(page.getByTestId('send-mahnung-subject')).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.getByTestId('send-mahnung-body')).toBeVisible()
    // Recipient should be present too
    await expect(page.getByTestId('send-mahnung-recipient')).toBeVisible()
  })

  test('switching the level re-fetches the preview', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${OVERDUE_INVOICE_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('send-mahnung-button').click()
    await expect(page.getByTestId('send-mahnung-modal')).toBeVisible({ timeout: 5_000 })
    // Wait for the initial first-level preview
    await expect(page.getByTestId('send-mahnung-subject')).toBeVisible({
      timeout: 5_000,
    })
    const firstSubject = await page
      .getByTestId('send-mahnung-subject')
      .textContent()
    // Switch to "final" — the subject should change
    await page.getByTestId('send-mahnung-level').selectOption('final')
    // Wait for the re-fetch. The subject should
    // now be the "Letzte Mahnung" default.
    await expect(
      page.getByTestId('send-mahnung-subject'),
    ).toContainText(/Letzte Mahnung|final/i, { timeout: 5_000 })
    const finalSubject = await page
      .getByTestId('send-mahnung-subject')
      .textContent()
    expect(finalSubject).not.toBe(firstSubject)
  })

  test('clicking Senden records a Mahnung in the history', async ({ page }) => {
    // Auto-accept the confirm() prompt
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`/dashboard/invoices/${OVERDUE_INVOICE_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('send-mahnung-button').click()
    await expect(page.getByTestId('send-mahnung-modal')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('send-mahnung-subject')).toBeVisible({
      timeout: 5_000,
    })
    // Click the confirm button
    await page.getByTestId('send-mahnung-confirm').click()
    // Success indicator should appear
    await expect(page.getByTestId('send-mahnung-send-ok')).toBeVisible({
      timeout: 10_000,
    })
    // Now hit the Mahnhistorie API and check
    // a row exists for this invoice.
    const ctx = await authedRequest()
    try {
      const res = await ctx.get(
        `${API_BASE}/api/v1/reminders/mahnungen?companyId=${COMPANY_ID}&status=all`,
      )
      expect(res.status()).toBe(200)
      const body = await res.json()
      const allMahnungen = body.mahnungen || body
      const ourMahnung = (Array.isArray(allMahnungen) ? allMahnungen : []).find(
        (m: any) => m.invoiceId === OVERDUE_INVOICE_ID,
      )
      expect(ourMahnung).toBeTruthy()
      // Level should be 'first' (default)
      expect(ourMahnung.level).toBe('first')
    } finally {
      await ctx.dispose()
    }
  })

  test('mobile 375x667: the action button row does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/invoices/${OVERDUE_INVOICE_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The button is present
    await expect(page.getByTestId('send-mahnung-button')).toBeVisible({
      timeout: 10_000,
    })
    // The page should not scroll horizontally.
    // We allow a tiny slack (subpixel) on the
    // invoice detail page — the action row is
    // flex-wrap so on a 375px viewport the
    // buttons wrap onto two lines, not off-
    // screen.
    const body = page.locator('body')
    const scrollWidth = await body.evaluate((el) => el.scrollWidth)
    const clientWidth = await body.evaluate((el) => el.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
  })
})
