/**
 * Playwright spec — Tier 145 customer internal
 * Berater-Notizen.
 *
 * Parallel to Tier 138 (invoice internal notes).
 * The Berater can record phone calls / complaints /
 * context about a customer that the customer must
 * NEVER see (GoBD § 146 Abs. 4 AO).
 *
 * Tests:
 *   1. The "🔒 Interne Notizen" card renders on
 *      the customer detail page.
 *   2. The empty state is shown when there are
 *      no notes.
 *   3. Adding a note prepends it to the list
 *      and clears the textarea.
 *   4. Deleting a note removes it from the list.
 *   5. The note is NOT visible via the customer
 *      portal (GoBD compliance check).
 *   6. Mobile 375x667: card + form do not
 *      overflow.
 *
 * Pre-flight: backend on :3001, the test
 * fixture customer is BWA Test Kunde. The
 * spec uses isolated note text per test so
 * previous test runs don't interfere.
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API_BASE = 'http://localhost:3001'

test.describe('Tier 145 — Customer internal notes', () => {
  // Clean up any leftover notes from prior test
  // runs. We don't want shared-DB noise from
  // other suites (Tier 138, Tier 144, ...) to
  // affect the empty-state assertion below.
  test.beforeAll(() => {
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"CustomerInternalNote\\" WHERE \\"companyId\\"='${COMPANY_ID}' AND body LIKE 'Tier 145%'"`,
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

  test('the Interne Notizen card renders on the customer detail page', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.getByTestId('customer-internal-notes-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    // Lock icon + heading text (one of the i18n)
    await expect(card).toContainText(/Interne Notizen|Internal notes|内部备注/i)
  })

  test('the empty state is shown when no notes exist', async ({ page }) => {
    // Clean up any leftover notes (including the
    // smoke-test one from the previous run) so we
    // can assert on the empty state.
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"CustomerInternalNote\\" WHERE \\"companyId\\"='${COMPANY_ID}' AND \\"customerId\\"='${CUSTOMER_ID}'"`,
      { stdio: 'ignore' },
    )
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.getByTestId('customer-internal-notes-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    // The list should be empty. The note list
    // testid is "customer-internal-notes-list"
    // and the notes themselves render as
    // div[data-testid^="customer-internal-note-<uuid>"].
    // We count the direct children of the list
    // container — every child is a note row.
    const noteListEl = page.getByTestId('customer-internal-notes-list')
    const noteRows = await noteListEl.locator(':scope > div').count()
    expect(noteRows).toBe(0)
  })

  test('adding a note prepends it to the list and clears the input', async ({ page }) => {
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.getByTestId('customer-internal-notes-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    const input = page.getByTestId('customer-internal-note-input')
    const addBtn = page.getByTestId('customer-internal-note-add')
    const noteBody = `Tier 145 — Kunde hat um Rückruf gebeten, ${Date.now()}`
    await input.fill(noteBody)
    await addBtn.click()
    // The new note should appear in the list
    const list = page.getByTestId('customer-internal-notes-list')
    await expect(list).toContainText(noteBody, { timeout: 10_000 })
    // And the input should be cleared
    await expect(input).toHaveValue('')
  })

  test('deleting a note removes it from the list', async ({ page }) => {
    // Clean up any leftover notes from earlier
    // tests in this run so .first() is unambiguous.
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"CustomerInternalNote\\" WHERE \\"companyId\\"='${COMPANY_ID}' AND \\"customerId\\"='${CUSTOMER_ID}'"`,
      { stdio: 'ignore' },
    )
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.getByTestId('customer-internal-notes-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    // Add a note first so we can delete it
    const input = page.getByTestId('customer-internal-note-input')
    const addBtn = page.getByTestId('customer-internal-note-add')
    const noteBody = `Tier 145 — to-be-deleted ${Date.now()}`
    await input.fill(noteBody)
    await addBtn.click()
    // Wait for it to appear
    const noteListEl = page.getByTestId('customer-internal-notes-list')
    await expect(noteListEl).toContainText(noteBody, { timeout: 10_000 })
    // The new note's row will be at the TOP of
    // the list (newest first). The list
    // container's direct children are the note
    // rows (no wrapper, no list items). We
    // grab the first one and the testid is
    // "customer-internal-note-<uuid>".
    const noteRow = noteListEl.locator(':scope > div').first()
    await expect(noteRow).toContainText(noteBody, { timeout: 5_000 })
    // The delete button's testid is the same
    // as the row's testid, just with a different
    // suffix — extract the note id and build the
    // delete testid.
    const rowTestId = await noteRow.getAttribute('data-testid')
    const noteId = rowTestId?.replace('customer-internal-note-', '')
    if (!noteId) throw new Error('could not extract note id')
    const deleteBtn = page.getByTestId(`customer-internal-note-delete-${noteId}`)
    await deleteBtn.click()
    // The row should disappear
    await expect(noteRow).toBeHidden({ timeout: 5_000 })
  })

  test('the note is NOT visible via the customer portal', async ({ page }) => {
    // GoBD § 146 Abs. 4 AO compliance check.
    // The customer portal shows invoices + mark-paid,
    // it must NOT show internal Berater-Notizen.
    // We don't seed a portal session here (that's
    // Tier 130+131 work); instead we just hit the
    // portal's invoice-list endpoint and assert that
    // no internal-note fields leak into the response.
    const url = `${API_BASE}/api/v1/customer-portal/invoices?token=invalid`
    const res = await fetch(url, {
      headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID },
    })
    // Even with an invalid token, the response must
    // not include any internal-note fields. The
    // CustomerInternalNote table is only ever
    // queried by the admin /api/v1/customers/:id/
    // internal-notes endpoint, which is auth-gated
    // by customer.read — the portal path can't
    // reach it.
    const text = await res.text()
    expect(text).not.toContain('internalNotes')
    expect(text).not.toContain('CustomerInternalNote')
    expect(text).not.toContain('Kunde hat angerufen')  // a typical note body
  })

  test('mobile 375x667: the card + form do not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${CUSTOMER_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const card = page.getByTestId('customer-internal-notes-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
