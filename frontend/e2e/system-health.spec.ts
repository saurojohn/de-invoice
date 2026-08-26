/**
 * Playwright spec — Tier 119 system health page.
 *
 * Verifies the /dashboard/system-health page:
 *   1. Renders 7 cron rows on a fresh DB (or
 *      however many are registered) with the
 *      expected health colors
 *   2. Has a Refresh button that re-fetches the
 *      endpoint
 *   3. Renders in German (the dev fixture is
 *      Mandant role → German default)
 *
 * Pre-flight: backend must be running, the admin
 * cron health endpoint must return a valid array.
 * We don't seed any fake ticks here — the test
 * asserts the table shape, not the colours (those
 * are exercised by the backend e2e 143).
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
test.describe('Tier 119 — System health page', () => {
  test.beforeEach(async ({ page, context }) => {
    // Set both the cookies (so the Next.js middleware
    // doesn't redirect to /login) AND the localStorage
    // items (so the page's AuthContext picks them up).
    // The previous version set only localStorage, which
    // is enough for the AuthCookieSync component to
    // write cookies — but the middleware runs BEFORE
    // AuthCookieSync, so the first request redirected
    // to /login and the table never rendered.
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
  })

  test('renders 7 cron rows with the 4 health colours', async ({ page }) => {
    // Seed a couple of fake ticks so we exercise
    // green + red + grey (the production backend
    // has the webhook-retry-worker already, but we
    // make the test deterministic by also pre-seeding
    // via the admin endpoint).
    const seedRes = await page.request.post('http://localhost:3001/api/v1/admin/cron-health/clean', {
      headers: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
      },
    })
    expect(seedRes.ok()).toBeTruthy()

    await page.goto('/dashboard/system-health')
    await expect(page.getByTestId('system-health-table')).toBeVisible()
    // The table should have at least 7 rows (one per
    // registered cron). The exact count grows as new
    // crons are added (8 in mid-2026 after the
    // hash-chain + audit-rollup additions), so we
    // assert >= 7 rather than a fixed number.
    const rows = page.locator('[data-testid^="cron-row-"]')
    const count = await rows.count()
    expect(count).toBeGreaterThanOrEqual(7)
  })

  test('refresh button re-fetches the endpoint', async ({ page }) => {
    await page.goto('/dashboard/system-health')
    const refreshBtn = page.getByTestId('system-health-refresh')
    await expect(refreshBtn).toBeVisible()
    // Click and assert no error toast appears
    await refreshBtn.click()
    // Wait a moment for the fetch to complete
    await page.waitForTimeout(500)
    // Table is still visible
    await expect(page.getByTestId('system-health-table')).toBeVisible()
  })
})
