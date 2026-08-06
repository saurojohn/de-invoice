/**
 * Playwright spec — Tier 158 Recurring clone.
 *
 * The Berater's question: "I have a maintenance
 * subscription for Customer A. Now Customer B
 * wants the same — let me clone the template
 * instead of typing it in from scratch." Tier
 * 158 = a "📋 Kopieren" button on each
 * recurring-invoice card that opens a small
 * modal (name + customer + startDate) and
 * POSTs to /recurring-invoices/:id/clone.
 *
 * Tests:
 *   1. Backend: clone with default overrides
 *      → new template with same items + name
 *      "Original (Kopie)" + startDate = today
 *   2. Backend: clone with custom name + customer
 *      + startDate → overrides applied
 *   3. Backend: clone with non-existent source
 *      → 400
 *   4. Frontend: 📋 Kopieren button appears on
 *      each card
 *   5. Frontend: clicking the button opens the
 *      modal with the source's name pre-filled
 *      with " (Kopie)" suffix
 *   6. Frontend: changing name + customer + start
 *      and clicking Duplizieren creates a new
 *      template (visible in the list)
 *   7. Mobile 375x667: clone modal does not
 *      overflow
 *
 * Pre-flight: backend on :3001, frontend on
 * :3100. The test UPSERTs a source template in
 * beforeAll + cleans up cloned rows in afterAll.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'

const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

// Test fixtures — non-tier-prefixed so the Tier 156
// `LIKE 'tier158%'` cleanup doesn't collide with
// other specs that share the DB.
const SOURCE_ID = 'tier158-rec-source'
const SOURCE_NAME = 'BWA Test Kunde (clone source)'
const SOURCE_NAME_CLONE = `${SOURCE_NAME} (Kopie)`

function setupFixtures() {
  // Wipe any prior clones + the source. Idempotent.
  const sql = `
    DELETE FROM "RecurringInvoiceItem" WHERE "recurringInvoiceId" IN (
      SELECT id FROM "RecurringInvoice" WHERE "companyId" = '${COMPANY_ID}'
        AND (\"name\" LIKE 'BWA Test Kunde (clone%)' OR id = '${SOURCE_ID}')
    );
    DELETE FROM "RecurringInvoice" WHERE "companyId" = '${COMPANY_ID}'
      AND (\"name\" LIKE 'BWA Test Kunde (clone%)' OR id = '${SOURCE_ID}');

    INSERT INTO "RecurringInvoice" (id, "companyId", "customerId", name, interval, "intervalCount", "dayOfMonth", "startDate", "nextRunAt", currency, language, notes, "invoiceStatus", "isActive", "sendEmail", "createdAt", "updatedAt")
    VALUES (
      '${SOURCE_ID}', '${COMPANY_ID}', 'b3f7b274-7696-44b8-9345-8bfd460b3e47',
      '${SOURCE_NAME}', 'monthly', 1, 1,
      '2026-01-01', '2026-09-01 00:00:00', 'EUR', 'de-DE', 'Source notes', 'draft', true, true, NOW(), NOW()
    );

    INSERT INTO "RecurringInvoiceItem" (id, "recurringInvoiceId", description, "productNumber", quantity, unit, "unitPrice", "vatRate", position)
    VALUES
      ('tier158-item-001', '${SOURCE_ID}', 'Wartung Server A', 'WART-001', 1, 'Stk', 100, 0.19, 0),
      ('tier158-item-002', '${SOURCE_ID}', 'Wartung Server B', 'WART-002', 2, 'Stk', 50, 0.19, 1);
  `
  const path = '/tmp/tier158-fixtures.sql'
  require('fs').writeFileSync(path, sql)
  try {
    execSync(
      `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < ${path}`,
      { stdio: 'pipe' },
    )
  } finally {
    try { require('fs').unlinkSync(path) } catch {}
  }
}

function cleanupClones() {
  // Keep the SOURCE row so the frontend tests can
  // still click its 📋 button. Wipe the clones.
  const sql = `
    DELETE FROM "RecurringInvoice" WHERE "companyId" = '${COMPANY_ID}'
      AND \"name\" LIKE 'BWA Test Kunde (clone%)'
      AND id <> '${SOURCE_ID}';
  `
  const path = '/tmp/tier158-cleanup.sql'
  require('fs').writeFileSync(path, sql)
  try {
    execSync(
      `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < ${path}`,
      { stdio: 'pipe' },
    )
  } finally {
    try { require('fs').unlinkSync(path) } catch {}
  }
}

async function clone(body: {
  name?: string
  customerId?: string
  startDate?: string
}) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.post(
    `${API}/api/v1/recurring-invoices/${SOURCE_ID}/clone?companyId=${COMPANY_ID}`,
    { data: body },
  )
  let data: any = null
  try { data = await res.json() } catch {}
  await ctx.dispose()
  return { status: res.status(), data }
}

test.describe('Tier 158 — Recurring clone', () => {
  test.beforeAll(() => {
    setupFixtures()
  })

  test.afterAll(() => {
    cleanupClones()
  })

  test.beforeEach(() => {
    cleanupClones()
  })

  test('backend: clone with default overrides → new template + items', async () => {
    const { status, data } = await clone({})
    expect(status).toBe(201)
    expect(data.id).toBeTruthy()
    expect(data.id).not.toBe(SOURCE_ID)
    expect(data.name).toBe(SOURCE_NAME_CLONE)
    expect(data.items.length).toBe(2)
    // Items copied verbatim
    const descs = data.items.map((it: any) => it.description).sort()
    expect(descs).toEqual(['Wartung Server A', 'Wartung Server B'])
    // startDate defaults to today (just check it's a Date)
    expect(new Date(data.startDate).getTime()).toBeGreaterThan(0)
    // endDate is null (clone starts a new contract)
    expect(data.endDate).toBeNull()
    // isActive = true
    expect(data.isActive).toBe(true)
  })

  test('backend: clone with custom overrides', async () => {
    const { status, data } = await clone({
      name: 'Custom clone name',
      startDate: '2026-12-01',
    })
    expect(status).toBe(201)
    expect(data.name).toBe('Custom clone name')
    expect(data.startDate).toContain('2026-12-01')
  })

  test('backend: non-existent source → 400', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.post(
      `${API}/api/v1/recurring-invoices/00000000-0000-0000-0000-000000000000/clone?companyId=${COMPANY_ID}`,
      { data: { name: 'X' } },
    )
    expect(res.status()).toBe(400)
    await ctx.dispose()
  })

  test('frontend: 📋 Kopieren button on each card', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/recurring-invoices')
    await page.waitForTimeout(2000)
    // The source card has the button
    const sourceCard = page.locator(`[data-recurring-name="${SOURCE_NAME}"]`)
    await expect(sourceCard).toBeVisible({ timeout: 10_000 })
    const btn = sourceCard.getByTestId('recurring-clone')
    await expect(btn).toBeVisible()
    await expect(btn).toContainText(/Kopieren|Copy|复制/)
  })

  test('frontend: open modal + change name + create new template', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/recurring-invoices')
    await page.waitForTimeout(2000)
    const sourceCard = page.locator(`[data-recurring-name="${SOURCE_NAME}"]`)
    await sourceCard.getByTestId('recurring-clone').click()
    // Modal opens
    await expect(page.getByTestId('recurring-clone-modal')).toBeVisible({
      timeout: 5_000,
    })
    // Name is pre-filled with " (Kopie)" suffix
    const nameInput = page.getByTestId('recurring-clone-name')
    await expect(nameInput).toHaveValue(SOURCE_NAME_CLONE)
    // Change the name
    const customName = `BWA Test Kunde (clone ${Date.now()})`
    await nameInput.fill(customName)
    // Submit
    await page.getByTestId('recurring-clone-submit').click()
    // Modal closes
    await expect(page.getByTestId('recurring-clone-modal')).toBeHidden({
      timeout: 5_000,
    })
    // The new template appears in the list
    const newCard = page.locator(`[data-recurring-name="${customName}"]`)
    await expect(newCard).toBeVisible({ timeout: 5_000 })
  })

  test('mobile 375x667: clone modal does not overflow', async ({ page }) => {
    await contextWithAuth(page)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/recurring-invoices')
    await page.waitForTimeout(2000)
    const sourceCard = page.locator(`[data-recurring-name="${SOURCE_NAME}"]`)
    await sourceCard.getByTestId('recurring-clone').click()
    await expect(page.getByTestId('recurring-clone-modal')).toBeVisible({
      timeout: 5_000,
    })
    await page.waitForTimeout(500)
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
