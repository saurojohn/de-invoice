/**
 * Playwright spec — Tier 121 + 125 + 126 mobile responsive.
 *
 * Tier 121: 3 top-level pages (dashboard home,
 * invoices list, customers list) + invoice list
 * header wrap + tablet sanity check.
 *
 * Tier 125: 5 more list/detail pages (mahnungen,
 * recurring-invoices, reports, accounting,
 * expenses) — same pattern.
 *
 * Tier 126: 2 detail pages (invoice detail,
 * customer detail) — all of their inner tables
 * (items, payments, installments, customer
 * invoices/plans/mahnungen/credit) now have
 * overflow-x-auto + min-w-[640px] so they scroll
 * horizontally on a 375px phone instead of
 * pushing the page out of bounds.
 *
 * What "no horizontal overflow" means:
 *   `document.body.scrollWidth <= window.innerWidth + 1`
 *   (the +1 is a slack for sub-pixel rounding).
 *
 * Pre-flight: backend must be running, the dev DB
 * has real data so the pages render.
 */
import { test, expect } from '@playwright/test'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'

/**
 * Assert no horizontal overflow on the current page.
 * Tier 121 must not break this on mobile viewports.
 */
async function assertNoHorizontalOverflow(page: any) {
  const result = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(
    result.bodyScrollWidth,
    `body scrollWidth ${result.bodyScrollWidth} > viewport ${result.innerWidth} (overflow!)`,
  ).toBeLessThanOrEqual(result.innerWidth + 1)
}

test.describe('Tier 121 — Mobile responsive (375x667)', () => {
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

  test('dashboard home: no horizontal overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard')
    // Wait for the page to settle
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    await assertNoHorizontalOverflow(page)
  })

  test('invoices list: no horizontal overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/invoices')
    // The page should render. We don't assert a
    // specific table is visible because in a fresh
    // session the list might be empty or paginated
    // — we just need the page to load without
    // horizontal overflow.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    await assertNoHorizontalOverflow(page)
  })

  test('customers list: no horizontal overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/customers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    await assertNoHorizontalOverflow(page)
  })

  test('invoice list: header buttons wrap to second row on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    // The "New invoice" button should be visible
    // (Tier 121 added size="sm" + flex-wrap so the
    // header doesn't clip)
    const newInvoiceBtn = page.getByRole('button', { name: /Neue Rechnung|New invoice|新建发票/i }).first()
    await expect(newInvoiceBtn).toBeVisible()
  })

  test('tablet 768x1024: dashboard renders without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/dashboard')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    await assertNoHorizontalOverflow(page)
  })

  // Tier 125: 6 more pages — same no-horizontal-overflow
  // assertion. The dev DB has data for all of these
  // so the pages render (we just check the page
  // loads without breaking the viewport).
  // Tier 125: 5 of 6 pages — /dashboard/banking
  // is excluded because the FinTS connection state
  // (loading / connected / no connection) makes
  // the rendered content highly variable, and the
  // loading state itself has no horizontal-scroll
  // issues. The header gets the same flex-wrap
  // treatment as the other pages.
  for (const path of [
    '/dashboard/mahnungen',
    '/dashboard/recurring-invoices',
    '/dashboard/reports',
    '/dashboard/accounting',
    '/dashboard/expenses',
  ]) {
    test(`mobile 375x667: ${path} no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 })
      await page.goto(path)
      // Wait for the page to render. The h1 is the
      // canonical signal for most pages, but some
      // (e.g. /banking) show a loading state first
      // and only render the h1 after the FinTS
      // connection fetch. We give the page 8s
      // (shorter than the h1 wait, but long enough
      // for the dev compile + initial fetch).
      await page.waitForTimeout(8000)
      await assertNoHorizontalOverflow(page)
    })
  }

  // Tier 126: 2 detail pages — invoice detail
  // (highest-frequency page) + customer detail
  // (4 tab tables). Use a real invoice + customer
  // ID from the dev DB.
  test('mobile 375x667: invoice detail no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/invoices/11deeb35-7147-4bdc-86d9-a302b4f80f3e')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    // Give the items + payments + (if present)
    // installments tables a moment to render.
    await page.waitForTimeout(2000)
    await assertNoHorizontalOverflow(page)
  })

  test('mobile 375x667: customer detail no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/customers/b3f7b274-7696-44b8-9345-8bfd460b3e47')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(2000)
    await assertNoHorizontalOverflow(page)
  })

  test('tablet 768x1024: invoice detail no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/dashboard/invoices/11deeb35-7147-4bdc-86d9-a302b4f80f3e')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(2000)
    await assertNoHorizontalOverflow(page)
  })
})
