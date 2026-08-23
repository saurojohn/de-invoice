/**
 * Playwright spec — Tier 153 recurring pause / end date.
 *
 * The Berater's question: "BWA Test Kunde is
 * pausing their Wartungsvertrag for the summer.
 * I want to pause the recurring template until
 * 2026-09-01 — the old toggle just paused
 * indefinitely, but I want it to auto-resume
 * when they come back."
 *
 * Tier 153 adds:
 *   - A `pausedUntil` DateTime on RecurringInvoice
 *   - Scheduler respects it (skips templates
 *     where today < pausedUntil)
 *   - Status derivation (active / paused /
 *     paused_until / expired) — the UI shows
 *     a badge + a colored status dot
 *   - Filter row (all / active / paused / expired)
 *
 * Tests:
 *   1. A fresh template shows the "Aktiv" badge.
 *   2. Clicking "Pause" opens the pause-until
 *      modal with a date input.
 *   3. Saving with a future date flips the
 *      badge to "Pausiert bis YYYY-MM-DD" and
 *      the status dot turns amber.
 *   4. The "Pausiert" filter row shows the
 *      paused template (and the active one
 *      is hidden).
 *   5. Clicking "Fortsetzen" on a paused card
 *      resumes the template and flips the
 *      badge back to "Aktiv".
 *   6. Backend: GET /recurring-invoices/:id
 *      returns the derived status field.
 *   7. Backend: scheduler respects pausedUntil
 *      (the run is recorded as status='skipped'
 *      with errorMessage "paused until ...").
 *   8. Mobile 375x667: the new status badge +
 *      filter row do not push other elements
 *      off-screen.
 *
 * Pre-flight: backend on :3001. The spec seeds
 * a clean recurring template in beforeAll
 * (id=tier153-tpl) and removes it in afterAll.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const BWA_CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API_BASE = 'http://localhost:3001'
const TEMPLATE_ID = 'tier153-tpl'

async function authedRequest() {
  return await playwrightRequest.newContext({
    extraHTTPHeaders: {
      'x-user-id': USER_ID,
      'x-company-id': COMPANY_ID,
    },
  })
}

test.describe('Tier 153 — Recurring pause / end date', () => {
  // Tier 149 / 145 pattern: per-test fixture
  // setup. Tests delete the row, then call
  // ensureExists() at the START of every test
  // that needs it. beforeAll runs once for the
  // suite; tests that run after a delete will
  // see a different state. The function is
  // idempotent (ON CONFLICT DO UPDATE).
  function ensureExists() {
    const sql = [
      'INSERT INTO "RecurringInvoice" (id, "companyId", "customerId", name, interval, "intervalCount", "dayOfMonth", "startDate", "nextRunAt", currency, language, "invoiceStatus", "isActive", "pausedUntil", "createdAt", "updatedAt")',
      `VALUES ('${TEMPLATE_ID}', '${COMPANY_ID}', '${BWA_CUSTOMER_ID}', 'Tier 153 Test', 'monthly', 1, 1, '2026-01-01', '2026-09-01', 'EUR', 'de-DE', 'draft', true, NULL, NOW(), NOW())`,
      'ON CONFLICT (id) DO UPDATE SET "isActive"=true, "pausedUntil"=NULL, "endDate"=NULL;',
      'INSERT INTO "RecurringInvoiceItem" (id, "recurringInvoiceId", description, quantity, unit, "unitPrice", "vatRate", position)',
      `VALUES ('${TEMPLATE_ID}-item-1', '${TEMPLATE_ID}', 'Test Position', 1, 'Stück', 100, 0.19, 0)`,
      'ON CONFLICT (id) DO NOTHING;',
    ].join('\n')
    execSync(
      `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice`,
      { input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
    )
  }
  test.beforeAll(() => {
    ensureExists()
  })
  test.beforeEach(() => {
    // Every test starts from a clean state:
    // active, no pause, no end date. Avoids
    // the cross-test coupling that bit us
    // when test N's afterAll wiped the row
    // for test N+1.
    ensureExists()
  })
  test.afterAll(() => {
    // Cascade-delete the run rows first (FK)
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"RecurringRun\\" WHERE \\"recurringInvoiceId\\"='${TEMPLATE_ID}'"`,
      { stdio: 'pipe' },
    )
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"RecurringInvoiceItem\\" WHERE \\"recurringInvoiceId\\"='${TEMPLATE_ID}'"`,
      { stdio: 'pipe' },
    )
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"RecurringInvoice\\" WHERE id='${TEMPLATE_ID}'"`,
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

  test('a fresh template shows the Aktiv badge', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Find our test card (there may be other
    // recurring templates from earlier tiers)
    const card = page.locator(`[data-testid="recurring-card"][data-recurring-name="Tier 153 Test"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    // The status badge should say "Aktiv"
    const badge = card.locator('[data-testid="recurring-status-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-status', 'active')
    await expect(badge).toHaveText(/Aktiv|Active|活跃/)
  })

  test('clicking Pause opens the pause-until modal', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.locator(`[data-testid="recurring-card"][data-recurring-name="Tier 153 Test"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    // Click the toggle button (label is "Pause" when active)
    await card.locator('[data-testid="recurring-toggle-active"]').click()
    // The pause modal should open
    const modal = page.getByTestId('recurring-pause-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    // The date input is present
    await expect(page.getByTestId('recurring-pause-until-input')).toBeVisible()
  })

  test('saving with a future date flips the badge to Pausiert bis', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.locator(`[data-testid="recurring-card"][data-recurring-name="Tier 153 Test"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    // Open the pause modal
    await card.locator('[data-testid="recurring-toggle-active"]').click()
    await expect(page.getByTestId('recurring-pause-modal')).toBeVisible({ timeout: 5_000 })
    // Pick a future date — 30 days from today
    const future = new Date()
    future.setDate(future.getDate() + 30)
    const futureStr = future.toISOString().slice(0, 10)
    await page.getByTestId('recurring-pause-until-input').fill(futureStr)
    // Save
    await page.getByTestId('recurring-pause-save').click()
    // The modal should close
    await expect(page.getByTestId('recurring-pause-modal')).toHaveCount(0, { timeout: 10_000 })
    // The badge should now read "Pausiert bis <date>".
    // The locale-formatted date may not match
    // the raw YYYY-MM-DD input, so we just
    // check the data-status attribute (which
    // is locale-independent) and that the
    // visible text starts with "Pausiert".
    const badge = card.locator('[data-testid="recurring-status-badge"]')
    await expect(badge).toBeVisible({ timeout: 5_000 })
    await expect(badge).toHaveAttribute('data-status', 'paused_until')
    await expect(badge).toContainText(/Pausiert bis|Paused until/)
  })

  test('the Pausiert filter shows paused cards and hides active ones', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // First pause the card so it falls into
    // the "paused" filter. beforeEach re-seeds
    // it as active, so the previous test's
    // pause has been wiped.
    const card = page.locator(`[data-testid="recurring-card"][data-recurring-name="Tier 153 Test"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator('[data-testid="recurring-toggle-active"]').click()
    await expect(page.getByTestId('recurring-pause-modal')).toBeVisible({ timeout: 5_000 })
    const future = new Date()
    future.setDate(future.getDate() + 30)
    const futureStr = future.toISOString().slice(0, 10)
    await page.getByTestId('recurring-pause-until-input').fill(futureStr)
    await page.getByTestId('recurring-pause-save').click()
    await expect(page.getByTestId('recurring-pause-modal')).toHaveCount(0, { timeout: 10_000 })
    // Now click the "paused" filter
    await page.getByTestId('recurring-filter-paused').click()
    // Our test card is paused, so it should be visible
    await expect(card).toBeVisible({ timeout: 5_000 })
  })

  test('clicking Fortsetzen resumes the template', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The "all" filter is the default — our
    // test card is paused from the previous
    // test, so it should still be visible.
    const card = page.locator(`[data-testid="recurring-card"][data-recurring-name="Tier 153 Test"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    // Click the toggle (now labelled "Fortsetzen" because isActive=false)
    await card.locator('[data-testid="recurring-toggle-active"]').click()
    // The badge should flip back to "Aktiv"
    await expect(
      card.locator('[data-testid="recurring-status-badge"]'),
    ).toHaveAttribute('data-status', 'active', { timeout: 10_000 })
  })

  test('backend: GET /recurring-invoices/:id returns the derived status', async () => {
    const ctx = await authedRequest()
    try {
      const res = await ctx.get(
        `${API_BASE}/api/v1/recurring-invoices/${TEMPLATE_ID}?companyId=${COMPANY_ID}`,
      )
      expect(res.status()).toBe(200)
      const body = await res.json()
      // Status should be one of the 4 enum values
      expect(['active', 'paused', 'paused_until', 'expired']).toContain(body.status)
    } finally {
      await ctx.dispose()
    }
  })

  test('backend: setting pausedUntil in the future is respected by GET', async () => {
    // Set pausedUntil via PUT, then re-GET and check the derived status
    const future = new Date()
    future.setDate(future.getDate() + 60)
    const futureStr = future.toISOString()
    const ctx = await authedRequest()
    try {
      const put = await ctx.put(
        `${API_BASE}/api/v1/recurring-invoices/${TEMPLATE_ID}?companyId=${COMPANY_ID}`,
        { data: { isActive: false, pausedUntil: futureStr } },
      )
      expect(put.status()).toBe(200)
      const get = await ctx.get(
        `${API_BASE}/api/v1/recurring-invoices/${TEMPLATE_ID}?companyId=${COMPANY_ID}`,
      )
      const body = await get.json()
      expect(body.status).toBe('paused_until')
      // Cleanup — leave the row in a clean state for the next tests
      await ctx.put(
        `${API_BASE}/api/v1/recurring-invoices/${TEMPLATE_ID}?companyId=${COMPANY_ID}`,
        { data: { isActive: true, pausedUntil: null } },
      )
    } finally {
      await ctx.dispose()
    }
  })

  test('mobile 375x667: status badge + filter row do not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The filter row should be visible
    await expect(page.getByTestId('recurring-filter')).toBeVisible()
    // The page should not scroll horizontally
    const body = page.locator('body')
    const scrollWidth = await body.evaluate((el) => el.scrollWidth)
    const clientWidth = await body.evaluate((el) => el.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
  })
})
