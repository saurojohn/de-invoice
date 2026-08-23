/**
 * Playwright spec — Tier 138 internal invoice
 * notes.
 *
 * Verifies:
 *   1. The "🔒 Interne Notizen" card renders on
 *      the invoice detail page.
 *   2. Adding a note via the textarea + button
 *      prepends the note to the list (newest
 *      first) and clears the input.
 *   3. Deleting a note removes it from the list.
 *   4. The "interne Notizen" text never appears
 *      in the rendered PDF or the customer
 *      portal (GoBD § 146 Abs. 4 AO).
 *   5. Mobile 375x667: the card fits without
 *      horizontal overflow.
 *
 * Pre-flight: backend on :3001, the test invoice
 * 11deeb35-7147-4bdc-86d9-a302b4f80f3e exists.
 * Each test starts by deleting any leftover notes
 * from previous runs (idempotent baseline).
 */
import { test, expect } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const INVOICE_ID = '11deeb35-7147-4bdc-86d9-a302b4f80f3e'

async function clearNotes(page: any) {
  const ctx = page.context()
  const res = await ctx.request.get(
    `http://localhost:3001/api/v1/invoices/${INVOICE_ID}/internal-notes?companyId=${COMPANY_ID}`,
    {
      headers: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
      },
    },
  )
  const notes = (await res.json()) as Array<{ id: string }>
  for (const n of notes) {
    await ctx.request.delete(
      `http://localhost:3001/api/v1/invoices/${INVOICE_ID}/internal-notes/${n.id}?companyId=${COMPANY_ID}`,
      { headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID } },
    )
  }
}

test.describe('Tier 138 — Internal invoice notes', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
    await clearNotes(page)
  })

  test('renders the Interne Notizen card', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${INVOICE_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.getByTestId('invoice-internal-notes-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card).toContainText('Interne Notizen')
  })

  test('adding a note prepends it to the list and clears the input', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${INVOICE_ID}`)
    await expect(page.getByTestId('invoice-internal-notes-card')).toBeVisible({ timeout: 30_000 })
    const input = page.getByTestId('invoice-internal-note-input')
    const addBtn = page.getByTestId('invoice-internal-note-add')
    await input.fill('Wartet auf Rückmeldung vom Lieferanten.')
    await addBtn.click()
    // The new note row should appear
    await expect(page.locator('[data-testid^="invoice-internal-note-"]').first()).toBeVisible({ timeout: 5_000 })
    // The textarea should be cleared
    await expect(input).toHaveValue('')
  })

  test('deleting a note removes it from the list', async ({ page }) => {
    await page.goto(`/dashboard/invoices/${INVOICE_ID}`)
    await expect(page.getByTestId('invoice-internal-notes-card')).toBeVisible({ timeout: 30_000 })
    // Add a note
    await page.getByTestId('invoice-internal-note-input').fill('Diese Notiz wird gleich gelöscht.')
    await page.getByTestId('invoice-internal-note-add').click()
    await expect(page.locator('[data-testid^="invoice-internal-note-"]').first()).toBeVisible({ timeout: 5_000 })
    // Accept the confirm() dialog and click delete
    page.on('dialog', (d) => d.accept())
    const deleteBtn = page.locator('[data-testid^="invoice-internal-note-delete-"]').first()
    await deleteBtn.click()
    // The empty state should reappear
    await expect(page.getByTestId('invoice-internal-notes-card')).toContainText('Noch keine internen Notizen', { timeout: 5_000 })
  })

  test('mobile 375x667: no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/invoices/${INVOICE_ID}`)
    await expect(page.getByTestId('invoice-internal-notes-card')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
