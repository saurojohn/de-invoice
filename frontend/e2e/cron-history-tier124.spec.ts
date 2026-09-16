/**
 * Playwright spec — Tier 124 cron health history drilldown.
 *
 * Verifies the new per-cron history page:
 *   1. /dashboard/system-health shows 8 cron rows
 *      (was 7, +1 for daily-auto-backup from Tier 120).
 *   2. Clicking a cron name navigates to the
 *      drilldown page.
 *   3. The drilldown page renders a stats summary
 *      with 5 chips (success / failed / skipped /
 *      avg duration / p95 duration).
 *   4. The status filter dropdown updates the URL
 *      and the table contents.
 *   5. The history table renders past runs.
 *
 * Pre-flight: backend must be running. The dev DB
 * has real cron history from the running backend
 * (especially the 1-minute webhook-retry-worker,
 * which has ~50+ entries).
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
test.describe('Tier 124 — Cron health history drilldown', () => {
  test.beforeEach(async ({ context, page }) => {
    // The Next.js middleware reads cookies, not
    // localStorage. addCookies() before navigation
    // bypasses the redirect — same pattern as the
    // other admin specs. We also seed localStorage
    // via addInitScript as a belt-and-suspenders
    // fallback for any page that reads userId
    // directly from localStorage.
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
  })

  test('system-health table links to per-cron drilldown', async ({ page }) => {
    await page.goto('/dashboard/system-health')
    // The cron table renders
    await expect(page.getByTestId('system-health-table')).toBeVisible({ timeout: 15_000 })
    // One row per registered cron: 9 since Tier 403 added session-cleanup
    // (was 8, which was 7 + daily-auto-backup). The count is pinned rather
    // than >= on purpose — the same deliberate-edit gate as the EXPECTED
    // registry in cron-health.service.ts and e2e/143.
    const rows = page.locator('[data-testid^="cron-row-"]')
    await expect(rows).toHaveCount(9)

    // Click webhook-retry-worker (most likely to
    // have history — it runs every minute)
    const target = page.getByTestId('cron-row-webhook-retry-worker')
    await target.click()
    // Lands on /dashboard/system-health/webhook-retry-worker
    await page.waitForURL(/\/dashboard\/system-health\/webhook-retry-worker/)
    // The drilldown page renders
    await expect(page.getByTestId('cron-history-stats')).toBeVisible({ timeout: 15_000 })
  })

  test('history page renders stats + table', async ({ page }) => {
    await page.goto('/dashboard/system-health/webhook-retry-worker')
    await expect(page.getByTestId('cron-history-stats')).toBeVisible({ timeout: 15_000 })
    // 5 stats chips render
    const stats = page.getByTestId('cron-history-stats')
    await expect(stats).toContainText(/erfolgreich|successful|成功/i)
    await expect(stats).toContainText(/fehl|failed|失败/i)
    // History table renders
    await expect(page.getByTestId('cron-history-table')).toBeVisible({ timeout: 15_000 })
    // At least one row
    const rows = page.locator('[data-testid="cron-history-row"]')
    await expect(rows.first()).toBeVisible()
  })

  test('status filter updates URL and table', async ({ page }) => {
    await page.goto('/dashboard/system-health/webhook-retry-worker')
    await expect(page.getByTestId('cron-history-table')).toBeVisible({ timeout: 15_000 })

    // Filter to "success" (dev webhook-retry is
    // mostly success — no failures typically)
    await page.getByTestId('cron-history-status-filter').selectOption('success')
    // URL gets ?status=success
    await expect(page).toHaveURL(/status=success/)
    // The table still renders (might be empty if
    // the cron had no successes, but the table
    // itself is visible).
    await expect(page.getByTestId('cron-history-table')).toBeVisible()
  })

  test('back button returns to system-health', async ({ page }) => {
    await page.goto('/dashboard/system-health/webhook-retry-worker')
    await expect(page.getByTestId('cron-history-back')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('cron-history-back').click()
    await page.waitForURL(/\/dashboard\/system-health\/?$/)
    await expect(page.getByTestId('system-health-table')).toBeVisible({ timeout: 15_000 })
  })
})
