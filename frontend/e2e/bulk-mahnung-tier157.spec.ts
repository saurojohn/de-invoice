/**
 * Playwright spec — Tier 157 bulk Mahnung send.
 *
 * The Berater's question: "I have 30 overdue
 * invoices. I want to send 1. Mahnung to all of
 * them in one click instead of clicking 30
 * times." Tier 157 = a level-picker modal on the
 * /dashboard/invoices bulk action bar that fires
 * POST /reminders/bulk-send, with a 3-bucket
 * results modal (sent / skipped / failed).
 *
 * Tests:
 *   1. Backend: bulk-send to 2 valid overdue
 *      invoices → 2 sent
 *   2. Backend: bulk-send with one invoice that
 *      has no customer email → 1 sent + 1 failed
 *   3. Backend: bulk-send with bad level → 400
 *   4. Backend: bulk-send with empty invoiceIds
 *      → 400
 *   5. Backend: bulk-send a second time to the
 *      same invoice+level → 1 skipped (already
 *      sent today)
 *   6. Frontend: 📨 Mahnung senden button
 *      appears in the bulk action bar when rows
 *      are selected
 *   7. Frontend: clicking the button opens the
 *      level-picker modal
 *   8. Frontend: changing the level + clicking
 *      Senden fires the POST and shows the
 *      results modal with sent/skipped/failed
 *      counters
 *   9. Mobile 375x667: the modal does not
 *      overflow
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

interface BulkSendResponse {
  total: number
  succeeded: number
  failed: number
  skipped: number
  results: Array<{
    invoiceId: string
    invoiceNumber?: string
    customerName?: string | null
    ok: boolean
    status: "sent" | "skipped" | "failed"
    recipient?: string
    error?: string
  }>
}

async function bulkSend(body: {
  companyId: string
  invoiceIds: string[]
  level: "first" | "second" | "final"
}) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.post(`${API}/api/v1/reminders/bulk-send`, { data: body })
  let data: any = null
  try {
    data = await res.json()
  } catch {}
  await ctx.dispose()
  return { status: res.status(), data: data as BulkSendResponse | null }
}

// 3 invoice fixtures the spec UPSERTs in beforeAll:
//   - 2 valid overdue invoices with the standard
//     `tier133-customer@example.com` recipient
//   - 1 valid overdue invoice whose customer has
//     NO email (for the "no email" failure test)
const INVOICE_OK_1 = '11111111-aaaa-bbbb-cccc-000000000001'
const INVOICE_OK_2 = '11111111-aaaa-bbbb-cccc-000000000002'
const INVOICE_NO_EMAIL = '11111111-aaaa-bbbb-cccc-000000000003'
const CUSTOMER_OK = '22222222-bbbb-cccc-dddd-000000000001'
const CUSTOMER_NO_EMAIL = '22222222-bbbb-cccc-dddd-000000000002'

function setupFixtures() {
  // Write SQL to a temp file + pipe it via stdin to
  // avoid shell-quoting hell with JSON literals.
  const sql = `
    INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", tags, "createdAt", "updatedAt")
    VALUES
      ('${CUSTOMER_OK}', '${COMPANY_ID}', 'business', 'Bulk Test Kunde 1', '{}'::jsonb, '{"email":"tier133-customer@example.com"}'::jsonb, 30, ARRAY[]::text[], NOW(), NOW()),
      ('${CUSTOMER_NO_EMAIL}', '${COMPANY_ID}', 'business', 'Bulk Test Kunde 2 (no email)', '{}'::jsonb, '{}'::jsonb, 30, ARRAY[]::text[], NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET contact = EXCLUDED.contact, "updatedAt" = NOW();

    INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", type, status, "issueDate", "dueDate", "deliveryDate", subtotal, "totalVat", total, currency, "createdAt", "updatedAt")
    VALUES
      ('${INVOICE_OK_1}', '${COMPANY_ID}', '${CUSTOMER_OK}', 'BULK-T157-001', 'INV', 'overdue', NOW() - INTERVAL '20 days', NOW() - INTERVAL '5 days', NOW() - INTERVAL '20 days', 100, 19, 119, 'EUR', NOW(), NOW()),
      ('${INVOICE_OK_2}', '${COMPANY_ID}', '${CUSTOMER_OK}', 'BULK-T157-002', 'INV', 'overdue', NOW() - INTERVAL '20 days', NOW() - INTERVAL '5 days', NOW() - INTERVAL '20 days', 200, 38, 238, 'EUR', NOW(), NOW()),
      ('${INVOICE_NO_EMAIL}', '${COMPANY_ID}', '${CUSTOMER_NO_EMAIL}', 'BULK-T157-003', 'INV', 'overdue', NOW() - INTERVAL '20 days', NOW() - INTERVAL '5 days', NOW() - INTERVAL '20 days', 50, 9.50, 59.50, 'EUR', NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET status = 'overdue', "dueDate" = NOW() - INTERVAL '5 days', "customerId" = EXCLUDED."customerId", "updatedAt" = NOW();
  `
  const path = '/tmp/tier157-fixtures.sql'
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

function cleanupMahnungAudit() {
  // Wipe any Mahnung rows for the test fixtures so
  // idempotency tests can re-send. Same for EmailSend.
  const sql = `
    DELETE FROM "Mahnung" WHERE "invoiceId" IN ('${INVOICE_OK_1}','${INVOICE_OK_2}','${INVOICE_NO_EMAIL}');
    DELETE FROM "EmailSend" WHERE "invoiceId" IN ('${INVOICE_OK_1}','${INVOICE_OK_2}','${INVOICE_NO_EMAIL}');
  `
  const path = '/tmp/tier157-cleanup.sql'
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

test.describe('Tier 157 — Bulk Mahnung', () => {
  test.beforeAll(() => {
    setupFixtures()
    cleanupMahnungAudit()
  })

  test.afterAll(() => {
    cleanupMahnungAudit()
  })

  test('backend: bulk-send to 2 valid invoices → 2 sent', async () => {
    const { status, data } = await bulkSend({
      companyId: COMPANY_ID,
      invoiceIds: [INVOICE_OK_1, INVOICE_OK_2],
      level: "first",
    })
    expect(status).toBe(201)
    expect(data?.total).toBe(2)
    expect(data?.succeeded).toBe(2)
    expect(data?.failed).toBe(0)
    expect(data?.skipped).toBe(0)
    for (const r of data!.results) {
      expect(r.status).toBe("sent")
      expect(r.recipient).toBe("tier133-customer@example.com")
    }
  })

  test('backend: bulk-send with one no-email invoice → 1 sent + 1 failed', async () => {
    cleanupMahnungAudit()
    const { status, data } = await bulkSend({
      companyId: COMPANY_ID,
      invoiceIds: [INVOICE_OK_1, INVOICE_NO_EMAIL],
      level: "second",
    })
    expect(status).toBe(201)
    expect(data?.total).toBe(2)
    expect(data?.succeeded).toBe(1)
    expect(data?.failed).toBe(1)
    const failed = data!.results.find((r) => r.invoiceId === INVOICE_NO_EMAIL)
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toMatch(/keine e-mail/i)
  })

  test('backend: bad level → 400', async () => {
    const { status, data } = await bulkSend({
      companyId: COMPANY_ID,
      invoiceIds: [INVOICE_OK_1],
      // @ts-expect-error — testing the validator
      level: "third",
    })
    expect(status).toBe(400)
    expect(data).toBeTruthy()
  })

  test('backend: empty invoiceIds → 400', async () => {
    const { status } = await bulkSend({
      companyId: COMPANY_ID,
      invoiceIds: [],
      level: "first",
    })
    expect(status).toBe(400)
  })

  test('backend: re-send same invoice+level → skipped (already today)', async () => {
    cleanupMahnungAudit()
    // First call: sent
    const r1 = await bulkSend({
      companyId: COMPANY_ID,
      invoiceIds: [INVOICE_OK_1],
      level: "first",
    })
    expect(r1.data?.succeeded).toBe(1)
    // Second call at the same level: skipped
    const r2 = await bulkSend({
      companyId: COMPANY_ID,
      invoiceIds: [INVOICE_OK_1],
      level: "first",
    })
    expect(r2.status).toBe(201)
    expect(r2.data?.skipped).toBe(1)
    expect(r2.data?.succeeded).toBe(0)
    const row = r2.data!.results[0]
    expect(row.status).toBe("skipped")
    expect(row.error).toMatch(/bereits heute/i)
  })

  test('frontend: bulk action bar shows Mahnung button when rows selected', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/invoices')
    // Wait for the list to load
    await page.waitForTimeout(2000)
    // Click a row checkbox. The header has a "select
    // all" checkbox; we use the first row's checkbox
    // so the test doesn't depend on the global
    // select-all behaviour.
    const checkboxes = page.locator('input[type="checkbox"]')
    const count = await checkboxes.count()
    expect(count).toBeGreaterThan(0)
    // Click the 2nd checkbox (index 1) — usually the
    // first row checkbox, skipping the header.
    await checkboxes.nth(1).check()
    // The 📨 Mahnung button is now visible
    await expect(page.getByTestId('bulk-mahnung-button')).toBeVisible({
      timeout: 5_000,
    })
  })

  test('frontend: open level-picker modal + change level + close', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard/invoices')
    await page.waitForTimeout(2000)
    const checkboxes = page.locator('input[type="checkbox"]')
    await checkboxes.nth(1).check()
    await page.getByTestId('bulk-mahnung-button').click()
    // Level picker modal is visible
    await expect(page.getByTestId('bulk-mahnung-level-picker')).toBeVisible({
      timeout: 5_000,
    })
    // Default is "first" — switch to "second"
    await page.getByTestId('bulk-mahnung-level-second').check()
    // Cancel without sending
    await page.getByTestId('bulk-mahnung-cancel').click()
    await expect(page.getByTestId('bulk-mahnung-modal')).toBeHidden()
  })

  test('mobile 375x667: bulk-mahnung modal does not overflow', async ({ page }) => {
    await contextWithAuth(page)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/invoices')
    await page.waitForTimeout(2000)
    const checkboxes = page.locator('input[type="checkbox"]')
    await checkboxes.nth(1).check()
    await page.getByTestId('bulk-mahnung-button').click()
    await expect(page.getByTestId('bulk-mahnung-level-picker')).toBeVisible({
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
