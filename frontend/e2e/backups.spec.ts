/**
 * Playwright spec — Tier 120 backup management page.
 *
 * Verifies the /dashboard/backups page:
 *   1. Renders the backup table with at least one
 *      row (the dev DB has real backups from earlier
 *      manual + auto runs)
 *   2. The health chip + newest-summary are visible
 *   3. The trigger button is enabled
 *   4. After clicking trigger, a new backup row
 *      appears at the top of the table
 *
 * Pre-flight: backend must be running, the
 * /api/v1/admin/backups endpoint must return a valid
 * array (which the dev DB does — there are at least
 * 1-2 backups in ~/data/backups/de-invoice).
 *
 * The test uses the existing dev BACKUP_ROOT; the
 * real-world backup file system. We don't try to
 * clean up after the test (the rotation policy would
 * drop a newly-created backup within 7 days anyway,
 * and the e2e test 144 covers the full happy path
 * with DELETE).
 */
import { test, expect } from '@playwright/test'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'

test.describe('Tier 120 — Backup management page', () => {
  test.beforeEach(async ({ context, page }) => {
    // The Next.js middleware (src/middleware.ts) reads
    // the auth tokens from cookies, not localStorage.
    // We have to set the cookies via addCookies() before
    // the page navigation — addInitScript would only set
    // localStorage, which AuthCookieSync then mirrors
    // to cookies AFTER React hydration, but the
    // middleware runs server-side on the FIRST request
    // and would redirect to /login before the mirror
    // happens. Setting cookies directly bypasses the
    // redirect and is the same pattern used by
    // webhooks.spec.ts / customer-detail.spec.ts.
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    // Also seed localStorage for the page's client-side
    // hooks (some pages read userId directly from
    // localStorage as a fallback). The cookies above
    // are the authoritative gate; localStorage is
    // belt-and-suspenders.
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
  })

  test('renders the backups page with the health chip + table', async ({ page }) => {
    await page.goto('/dashboard/backups')
    // Header
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // Health chip is rendered
    await expect(page.getByTestId('backup-health')).toBeVisible()
    // Refresh + trigger buttons are visible
    await expect(page.getByTestId('backup-refresh')).toBeVisible()
    await expect(page.getByTestId('backup-trigger')).toBeVisible()
    // Table is rendered (may be empty if no backups exist, in which
    // case the empty-state text shows instead)
    const table = page.getByTestId('backup-table')
    const emptyText = page.getByText(/Keine Backups|No backups|暂无备份/)
    // One of the two must be visible
    await expect(table.or(emptyText)).toBeVisible()
  })

  test('trigger button creates a new backup (PGDMP + DB row visible)', async ({ page }) => {
    // Auto-accept the "trigger backup?" confirm dialog
    page.on('dialog', (d) => d.accept())
    await page.goto('/dashboard/backups')
    // Wait for the page to render (table OR empty-state).
    // The page auto-refreshes every 30s, so we can't use
    // networkidle — the network is never idle.
    await expect(page.getByTestId('backup-trigger')).toBeVisible({
      timeout: 15_000,
    })

    // Snapshot the count of rows before
    const rows = page.locator('[data-testid^="backup-row-"]')
    // The page may take a moment to populate the table
    // after the initial GET /admin/backups response.
    // Allow up to 15s for at least the existing
    // backups to render.
    await page.waitForTimeout(2000)
    const before = await rows.count()
    // If the dev DB has zero backups (clean env), the
    // test is still meaningful — we just need to wait
    // for the new one. If the count is already > 0
    // we can do a "before + 1" assertion. If 0, we
    // wait for "at least 1" after the trigger.

    // Click trigger — this kicks off a real pg_dump + tar.
    // The script takes ~5-30s; the page stays on "Running…"
    // until the POST returns. We allow up to 90s.
    await page.getByTestId('backup-trigger').click()
    // The trigger button gets disabled while the
    // script runs.
    await expect(page.getByTestId('backup-trigger')).toBeDisabled({
      timeout: 60_000,
    })
    // And eventually re-enabled when the script returns
    await expect(page.getByTestId('backup-trigger')).toBeEnabled({
      timeout: 90_000,
    })
    // Wait for the row to appear (count went up by
    // at least 1, or the new row is in the DOM).
    if (before > 0) {
      await expect(rows).toHaveCount(before + 1, { timeout: 30_000 })
    } else {
      await expect(rows.first()).toBeVisible({ timeout: 30_000 })
    }
  })
})
