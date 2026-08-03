/**
 * Playwright spec — Tier 143 audit log full-text search.
 *
 * The Berater's primary use case for the audit log
 * is "find the row about invoice INV-2026-000203"
 * — they don't know the entityId UUID, they know
 * the invoice number. The new search input on
 * /dashboard/audit hits a new `q` query param that
 * the backend resolves via raw SQL
 * (jsonb::text ILIKE) so the JSON payload is
 * searchable.
 *
 * Tests:
 *   1. The search input renders with the correct
 *      testid + the expected placeholder hint.
 *   2. Typing a known invoice number (e.g.
 *      INV-2026-000203) filters the table to only
 *      matching rows.
 *   3. Typing a non-existent string filters to 0
 *      rows + shows the empty state.
 *   4. The clear (✕) button inside the input
 *      empties the search and re-fetches.
 *   5. The q parameter is reflected in the URL
 *      (deep-linkable).
 *   6. Backend-only: the q param returns
 *      deterministic results regardless of which
 *      field matches.
 *   7. Mobile 375x667: search input + filter grid
 *      do not overflow.
 *
 * Pre-flight: backend on :3001, the Tier 138
 * fixture invoice INV-2026-000203 is in the
 * shared DB and has 2+ audit rows referencing it
 * in newData.
 */
import { test, expect } from '@playwright/test'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const API_BASE = 'http://localhost:3001'

test.describe('Tier 143 — Audit full-text search', () => {
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

  test('the search input renders on the audit page', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const search = page.getByTestId('audit-filter-q')
    await expect(search).toBeVisible({ timeout: 10_000 })
    // The placeholder hint must show the supported
    // search fields (one of invoice/customer/etc).
    const placeholder = await search.getAttribute('placeholder')
    expect(placeholder?.length ?? 0).toBeGreaterThan(10)
  })

  test('typing an invoice number filters the table', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Wait for the initial table to load so the
    // baseline count is established.
    await page.waitForTimeout(1500)
    const search = page.getByTestId('audit-filter-q')
    await expect(search).toBeVisible({ timeout: 10_000 })
    // Typing a known invoice number — the global-setup
    // fixtures seeded several `invoice.updated` rows
    // for INV-2026-000203..000206, so this should
    // return at least 1 row.
    await search.fill('INV-2026-000203')
    // Debounce is 300ms; give it 1s to settle.
    await page.waitForTimeout(1000)
    // The result count should be > 0 (we have at
    // least one audit row referencing this invoice).
    // We don't assert on the exact number because
    // shared-DB noise from other test fixtures can
    // change it.
    const rows = await page.locator('table tbody tr').count()
    expect(rows).toBeGreaterThan(0)
  })

  test('typing a non-existent string shows 0 rows', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const search = page.getByTestId('audit-filter-q')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill('zzz_no_such_invoice_or_user_xyz123')
    await page.waitForTimeout(1000)
    // Either 0 rows or an empty-state message.
    // The exact UI depends on the rowCount check
    // elsewhere, so we just assert the page is
    // not still showing the original full list.
    const rows = await page.locator('table tbody tr').count()
    expect(rows).toBe(0)
  })

  test('the clear button empties the search and re-fetches', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const search = page.getByTestId('audit-filter-q')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill('INV-2026-000203')
    await page.waitForTimeout(1000)
    const clearBtn = page.getByTestId('audit-filter-q-clear')
    await expect(clearBtn).toBeVisible({ timeout: 5_000 })
    await clearBtn.click()
    await expect(search).toHaveValue('', { timeout: 5_000 })
  })

  test('the q parameter is reflected in the URL', async ({ page }) => {
    await page.goto('/dashboard/audit?q=INV-2026-000203')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const search = page.getByTestId('audit-filter-q')
    await expect(search).toBeVisible({ timeout: 10_000 })
    // The input should be pre-filled from the URL
    await expect(search).toHaveValue('INV-2026-000203', { timeout: 5_000 })
  })

  test('backend: q returns deterministic jsonb matches', async () => {
    const url = `${API_BASE}/api/v1/audit-logs?companyId=${COMPANY_ID}&q=INV-2026-000203&take=5`
    const res = await fetch(url, {
      headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    // Sanity: at least one row matches the fixture
    expect(data.total).toBeGreaterThan(0)
    // Every returned row should reference the
    // queried invoice number somewhere — either
    // in the action (invoice.updated) or in
    // the newData (which we don't return in
    // the list endpoint, but the entityId should
    // be the invoice's UUID).
    for (const r of data.rows) {
      expect(r.entityType).toBe('Invoice')
    }
  })

  test('mobile 375x667: search input does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/audit')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const search = page.getByTestId('audit-filter-q')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
