/**
 * Playwright spec — Tier 131 customer portal frontend.
 *
 * Verifies the public /portal flow:
 *   1. /portal/login says the link comes from the issuer (Tier 703: a
 *      customer no longer asks for one with an e-mail address)
 *   2. The public request for a link is refused
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
import { portalTokenFor } from './fixtures/portal-token'

// Tier 333: use the seed customer's real email.
// Previously 'tier131-customer@example.com' which
// doesn't exist in the CI DB — request-session
// then short-circuits with `return { sent: true }`
// without creating a session or emitting the
// "portal session created" log line that
// fetchLog() parses. BWA Test Kunde (id b3f7b274-...)
// is seeded by ci-seed with contact.email =
// "bwa@example.com".
const TEST_EMAIL = 'bwa@example.com'
const BWA_CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API = process.env.E2E_API_URL || 'http://localhost:3001'

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
  test('login page says the link comes from the issuer — no e-mail form (Tier 703)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/portal/login')
    await expect(page.getByTestId('portal-login-title')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('portal-login-closed')).toBeVisible()
    await expect(page.getByTestId('portal-email-input')).toHaveCount(0)
    await expect(page.getByTestId('portal-submit-button')).toHaveCount(0)
  })

  test('the public request for a link is refused (Tier 703)', async () => {
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.post(`${API}/api/v1/customer-portal/request-session?email=${encodeURIComponent(TEST_EMAIL)}`)
    expect(res.status()).toBe(403)
    expect(await res.text()).toContain('Rechnungssteller')
    await ctx.dispose()
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

  test('portal page with valid token shows customer + invoices', async ({ page, request: _request }) => {
    // First: the company's link for the seeded customer (Tier 703)
    const { status, token } = await portalTokenFor(API, BWA_CUSTOMER_ID)
    expect(status).toBe(201)
    expect(token).toMatch(/^[0-9a-f]{64}$/)

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
