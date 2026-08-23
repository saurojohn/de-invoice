/**
 * Playwright spec — Tier 122 audit log timeline + URL state.
 *
 * Verifies the new audit page features:
 *   1. View toggle: table ↔ timeline. Clicking
 *      "Zeitstrahl" / "Timeline" replaces the table
 *      with day-grouped events; clicking "Tabelle"
 *      / "Table" brings it back.
 *   2. URL state: the view mode + filter values are
 *      mirrored to the URL. A deep link with
 *      `?view=timeline&entityType=Invoice` lands
 *      directly on the timeline view with the
 *      Invoice filter pre-applied.
 *
 * Pre-flight: backend must be running, the audit
 * endpoint must return at least one row. The dev DB
 * has 1000s of audit rows from earlier tier work,
 * so this is a safe assumption.
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
test.describe('Tier 122 — Audit log timeline + URL state', () => {
  test.beforeEach(async ({ context, page }) => {
    // The Next.js middleware reads cookies, not
    // localStorage. We have to set the cookies via
    // addCookies() before the page navigation —
    // addInitScript only sets localStorage, which
    // AuthCookieSync then mirrors to cookies AFTER
    // React hydration, but the middleware runs
    // server-side on the FIRST request and would
    // redirect to /login before the mirror happens.
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
  })

  test('view toggle switches between table and timeline', async ({ page }) => {
    await page.goto('/dashboard/audit')
    // Wait for the table to render (default view).
    await expect(page.getByTestId('audit-table')).toBeVisible({ timeout: 15_000 })
    // The toggle is rendered
    await expect(page.getByTestId('audit-view-toggle')).toBeVisible()

    // Switch to timeline
    await page.getByTestId('audit-view-timeline').click()
    await expect(page.getByTestId('audit-timeline')).toBeVisible({ timeout: 5_000 })
    // Table should be gone
    await expect(page.getByTestId('audit-table')).not.toBeVisible()
    // At least one day group + row visible
    await expect(page.locator('[data-testid^="audit-timeline-day-"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="audit-timeline-row"]').first()).toBeVisible()

    // Switch back to table
    await page.getByTestId('audit-view-table').click()
    await expect(page.getByTestId('audit-table')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('audit-timeline')).not.toBeVisible()
  })

  test('view mode is reflected in the URL', async ({ page }) => {
    await page.goto('/dashboard/audit')
    await expect(page.getByTestId('audit-view-toggle')).toBeVisible({ timeout: 15_000 })

    // Default URL has no view param (table is the implicit default)
    let url = new URL(page.url())
    expect(url.searchParams.get('view')).toBeNull()

    // Switch to timeline → URL gets view=timeline
    await page.getByTestId('audit-view-timeline').click()
    await expect(page.getByTestId('audit-timeline')).toBeVisible({ timeout: 5_000 })
    url = new URL(page.url())
    expect(url.searchParams.get('view')).toBe('timeline')

    // Switch back to table → URL drops the view param
    await page.getByTestId('audit-view-table').click()
    await expect(page.getByTestId('audit-table')).toBeVisible({ timeout: 5_000 })
    url = new URL(page.url())
    expect(url.searchParams.get('view')).toBeNull()
  })

  test('deep link with ?view=timeline lands on the timeline', async ({ page }) => {
    // Tier 122: a Berater can bookmark a specific
    // filter + view combo and the page honours it
    // on load.
    await page.goto('/dashboard/audit?view=timeline&entityType=Invoice')
    // The page should render the timeline (not the
    // table) and have the Invoice filter applied.
    await expect(page.getByTestId('audit-timeline')).toBeVisible({ timeout: 15_000 })
    // The entity-type select should be set to "Invoice"
    const select = page.getByTestId('audit-filter-entityType')
    await expect(select).toHaveValue('Invoice')
  })

  test('timeline rows open the existing detail modal', async ({ page }) => {
    await page.goto('/dashboard/audit?view=timeline')
    await expect(page.getByTestId('audit-timeline')).toBeVisible({ timeout: 15_000 })
    // Click the first timeline row
    const firstRow = page.locator('[data-testid="audit-timeline-row"]').first()
    await expect(firstRow).toBeVisible()
    await firstRow.click()
    // The existing detail modal opens
    await expect(page.getByTestId('audit-detail-modal')).toBeVisible({ timeout: 5_000 })
  })
})
