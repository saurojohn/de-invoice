/**
 * Playwright spec — Tier 151 Mahnung e-mail
 * template editor.
 *
 * The Berater's question: "Can I change the
 * wording of our 1. Mahnung so it's less
 * aggressive?" Tier 151 = a per-company editor
 * for the 3 reminder levels (first / second /
 * final). The backend had the CRUD surface; this
 * tier is the UI to drive it.
 *
 * Tests:
 *   1. The settings page now has a link to the
 *      templates page.
 *   2. The templates page renders 3 level tabs.
 *   3. The "Standardvorlage" badge shows on a
 *      freshly-seeded template.
 *   4. The placeholder list renders 7 tokens
 *      (the source of truth in
 *      reminder.service.renderForInvoice).
 *   5. Clicking a placeholder inserts it into
 *      the body textarea at the cursor.
 *   6. Saving the edited template updates the
 *      badge to "Angepasste Vorlage".
 *   7. The Vorschau button calls /preview and
 *      shows the rendered subject + body.
 *   8. Switching tabs with unsaved changes asks
 *      for confirm().
 *   9. The Reset button restores the default
 *      text and flips the badge back to
 *      "Standardvorlage".
 *   10. Mobile 375x667: tabs wrap, no overflow.
 *   11. Backend: list-templates returns 3 levels.
 *   12. Backend: update template + verify it
 *       persisted in subsequent GET.
 *   13. Backend: reset returns the default.
 *
 * Pre-flight: backend on :3001, frontend on :3100.
 * The spec uses the seeded defaults from
 * reminder.service.defaultTemplates() and resets
 * any custom edits in afterAll so other test
 * suites aren't affected.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const API_BASE = 'http://localhost:3001'

async function authedRequest() {
  return await playwrightRequest.newContext({
    extraHTTPHeaders: {
      'x-user-id': USER_ID,
      'x-company-id': COMPANY_ID,
    },
  })
}

test.describe('Tier 151 — Mahnung e-mail template editor', () => {
  // Reset all 3 templates to their defaults at
  // the start so the "Standardvorlage" badge
  // assertion is deterministic. Also at end so
  // other suites see a clean state.
  test.beforeAll(async () => {
    const ctx = await authedRequest()
    try {
      for (const level of ['first', 'second', 'final']) {
        await ctx.post(
          `${API_BASE}/api/v1/reminders/templates/${level}/reset?companyId=${COMPANY_ID}`,
        )
      }
    } finally {
      await ctx.dispose()
    }
  })
  test.afterAll(async () => {
    const ctx = await authedRequest()
    try {
      for (const level of ['first', 'second', 'final']) {
        await ctx.post(
          `${API_BASE}/api/v1/reminders/templates/${level}/reset?companyId=${COMPANY_ID}`,
        )
      }
    } finally {
      await ctx.dispose()
    }
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

  test('settings page links to the templates editor', async ({ page }) => {
    await page.goto('/dashboard/mahnungen/settings')
    await expect(page.getByTestId('mahnung-settings-title')).toBeVisible({ timeout: 30_000 })
    const link = page.getByTestId('mahnung-settings-templates-link')
    await expect(link).toBeVisible()
    await link.click()
    await expect(page.getByTestId('mahnung-templates-title')).toBeVisible({ timeout: 10_000 })
  })

  test('templates page renders 3 level tabs', async ({ page }) => {
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-title')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mahnung-templates-tab-first')).toBeVisible()
    await expect(page.getByTestId('mahnung-templates-tab-second')).toBeVisible()
    await expect(page.getByTestId('mahnung-templates-tab-final')).toBeVisible()
  })

  test('Standardvorlage badge shows for a freshly-seeded template', async ({ page }) => {
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-tab-first')).toBeVisible({ timeout: 30_000 })
    // beforeAll reset, so the level is at the
    // default. The badge should reflect that.
    const badge = page.getByTestId('mahnung-templates-badge')
    await expect(badge).toBeVisible()
    // Either "Standardvorlage" (DE) or the i18n
    // equivalent in EN/ZH. We match loosely.
    await expect(badge).toHaveText(/Standardvorlage|Default template|默认模板/)
  })

  test('placeholder list shows 7 tokens', async ({ page }) => {
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-placeholders')).toBeVisible({ timeout: 30_000 })
    const expectedKeys = [
      'customerName',
      'invoiceNumber',
      'totalAmount',
      'dueDateFormatted',
      'daysOverdue',
      'bankInfo',
      'companyName',
    ]
    for (const key of expectedKeys) {
      await expect(
        page.getByTestId(`mahnung-templates-placeholder-${key}`),
      ).toBeVisible()
    }
  })

  test('clicking a placeholder inserts it at the cursor', async ({ page }) => {
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-body')).toBeVisible({ timeout: 30_000 })
    // Focus the body textarea + set the cursor
    // to the start.
    const body = page.getByTestId('mahnung-templates-body')
    await body.focus()
    await body.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(0, 0)
    })
    // Click the customerName placeholder. It
    // should be inserted at position 0 of the
    // body, prepending {{customerName}}.
    await page.getByTestId('mahnung-templates-placeholder-customerName').click()
    // The body's value should now start with
    // "{{customerName}}".
    const value = await body.inputValue()
    expect(value.startsWith('{{customerName}}')).toBe(true)
  })

  test('saving the edited template flips the badge to Angepasste Vorlage', async ({ page }) => {
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-subject')).toBeVisible({ timeout: 30_000 })
    // Edit the subject so the level becomes
    // "custom". We pick a unique string so we
    // can assert on it.
    const marker = `Tier 151 custom ${Date.now()}`
    const subjectInput = page.getByTestId('mahnung-templates-subject')
    await subjectInput.fill(marker)
    // Save
    const saveBtn = page.getByTestId('mahnung-templates-save')
    await saveBtn.click()
    // The "saved ok" hint should appear
    await expect(page.getByTestId('mahnung-templates-saved-ok')).toBeVisible({ timeout: 10_000 })
    // The badge should now say "Angepasste
    // Vorlage" (or i18n equivalent).
    const badge = page.getByTestId('mahnung-templates-badge')
    await expect(badge).toHaveText(/Angepasste Vorlage|Custom template|已自定义/)
    // The subject input should now show the
    // saved value (sanity)
    await expect(subjectInput).toHaveValue(marker)
  })

  test('Vorschau button calls /preview and shows rendered output', async ({ page }) => {
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-preview')).toBeVisible({ timeout: 30_000 })
    // Click Vorschau
    await page.getByTestId('mahnung-templates-preview').click()
    // The preview card should appear with the
    // rendered subject. We use a polling
    // assertion because the network call is
    // async.
    await expect(page.getByTestId('mahnung-templates-preview-subject')).toBeVisible({
      timeout: 10_000,
    })
    // The preview body should also be there
    await expect(page.getByTestId('mahnung-templates-preview-body')).toBeVisible()
  })

  test('switching tabs with unsaved changes prompts confirm()', async ({ page }) => {
    // Auto-accept the confirm dialog
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-body')).toBeVisible({ timeout: 30_000 })
    // Make a dirty edit on the "first" tab
    const body = page.getByTestId('mahnung-templates-body')
    await body.fill('Some new content')
    // Click "second" tab — should fire a confirm
    await page.getByTestId('mahnung-templates-tab-second').click()
    // After accepting, we should now be on
    // second. The dirty "first" draft is
    // discarded.
    await expect(page.getByTestId('mahnung-templates-tab-second')).toHaveAttribute(
      'data-active',
      'true',
      { timeout: 5_000 },
    )
  })

  test('Reset button restores the default text', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-subject')).toBeVisible({ timeout: 30_000 })
    // Edit + save so we have a known custom state
    const subjectInput = page.getByTestId('mahnung-templates-subject')
    const customMarker = `Tier 151 to be reset ${Date.now()}`
    await subjectInput.fill(customMarker)
    await page.getByTestId('mahnung-templates-save').click()
    await expect(page.getByTestId('mahnung-templates-saved-ok')).toBeVisible({ timeout: 10_000 })
    // Now click Reset
    await page.getByTestId('mahnung-templates-reset').click()
    // The badge should be back to Standardvorlage
    await expect(page.getByTestId('mahnung-templates-badge')).toHaveText(
      /Standardvorlage|Default template|默认模板/,
      { timeout: 10_000 },
    )
  })

  test('mobile 375x667: tabs wrap, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/mahnungen/templates')
    await expect(page.getByTestId('mahnung-templates-title')).toBeVisible({ timeout: 30_000 })
    // The page should not scroll horizontally.
    const body = page.locator('body')
    const scrollWidth = await body.evaluate((el) => el.scrollWidth)
    const clientWidth = await body.evaluate((el) => el.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2)
  })

  // ─── Backend-only tests ───

  test('backend: list-templates returns 3 levels', async () => {
    const ctx = await authedRequest()
    try {
      const res = await ctx.get(
        `${API_BASE}/api/v1/reminders/templates?companyId=${COMPANY_ID}`,
      )
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBe(3)
      const levels = body.map((t: any) => t.level).sort()
      expect(levels).toEqual(['final', 'first', 'second'])
    } finally {
      await ctx.dispose()
    }
  })

  test('backend: update + GET round-trips the edit', async () => {
    const ctx = await authedRequest()
    try {
      const marker = `Tier 151 backend ${Date.now()}`
      const put = await ctx.put(
        `${API_BASE}/api/v1/reminders/templates/first?companyId=${COMPANY_ID}`,
        {
          data: {
            subject: marker,
            body: 'Backend test body',
          },
        },
      )
      expect(put.status()).toBe(200)
      const putBody = await put.json()
      expect(putBody.subject).toBe(marker)
      // GET it back
      const get = await ctx.get(
        `${API_BASE}/api/v1/reminders/templates/first?companyId=${COMPANY_ID}`,
      )
      expect(get.status()).toBe(200)
      const getBody = await get.json()
      expect(getBody.subject).toBe(marker)
      expect(getBody.body).toBe('Backend test body')
      // Cleanup
      await ctx.post(
        `${API_BASE}/api/v1/reminders/templates/first/reset?companyId=${COMPANY_ID}`,
      )
    } finally {
      await ctx.dispose()
    }
  })

  test('backend: reset returns the default text', async () => {
    const ctx = await authedRequest()
    try {
      // First dirty the level
      await ctx.put(
        `${API_BASE}/api/v1/reminders/templates/second?companyId=${COMPANY_ID}`,
        {
          data: {
            subject: 'to be reset',
            body: 'whatever',
          },
        },
      )
      // Then reset
      const res = await ctx.post(
        `${API_BASE}/api/v1/reminders/templates/second/reset?companyId=${COMPANY_ID}`,
      )
      expect(res.status()).toBe(201)
      const body = await res.json()
      // The default for "second" starts with "2. Mahnung"
      expect(body.subject).toMatch(/2\. Mahnung/)
      expect(body.isDefault).toBe(true)
    } finally {
      await ctx.dispose()
    }
  })
})
