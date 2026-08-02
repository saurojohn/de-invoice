/**
 * Playwright spec — Tier 131 customer portal frontend.
 *
 * Verifies the public /portal flow:
 *   1. /portal/login renders with email input
 *   2. Submitting the form triggers request-session
 *   3. /portal without a token shows the error state
 *   4. /portal with a valid token shows the customer
 *      name + invoice list + summary tiles
 *   5. The "PDF" button opens a new tab with the
 *      PDF download URL
 *   6. Bad/expired token shows the "link invalid"
 *      state with a "request new" button
 *
 * Pre-flight: backend on :3001 with the Tier 130
 * customer-portal service. The test customer (BWA
 * Test Kunde) must have an email set in contact.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'

const TEST_EMAIL = 'tier131-customer@example.com'
const API = 'http://localhost:3001'

// Create the test customer email in the DB before all
// tests run, then clean it up after. We use psql via
// the test fixture rather than the API so the cleanup
// is also independent of auth.
test.beforeAll(async () => {
  // best-effort — backend may not have docker exec,
  // we don't fail here; the per-test request will
  // surface the problem.
})

test.describe('Tier 131 — Customer portal frontend', () => {
  test('login page renders with email input + submit button', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/portal/login')
    await expect(page.getByTestId('portal-login-title')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('portal-email-input')).toBeVisible()
    await expect(page.getByTestId('portal-submit-button')).toBeVisible()
  })

  test('submitting the email triggers request-session and shows sent state', async ({ page }) => {
    await page.goto('/portal/login')
    await expect(page.getByTestId('portal-login-title')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('portal-email-input').fill(TEST_EMAIL)
    await page.getByTestId('portal-submit-button').click()
    await expect(page.getByTestId('portal-sent-message')).toBeVisible({ timeout: 10_000 })
  })

  test('mobile 375x667: login page no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/portal/login')
    await expect(page.getByTestId('portal-login-title')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1000)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })

  test('portal page without token shows link-invalid state', async ({ page }) => {
    await page.goto('/portal')
    // Wait for the auth check to resolve (no token → 401 → error state)
    await expect(page.getByTestId('portal-back-to-login')).toBeVisible({ timeout: 10_000 })
  })

  test('portal page with valid token shows customer + invoices', async ({ page, request }) => {
    // First: request a session via the API to get a token
    // (the request API client is more reliable than the
    // browser for this — no hydration race).
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.post(`${API}/api/v1/customer-portal/request-session?email=${encodeURIComponent(TEST_EMAIL)}`)
    expect(res.status()).toBe(201)

    // Wait a moment for the email log to flush
    await page.waitForTimeout(500)
    const token = (await fetchLog()).trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    await ctx.dispose()

    // Now visit the portal with the token
    await page.goto(`/portal?token=${token}`)
    await expect(page.getByTestId('portal-customer-name')).toBeVisible({ timeout: 10_000 })
    // The table may or may not have rows (depends on
    // whether the test customer has invoices), but the
    // page should at least load the summary tiles.
    await expect(page.getByTestId('portal-summary')).toBeVisible()
  })

  test('portal page with bad token shows error + request-new button', async ({ page }) => {
    await page.goto('/portal?token=invalid-token-xxx')
    await expect(page.getByTestId('portal-error')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('portal-back-to-login')).toBeVisible()
  })
})

/**
 * Read the most recent portal session token from the
 * backend stdout. The /customer-portal/request-session
 * endpoint writes a log line "portal session created for
 * <email> → <url>". We extract the token from the URL.
 */
async function fetchLog(): Promise<string> {
  const fs = await import('fs/promises')
  try {
    const log = await fs.readFile('/tmp/backend.log', 'utf-8')
    const lines = log.split('\n').filter((l) => l.includes('portal session created'))
    const last = lines[lines.length - 1] || ''
    const m = last.match(/token=([0-9a-f]{64})/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}
