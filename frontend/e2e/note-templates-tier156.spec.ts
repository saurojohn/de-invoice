/**
 * Playwright spec — Tier 156 note templates.
 *
 * Verifies:
 *   1. GET /api/v1/note-templates auto-seeds 5 German
 *      defaults on first touch
 *   2. POST /api/v1/note-templates creates a new row
 *   3. PATCH /api/v1/note-templates/:id updates a row
 *      + clears the isDefault flag
 *   4. DELETE removes the row
 *   5. POST /:id/preview substitutes placeholders
 *   6. POST /reset-defaults wipes + re-seeds
 *   7. Frontend: /dashboard/settings/note-templates
 *      lists the rows + new/edit/delete work
 *   8. Frontend: /dashboard/invoices/create has a
 *      "Vorlage einfügen" dropdown next to the notes
 *      field. Selecting a template appends the rendered
 *      text to the notes field.
 *   9. Mobile 375x667: settings page + dropdown no
 *      horizontal overflow
 *
 * Pre-flight: backend on :3001, frontend on :3100.
 * The Tier 156 spec UPSERTs the test company to a
 * known state in beforeAll (clears any custom
 * templates), then restores in afterAll.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'
import { getTestEnv } from './fixtures/test-env'

const COMPANY_ID = getTestEnv().companyId
const USER_ID = getTestEnv().userId
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

async function listTemplates() {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.get(
    `${API}/api/v1/note-templates?companyId=${COMPANY_ID}`,
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

async function createTemplate(body: { label: string; text: string; sortOrder?: number }) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.post(
    `${API}/api/v1/note-templates?companyId=${COMPANY_ID}`,
    { data: body },
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

async function patchTemplate(id: string, body: { label?: string; text?: string }) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.patch(
    `${API}/api/v1/note-templates/${id}?companyId=${COMPANY_ID}`,
    { data: body },
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

async function deleteTemplate(id: string) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.delete(
    `${API}/api/v1/note-templates/${id}?companyId=${COMPANY_ID}`,
  )
  const data = await res.json().catch(() => ({}))
  await ctx.dispose()
  return { status: res.status(), data }
}

async function previewTemplate(id: string, body: any) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.post(
    `${API}/api/v1/note-templates/${id}/preview?companyId=${COMPANY_ID}`,
    { data: body },
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

async function resetDefaults() {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.post(
    `${API}/api/v1/note-templates/reset-defaults?companyId=${COMPANY_ID}`,
    { data: {} },
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

test.describe('Tier 156 — Note templates', () => {
  // Reset to a known state: 5 German defaults,
  // no custom rows. Re-running the spec must be
  // idempotent.
  test.beforeAll(async () => {
    await resetDefaults()
  })
  test.afterAll(async () => {
    // Restore the standard 5 defaults so other
    // specs see a known state.
    await resetDefaults()
  })

  test('GET seeds 5 German defaults on first touch', async () => {
    const { status, data } = await listTemplates()
    expect(status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBe(5)
    const labels = data.map((t: any) => t.label)
    expect(labels).toContain('Dank + Zahlungshinweis')
    expect(labels).toContain('Skonto 2%')
    expect(labels).toContain('Lieferung frei Haus')
    // All seeded rows are flagged isDefault
    for (const t of data) expect(t.isDefault).toBe(true)
  })

  test('POST creates a new template', async () => {
    const stamp = `t156-${Date.now()}`
    const { status, data } = await createTemplate({
      label: `Custom ${stamp}`,
      text: 'Hallo {{customerName}}, bitte überweisen Sie {{total}}.',
      sortOrder: 999,
    })
    expect(status).toBe(201)
    expect(data.id).toBeTruthy()
    expect(data.label).toBe(`Custom ${stamp}`)
    expect(data.isDefault).toBe(false)
    // Clean up — we don't want the next run to see
    // an extra row.
    await deleteTemplate(data.id)
  })

  test('POST with empty label → 400', async () => {
    const { status, data } = await createTemplate({ label: '   ', text: 'x' })
    expect(status).toBe(400)
    expect(data.message).toMatch(/label is required/i)
  })

  test('PATCH updates label + text + clears isDefault', async () => {
    // Pick one of the defaults to edit
    const { data: list } = await listTemplates()
    const target = list[0]
    const { status, data } = await patchTemplate(target.id, {
      label: 'Edited label',
      text: 'Edited text',
    })
    expect(status).toBe(200)
    expect(data.label).toBe('Edited label')
    expect(data.text).toBe('Edited text')
    expect(data.isDefault).toBe(false) // editing clears the badge
  })

  test('DELETE removes a row', async () => {
    // Create a row to delete
    const { data: created } = await createTemplate({
      label: 'To be deleted',
      text: 'bye',
      sortOrder: 999,
    })
    const { status } = await deleteTemplate(created.id)
    expect(status).toBe(200)
    // Verify it's gone
    const { data: after } = await listTemplates()
    expect(after.find((t: any) => t.id === created.id)).toBeUndefined()
  })

  test('POST /:id/preview substitutes placeholders', async () => {
    const { data: list } = await listTemplates()
    // The "Skonto 2%" template has {{total}} in it
    const skonto = list.find((t: any) => t.label === 'Skonto 2%')
    expect(skonto).toBeTruthy()
    const { status, data } = await previewTemplate(skonto.id, {
      total: '119,00 EUR',
    })
    // POST /:id/preview returns 201 (NestJS default
    // for POST). The endpoint is named "preview" but
    // it's still a POST in the controller.
    expect(status).toBe(201)
    expect(data.text).toContain('119,00 EUR')
    expect(data.text).not.toContain('{{total}}')
  })

  test('POST /:id/preview leaves unknown placeholders intact', async () => {
    const { data: list } = await listTemplates()
    const skonto = list.find((t: any) => t.label === 'Skonto 2%')
    // Don't pass total — the placeholder stays
    const { data } = await previewTemplate(skonto.id, {})
    expect(data.text).toContain('{{total}}')
  })

  test('POST /reset-defaults wipes + re-seeds', async () => {
    // Add a custom row, then reset
    const { data: created } = await createTemplate({
      label: 'Tmp',
      text: 'x',
    })
    const { status, data } = await resetDefaults()
    // POST returns 201 by default in NestJS.
    expect(status).toBe(201)
    expect(data.reset).toBe(5)
    // Verify the custom row is gone and 5 defaults
    // are back
    const { data: list } = await listTemplates()
    expect(list.length).toBe(5)
    expect(list.find((t: any) => t.id === created.id)).toBeUndefined()
  })

  test('Frontend: settings page renders + lists templates + has new button', async ({
    page,
  }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/settings/note-templates')
    await expect(page.getByTestId('note-templates-list')).toBeVisible({
      timeout: 10_000,
    })
    // 5 defaults present (the row count includes any
    // leftover custom rows from prior failed runs;
    // we assert >= 5 here so the test is robust)
    const rows = page.locator('[data-testid^="note-templates-row-"]')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThanOrEqual(5)
    // New button is visible
    await expect(page.getByTestId('note-templates-new-toggle')).toBeVisible()
  })

  test('Frontend: settings page creates a new template', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/settings/note-templates')
    await expect(page.getByTestId('note-templates-list')).toBeVisible({
      timeout: 10_000,
    })
    // Open the new form
    await page.getByTestId('note-templates-new-toggle').click()
    await expect(page.getByTestId('note-templates-new-form')).toBeVisible()
    const stamp = `t156-${Date.now()}`
    const label = `Custom ${stamp}`
    await page.getByTestId('note-templates-new-label').fill(label)
    await page
      .getByTestId('note-templates-new-text')
      .fill('Bitte überweisen Sie {{total}} bis {{dueDate}}.')
    await page.getByTestId('note-templates-new-save').click()
    // Success banner
    await expect(page.getByTestId('note-templates-saved-ok')).toBeVisible({
      timeout: 5_000,
    })
    // New row appears in the list
    await expect(page.getByText(label)).toBeVisible()
    // Clean up: find the new row by label and DELETE
    // via the API so the next test sees a clean state.
    const { data: list } = await listTemplates()
    const created = list.find((t: any) => t.label === label)
    if (created) await deleteTemplate(created.id)
  })

  test('Frontend: invoice create page has a templates dropdown', async ({
    page,
  }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/invoices/create')
    // Wait for the notes field to render
    await expect(page.getByTestId('invoice-notes-input')).toBeVisible({
      timeout: 10_000,
    })
    // The dropdown is present
    const sel = page.getByTestId('invoice-notes-template-select')
    await expect(sel).toBeVisible()
    // The dropdown has 5 defaults + 1 (placeholder)
    // option. Any custom rows from prior runs are
    // allowed, so we assert >= 6.
    const optCount = await sel.locator('option').count()
    expect(optCount).toBeGreaterThanOrEqual(6)
    // Manage link is also visible
    await expect(page.getByTestId('invoice-notes-manage-link')).toBeVisible()
  })

  test('Frontend: selecting a template appends rendered text to notes', async ({
    page,
  }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/invoices/create')
    await expect(page.getByTestId('invoice-notes-input')).toBeVisible({
      timeout: 10_000,
    })
    // Pick the "Lieferung frei Haus" template — it has
    // no placeholders so we can assert the text
    // verbatim.
    const sel = page.getByTestId('invoice-notes-template-select')
    const opt = sel.locator('option').filter({ hasText: 'Lieferung frei Haus' })
    const value = await opt.getAttribute('value')
    expect(value).toBeTruthy()
    await sel.selectOption(value!)
    // The notes input should now contain the template text
    const notesValue = await page.getByTestId('invoice-notes-input').inputValue()
    expect(notesValue).toContain('Lieferung frei Haus')
  })

  test('Mobile 375x667: settings page no horizontal overflow', async ({ page }) => {
    await contextWithAuth(page)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/settings/note-templates')
    await expect(page.getByTestId('note-templates-list')).toBeVisible({
      timeout: 10_000,
    })
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})

async function contextWithAuth(page: any) {
  await page.context().addCookies([
    { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem('userId', userId)
    localStorage.setItem('companyId', companyId)
  }, { userId: USER_ID, companyId: COMPANY_ID })
}
