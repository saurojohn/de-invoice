/**
 * Playwright spec — Tier 129 recurring invoice email.
 *
 * Verifies the new "Rechnung nach Generierung an Kunden
 * senden" checkbox on the recurring template form +
 * the auto-email behaviour when the "Jetzt generieren"
 * button is clicked.
 *
 * Pre-flight: backend must be running, the test
 * customer (BWA Test Kunde) must have an email set
 * in contact.email, and the recurring template form
 * must be reachable at /dashboard/recurring-invoices.
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId

test.describe('Tier 129 — Recurring invoice auto-email', () => {
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

  test('recurring form shows the sendEmail checkbox, default checked', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Open the create form
    await page.getByRole('button', { name: /Neu|New|新建/ }).first().click()
    const checkbox = page.getByTestId('recurring-form-send-email')
    await expect(checkbox).toBeVisible({ timeout: 10_000 })
    // Default checked — the user opted into recurring,
    // they want the email by default
    await expect(checkbox).toBeChecked()
  })

  test('unchecking the checkbox persists sendEmail=false on save', async ({ page, request }) => {
    // Tier 365: this test was an unconditional skip ("keep the suite
    // idempotent") since Tier 129 — and it would have failed: create() and
    // update() in recurring.service.ts never wrote sendEmail, so the column's
    // default `true` stood and unchecking the box did nothing. It now creates
    // its own template through the form and deletes it afterwards.
    const headers = { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID }
    const name = `Tier 365 ohne E-Mail ${Date.now()}`
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30_000 })
    await page.waitForTimeout(500)
    await page.getByTestId('recurring-new-button').click()
    await page.getByTestId('recurring-form-name').fill(name)
    // BWA Test Kunde from ci-seed.sh
    await page.getByTestId('recurring-form-customer').selectOption('b3f7b274-7696-44b8-9345-8bfd460b3e47')
    await page.getByTestId('recurring-item-description').first().fill('Tier 365 Wartung')
    await page.getByTestId('recurring-item-unit-price').first().fill('100')
    const checkbox = page.getByTestId('recurring-form-send-email')
    await expect(checkbox).toBeChecked()
    await checkbox.uncheck()
    await expect(checkbox).not.toBeChecked()

    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/v1\/recurring-invoices\?/.test(r.url()),
    )
    await page.getByTestId('recurring-form-save').click()
    const res = await created
    expect([200, 201], `create failed: ${await res.text()}`).toContain(res.status())
    const tpl = await res.json()
    try {
      const get = await request.get(
        `http://localhost:3001/api/v1/recurring-invoices/${tpl.id}?companyId=${COMPANY_ID}`,
        { headers },
      )
      expect(get.status()).toBe(200)
      expect((await get.json()).sendEmail, 'sendEmail stored for the new template').toBe(false)
    } finally {
      await request.delete(
        `http://localhost:3001/api/v1/recurring-invoices/${tpl.id}?companyId=${COMPANY_ID}`,
        { headers },
      )
    }
  })

  test('mobile 375x667: no horizontal overflow on recurring form', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
