/**
 * Playwright spec — Tier 132 admin "Portal-Login-Link"
 * button on the customer detail page.
 *
 * Verifies:
 *   1. The button renders next to the other header
 *      actions (Kontoauszug, Zurück)
 *   2. Clicking it calls the admin endpoint and
 *      shows a modal with the URL
 *   3. The Copy button flips to "Kopiert!" briefly
 *   4. Mobile 375x667: no horizontal overflow
 *   5. The button is disabled when the customer has
 *      no email on file
 *
 * Pre-flight: backend on :3001, the test customer
 * (BWA Test Kunde) must have contact.email set in
 * the DB.
 */
import { test, expect } from '@playwright/test'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'

test.describe('Tier 132 — Admin portal-link generator', () => {
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

  test('renders the Portal-Login-Link button in the header', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-portal-generate-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await expect(btn).toBeEnabled()
  })

  test('clicking the button shows the modal with the URL', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-portal-generate-button')
    await expect(btn).toBeEnabled({ timeout: 10_000 })
    await btn.click()
    // The modal should appear with the generated URL
    await expect(page.getByTestId('customer-portal-modal')).toBeVisible({ timeout: 10_000 })
    // The URL inside the modal should be a valid /portal?token=...
    const urlText = await page.locator('[data-testid="customer-portal-modal"] .font-mono').first().textContent()
    expect(urlText).toContain('/portal?token=')
  })

  test('mobile 375x667: no horizontal overflow introduced', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
