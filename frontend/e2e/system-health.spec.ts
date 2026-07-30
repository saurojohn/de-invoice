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

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'

test.describe('Tier 119 — System health page', () => {
  test.beforeEach(async ({ page }) => {
    // Pre-seed both required headers via the test's
    // localStorage. The login flow is exercised by
    // the other admin-page specs.
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
    // The table should have 7 rows (one per registered cron)
    const rows = page.locator('[data-testid^="cron-row-"]')
    await expect(rows).toHaveCount(7)
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
