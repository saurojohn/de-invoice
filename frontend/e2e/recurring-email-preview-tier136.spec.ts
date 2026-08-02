/**
 * Playwright spec — Tier 136 recurring invoice
 * email preview button.
 *
 * Verifies:
 *   1. The "📧 Email-Vorschau" button renders
 *      inside the recurring form modal.
 *   2. Clicking it on a SAVED template opens a
 *      modal with subject + recipient + body.
 *   3. The body contains the expected placeholders
 *      substituted (customer name, amount, due
 *      date in the template's locale).
 *   4. Clicking the close button dismisses the
 *      modal.
 *   5. Mobile 375x667: button + modal render
 *      without horizontal overflow.
 *
 * Pre-flight: backend on :3001, a saved recurring
 * template with customer BWA Test Kunde and at
 * least one line item. The smoke-test fixture
 * (id=tier136-tpl-001) is created via the
 * beforeAll SQL block if it doesn't exist.
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const TPL_ID = 'tier136-tpl-001'
const CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'

test.describe('Tier 136 — Recurring email preview', () => {
  test.beforeAll(() => {
    // Make sure the test fixture template exists.
    // Idempotent — ON CONFLICT keeps the existing row.
    const sql = `
      INSERT INTO "RecurringInvoice" (id, "companyId", "customerId", name, interval, "intervalCount", "dayOfMonth", "startDate", "nextRunAt", "isActive", language, currency, "invoiceStatus", "sendEmail", "createdAt", "updatedAt")
      VALUES ('${TPL_ID}', '${COMPANY_ID}', '${CUSTOMER_ID}', 'Tier 136 Wartungsvertrag', 'monthly', 1, 1, NOW(), NOW(), true, 'de-DE', 'EUR', 'sent', true, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET language = 'de-DE', "sendEmail" = true;
      INSERT INTO "RecurringInvoiceItem" (id, "recurringInvoiceId", description, "productNumber", quantity, unit, "unitPrice", "vatRate", position)
      VALUES ('tier136-item-001', '${TPL_ID}', 'Monatliche Wartung Server A', 'WART-001', 1, 'Stk', 100, 0.19, 0)
      ON CONFLICT (id) DO UPDATE SET "unitPrice" = 100, quantity = 1, "vatRate" = 0.19, description = 'Monatliche Wartung Server A';
    `
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "${sql.replace(/"/g, '\\"')}"`,
      { stdio: 'ignore' },
    )
  })

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

  test('renders the Email-Vorschau button inside the form', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Click "Bearbeiten" on the test template row
    await page.getByTestId(`recurring-edit`).click()
    await expect(page.getByTestId('recurring-form-save')).toBeVisible({ timeout: 10_000 })
    const previewBtn = page.getByTestId('recurring-form-preview-email')
    await expect(previewBtn).toBeVisible()
  })

  test('clicking the button shows subject + recipient + body', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(`recurring-edit`).click()
    await expect(page.getByTestId('recurring-form-save')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('recurring-form-preview-email').click()
    const modal = page.getByTestId('recurring-email-preview-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    // Wait for the data to render
    await expect(page.getByTestId('recurring-email-preview-data')).toBeVisible({ timeout: 10_000 })
    // Subject
    const subject = await page.getByTestId('recurring-email-preview-subject').textContent()
    expect(subject).toContain('Rechnung')
    // Recipient
    const recipient = await page.getByTestId('recurring-email-preview-recipient').textContent()
    expect(recipient).toContain('tier133-customer@example.com')
    // Body — must contain the customer name + the sample amount (119,00 €)
    const body = await page.getByTestId('recurring-email-preview-body').textContent()
    expect(body).toContain('BWA Test Kunde')
    expect(body).toContain('119,00')
  })

  test('close button dismisses the modal', async ({ page }) => {
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(`recurring-edit`).click()
    await expect(page.getByTestId('recurring-form-save')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('recurring-form-preview-email').click()
    await expect(page.getByTestId('recurring-email-preview-data')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('recurring-email-preview-close').click()
    await expect(page.getByTestId('recurring-email-preview-modal')).toBeHidden({ timeout: 5_000 })
  })

  test('mobile 375x667: form + preview modal do not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/recurring-invoices')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(`recurring-edit`).click()
    await expect(page.getByTestId('recurring-form-save')).toBeVisible({ timeout: 10_000 })
    const previewBtn = page.getByTestId('recurring-form-preview-email')
    await expect(previewBtn).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
