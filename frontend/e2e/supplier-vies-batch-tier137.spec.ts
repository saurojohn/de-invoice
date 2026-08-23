/**
 * Playwright spec — Tier 137 VIES batch check
 * button on /dashboard/suppliers.
 *
 * Verifies:
 *   1. The "🔍 Alle USt-IDs prüfen" button renders
 *      on the suppliers list page.
 *   2. Clicking it opens a modal with a start
 *      button.
 *   3. Clicking start calls the batch endpoint
 *      with entityType=supplier and shows the
 *      summary tiles + per-supplier result list.
 *   4. Mobile 375x667: no horizontal overflow
 *      on the suppliers page (action bar wraps).
 *
 * Pre-flight: backend on :3001, a test supplier
 * with a VAT ID is seeded (id=tier137-supp-001)
 * via the beforeAll SQL block.
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const SUPP_ID = 'tier137-supp-001'

test.describe('Tier 137 — VIES batch check (suppliers)', () => {
  test.beforeAll(() => {
    // Idempotent seed of a test supplier with a VAT ID.
    // DE987654321 is a real-looking but checksum-invalid
    // German VAT ID — VIES rejects it as 'invalid'.
    const sql = `
      INSERT INTO "Supplier" (id, "companyId", name, "vatId", address, contact, "paymentTerms", "createdAt", "updatedAt")
      VALUES ('${SUPP_ID}', '${COMPANY_ID}', 'Tier 137 Lieferant GmbH', 'DE987654321', '{}'::jsonb, '{}'::jsonb, 30, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET "vatId" = 'DE987654321', name = 'Tier 137 Lieferant GmbH';
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

  test('renders the batch check button in the action bar', async ({ page }) => {
    await page.goto('/dashboard/suppliers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('supplier-vies-batch-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await expect(btn).toBeEnabled()
  })

  test('clicking the button opens the modal with a start button', async ({ page }) => {
    await page.goto('/dashboard/suppliers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('supplier-vies-batch-button')
    await expect(btn).toBeEnabled({ timeout: 10_000 })
    await btn.click()
    const modal = page.getByTestId('supplier-vies-batch-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    const startBtn = page.getByTestId('supplier-vies-batch-start')
    await expect(startBtn).toBeVisible()
  })

  test('start button runs the batch and shows the summary', async ({ page }) => {
    await page.goto('/dashboard/suppliers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('supplier-vies-batch-button').click()
    await expect(page.getByTestId('supplier-vies-batch-modal')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('supplier-vies-batch-start').click()
    await expect(page.getByTestId('supplier-vies-batch-done')).toBeVisible({ timeout: 30_000 })
    // At least 1 row in the results table (the test supplier)
    const rows = page.locator('[data-testid^="supplier-vies-batch-row-"]')
    await expect(rows.first()).toBeVisible({ timeout: 5_000 })
    // Summary tiles render
    const valid = page.getByTestId('supplier-vies-batch-valid-count')
    const invalid = page.getByTestId('supplier-vies-batch-invalid-count')
    await expect(valid).toBeVisible()
    await expect(invalid).toBeVisible()
  })

  test('mobile 375x667: no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/suppliers')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('supplier-vies-batch-button')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
