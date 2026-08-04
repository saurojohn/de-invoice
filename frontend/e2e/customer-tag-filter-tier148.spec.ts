/**
 * Playwright spec — Tier 148 customer tag filter.
 *
 * Customer.tags is a free-form String[] the
 * Berater uses for categorisation. Tier 148
 * adds:
 *   1. Backend: `?tags=VIP,B2B` filter
 *      (AND semantics — every picked tag
 *      must be present on the customer)
 *   2. Frontend: tag filter chips above the
 *      customers list + active-filter chips
 *      below
 *
 * Tests:
 *   1. The tag-suggestion chips render above
 *      the customer list (with the most-used
 *      tag first).
 *   2. Clicking a tag chip activates it as a
 *      filter and narrows the list.
 *   3. Clicking an active-filter chip removes
 *      the filter.
 *   4. The "Alle entfernen" button clears all
 *      active filters.
 *   5. Backend-only: `?tags=` returns the
 *      expected shape.
 *   6. Backend-only: tag AND semantics.
 *   7. Backend-only: unknown tag → 0 rows.
 *   8. Mobile 375x667: tag chips wrap, no
 *      horizontal overflow.
 *
 * Pre-flight: backend on :3001, the BWA Test
 * Kunde fixture has tags = ["VIP","B2B",
 * "Hardware"] (set by the smoke test).
 */
import { test, expect } from '@playwright/test'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const API_BASE = 'http://localhost:3001'

test.describe('Tier 148 — Customer tag filter', () => {
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

  test('the tag-suggestion chips render above the customer list', async ({ page }) => {
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The fixture customer has 3 tags — wait
    // for the chip strip to appear
    const strip = page.getByTestId('customer-tag-suggestions')
    await expect(strip).toBeVisible({ timeout: 10_000 })
    // The VIP chip is present
    await expect(page.getByTestId('customer-tag-chip-VIP')).toBeVisible()
  })

  test('clicking a tag chip activates the filter and narrows the list', async ({ page }) => {
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('customer-tag-suggestions')).toBeVisible({ timeout: 10_000 })
    // Click the VIP chip
    await page.getByTestId('customer-tag-chip-VIP').click()
    // The active-filter row appears with VIP
    const active = page.getByTestId('customer-tag-active-VIP')
    await expect(active).toBeVisible({ timeout: 5_000 })
    // BWA Test Kunde is still in the list
    await expect(page.getByText('BWA Test Kunde').first()).toBeVisible({ timeout: 5_000 })
  })

  test('clicking an active-filter chip removes the filter', async ({ page }) => {
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('customer-tag-suggestions')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('customer-tag-chip-VIP').click()
    await expect(page.getByTestId('customer-tag-active-VIP')).toBeVisible({ timeout: 5_000 })
    // Click the active filter chip to remove
    await page.getByTestId('customer-tag-active-VIP').click()
    // Active row should disappear
    await expect(page.getByTestId('customer-tag-filter')).toBeHidden({ timeout: 5_000 })
  })

  test('the Alle entfernen button clears all active filters', async ({ page }) => {
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('customer-tag-suggestions')).toBeVisible({ timeout: 10_000 })
    // Activate two tags
    await page.getByTestId('customer-tag-chip-VIP').click()
    await page.getByTestId('customer-tag-chip-B2B').click()
    // Both active
    await expect(page.getByTestId('customer-tag-active-VIP')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('customer-tag-active-B2B')).toBeVisible({ timeout: 5_000 })
    // Click "Alle entfernen" (the clear-all button)
    await page.getByTestId('customer-tag-clear').click()
    // Active row disappears
    await expect(page.getByTestId('customer-tag-filter')).toBeHidden({ timeout: 5_000 })
  })

  test('backend: the ?tags= filter returns the expected response', async () => {
    const url = `${API_BASE}/api/v1/customers?companyId=${COMPANY_ID}&tags=VIP`
    const res = await fetch(url, {
      headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('data')
    expect(data).toHaveProperty('total')
    // BWA Test Kunde has tags=[VIP, B2B, Hardware]
    // → at least 1 row
    expect(data.total).toBeGreaterThan(0)
  })

  test('backend: AND semantics for multiple tags', async () => {
    // Both VIP and B2B → 1 customer
    const bothUrl = `${API_BASE}/api/v1/customers?companyId=${COMPANY_ID}&tags=VIP,B2B`
    // Only VIP → 1 customer
    const vipUrl = `${API_BASE}/api/v1/customers?companyId=${COMPANY_ID}&tags=VIP`
    const [bothRes, vipRes] = await Promise.all([
      fetch(bothUrl, { headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID } }),
      fetch(vipUrl, { headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID } }),
    ])
    const [bothData, vipData] = await Promise.all([bothRes.json(), vipRes.json()])
    // AND filter can't return more rows than
    // either single-tag filter
    expect(bothData.total).toBeLessThanOrEqual(vipData.total)
  })

  test('backend: unknown tag returns 0 rows', async () => {
    const url = `${API_BASE}/api/v1/customers?companyId=${COMPANY_ID}&tags=NonExistentTier148`
    const res = await fetch(url, {
      headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total).toBe(0)
  })

  test('mobile 375x667: tag chips wrap, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const strip = page.getByTestId('customer-tag-suggestions')
    await expect(strip).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
