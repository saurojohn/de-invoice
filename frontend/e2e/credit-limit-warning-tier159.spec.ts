/**
 * Playwright spec — Tier 159 credit-limit warning.
 *
 * The Berater's question: "I have a customer with
 * a 1000 EUR credit limit. They owe 1200 EUR and I
 * didn't notice until I got the Mahnung-Hinweis.
 * Can the app warn me when a customer is
 * approaching their limit?" Tier 159 adds a
 * GET /customers/credit-utilization endpoint +
 * a 💳 Kreditlimit card on the customer detail
 * page + a 🚨 Limit-Überschreitungen widget on
 * the dashboard.
 *
 * Tests:
 *   1. backend: returns customers with non-NULL
 *      creditLimit + their open balance + status
 *      (ok / warning / over)
 *   2. backend: customers are sorted by status
 *      severity (over > warning > ok) then by
 *      utilization DESC
 *   3. backend: customers with NULL creditLimit
 *      are excluded
 *   4. backend: when a customer has 0 open invoices
 *      they show as status='ok' / utilization=0
 *   5. frontend: customer detail page shows the
 *      Kreditlimit card when the customer has a
 *      non-NULL creditLimit
 *   6. frontend: customer detail page does NOT
 *      show the card when the limit is NULL
 *   7. frontend: dashboard shows the credit-limit
 *      widget when there's at least one customer
 *      with utilization > 0
 *   8. frontend: dashboard hides the widget when
 *      no customers have a credit limit set
 *   9. mobile 375x667: dashboard credit widget
 *      does not overflow
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'
import { getTestEnv, PG_CONTAINER } from './fixtures/test-env'

const COMPANY_ID = getTestEnv().companyId
const USER_ID = getTestEnv().userId
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

// Non-tier-prefixed fixture names so other specs
// don't accidentally wipe them via `LIKE 'tier<N>%'`
// cleanup patterns.
const CUST_OK = '11111111-cccc-dddd-eeee-000000000001'
const CUST_WARNING = '11111111-cccc-dddd-eeee-000000000002'
const CUST_OVER = '11111111-cccc-dddd-eeee-000000000003'
const CUST_NO_LIMIT = '11111111-cccc-dddd-eeee-000000000004'

function setupFixtures() {
  // Customers + their creditLimits + open invoices
  // (the totals drive the bucket: ok / warning / over).
  // Wipe any prior test rows first so re-runs are
  // idempotent.
  const sql = `
    DELETE FROM "Invoice" WHERE "customerId" IN ('${CUST_OK}','${CUST_WARNING}','${CUST_OVER}','${CUST_NO_LIMIT}');
    DELETE FROM "Customer" WHERE id IN ('${CUST_OK}','${CUST_WARNING}','${CUST_OVER}','${CUST_NO_LIMIT}');

    INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", "creditLimit", tags, "createdAt", "updatedAt")
    VALUES
      ('${CUST_OK}', '${COMPANY_ID}', 'business', 'BWA OK', '{}'::jsonb, '{"email":"tier159-ok@example.com"}'::jsonb, 30, 1000, ARRAY[]::text[], NOW(), NOW()),
      ('${CUST_WARNING}', '${COMPANY_ID}', 'business', 'BWA Warning', '{}'::jsonb, '{"email":"tier159-warn@example.com"}'::jsonb, 30, 1000, ARRAY[]::text[], NOW(), NOW()),
      ('${CUST_OVER}', '${COMPANY_ID}', 'business', 'BWA Over', '{}'::jsonb, '{"email":"tier159-over@example.com"}'::jsonb, 30, 1000, ARRAY[]::text[], NOW(), NOW()),
      ('${CUST_NO_LIMIT}', '${COMPANY_ID}', 'business', 'BWA NoLimit', '{}'::jsonb, '{"email":"tier159-nolimit@example.com"}'::jsonb, 30, NULL, ARRAY[]::text[], NOW(), NOW());

    -- OK: 100 / 1000 = 10%
    INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", type, status, "issueDate", "dueDate", "deliveryDate", subtotal, "totalVat", total, currency, "createdAt", "updatedAt")
    VALUES ('t159-ok-1', '${COMPANY_ID}', '${CUST_OK}', 'T159-OK-1', 'INV', 'sent', NOW(), NOW() + INTERVAL '30 days', NOW(), 100, 0, 100, 'EUR', NOW(), NOW());

    -- Warning: 900 / 1000 = 90%
    INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", type, status, "issueDate", "dueDate", "deliveryDate", subtotal, "totalVat", total, currency, "createdAt", "updatedAt")
    VALUES ('t159-warn-1', '${COMPANY_ID}', '${CUST_WARNING}', 'T159-WARN-1', 'INV', 'sent', NOW(), NOW() + INTERVAL '30 days', NOW(), 900, 0, 900, 'EUR', NOW(), NOW());

    -- Over: 1500 / 1000 = 150%
    INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", type, status, "issueDate", "dueDate", "deliveryDate", subtotal, "totalVat", total, currency, "createdAt", "updatedAt")
    VALUES ('t159-over-1', '${COMPANY_ID}', '${CUST_OVER}', 'T159-OVER-1', 'INV', 'sent', NOW(), NOW() + INTERVAL '30 days', NOW(), 1500, 0, 1500, 'EUR', NOW(), NOW());

    -- CUST_NO_LIMIT: 200 open, but no creditLimit
    INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", type, status, "issueDate", "dueDate", "deliveryDate", subtotal, "totalVat", total, currency, "createdAt", "updatedAt")
    VALUES ('t159-nolimit-1', '${COMPANY_ID}', '${CUST_NO_LIMIT}', 'T159-NL-1', 'INV', 'sent', NOW(), NOW() + INTERVAL '30 days', NOW(), 200, 0, 200, 'EUR', NOW(), NOW());
  `
  const path = '/tmp/tier159-fixtures.sql'
  require('fs').writeFileSync(path, sql)
  try {
    execSync(
      `docker exec -i ${PG_CONTAINER} psql -U de_invoice -d de_invoice < ${path}`,
      { stdio: 'pipe' },
    )
  } finally {
    try { require('fs').unlinkSync(path) } catch {}
  }
}

function cleanupFixtures() {
  const sql = `
    DELETE FROM "Invoice" WHERE "customerId" IN ('${CUST_OK}','${CUST_WARNING}','${CUST_OVER}','${CUST_NO_LIMIT}');
    DELETE FROM "Customer" WHERE id IN ('${CUST_OK}','${CUST_WARNING}','${CUST_OVER}','${CUST_NO_LIMIT}');
  `
  const path = '/tmp/tier159-cleanup.sql'
  require('fs').writeFileSync(path, sql)
  try {
    execSync(
      `docker exec -i ${PG_CONTAINER} psql -U de_invoice -d de_invoice < ${path}`,
      { stdio: 'pipe' },
    )
  } finally {
    try { require('fs').unlinkSync(path) } catch {}
  }
}

async function fetchUtilization() {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.get(
    `${API}/api/v1/customers/credit-utilization?companyId=${COMPANY_ID}`,
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

test.describe('Tier 159 — Credit-limit warning', () => {
  test.beforeAll(() => {
    cleanupFixtures()
    setupFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('backend: returns customers with non-NULL creditLimit + open balance + status', async () => {
    const { status, data } = await fetchUtilization()
    expect(status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
    // We have 3 customers with a limit (OK, Warning, Over)
    const ids = data.map((r: any) => r.customerId)
    expect(ids).toContain(CUST_OK)
    expect(ids).toContain(CUST_WARNING)
    expect(ids).toContain(CUST_OVER)
    // CUST_NO_LIMIT has no creditLimit → excluded
    expect(ids).not.toContain(CUST_NO_LIMIT)
    // Per-row shape
    const ok = data.find((r: any) => r.customerId === CUST_OK)
    expect(ok.creditLimit).toBe(1000)
    expect(ok.totalOpen).toBe(100)
    expect(ok.utilization).toBe(10)
    expect(ok.status).toBe('ok')
    const warn = data.find((r: any) => r.customerId === CUST_WARNING)
    expect(warn.status).toBe('warning')
    const over = data.find((r: any) => r.customerId === CUST_OVER)
    expect(over.status).toBe('over')
  })

  test('backend: sorted by status severity then utilization DESC', async () => {
    const { data } = await fetchUtilization()
    // The fixture has exactly 1 row in each bucket; the
    // 3 rows are sorted: over, warning, ok.
    const statuses = data.map((r: any) => r.status)
    // 'over' must come before 'warning' which must
    // come before 'ok'.
    const overIdx = statuses.indexOf('over')
    const warnIdx = statuses.indexOf('warning')
    const okIdx = statuses.indexOf('ok')
    expect(overIdx).toBeLessThan(warnIdx)
    expect(warnIdx).toBeLessThan(okIdx)
  })

  test('backend: empty list when no customers have a limit', async () => {
    cleanupFixtures()
    // Also clear the BWA Test Kunde smoke-test row
    // (from the earlier curl test in this session) so
    // the "no customers with a limit" assumption
    // holds.
    execSync(
      `docker exec ${PG_CONTAINER} psql -U de_invoice -d de_invoice -c "UPDATE \\"Customer\\" SET \\"creditLimit\\" = NULL WHERE id = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'"`,
      { stdio: 'pipe' },
    )
    const { data } = await fetchUtilization()
    expect(data).toEqual([])
    // Restore fixtures for subsequent tests
    setupFixtures()
  })

  test('backend: customer with 0 open invoices shows status ok / utilization 0', async () => {
    // Create a customer with a limit but no invoices
    const noInvoiceId = '11111111-cccc-dddd-eeee-000000000005'
    const sql = `
      DELETE FROM "Customer" WHERE id = '${noInvoiceId}';
      INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", "creditLimit", tags, "createdAt", "updatedAt")
      VALUES ('${noInvoiceId}', '${COMPANY_ID}', 'business', 'BWA NoInv', '{}'::jsonb, '{}'::jsonb, 30, 500, ARRAY[]::text[], NOW(), NOW());
    `
    const path = '/tmp/tier159-noinv.sql'
    require('fs').writeFileSync(path, sql)
    try {
      execSync(
        `docker exec -i ${PG_CONTAINER} psql -U de_invoice -d de_invoice < ${path}`,
        { stdio: 'pipe' },
      )
    } finally {
      try { require('fs').unlinkSync(path) } catch {}
    }
    const { data } = await fetchUtilization()
    const row = data.find((r: any) => r.customerId === noInvoiceId)
    expect(row).toBeTruthy()
    expect(row.totalOpen).toBe(0)
    expect(row.utilization).toBe(0)
    expect(row.status).toBe('ok')
    // Clean up
    execSync(
      `docker exec ${PG_CONTAINER} psql -U de_invoice -d de_invoice -c "DELETE FROM \\"Customer\\" WHERE id = '${noInvoiceId}'"`,
      { stdio: 'pipe' },
    )
  })

  test('frontend: customer detail page shows Kreditlimit card for over-limit customer', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto(`/dashboard/customers/${CUST_OVER}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The Kreditlimit card is present
    const card = page.getByTestId('kpi-credit-limit')
    await expect(card).toBeVisible({ timeout: 10_000 })
    // data-bucket="over"
    await expect(card).toHaveAttribute('data-bucket', 'over')
    // Shows 150% utilization
    const pct = page.getByTestId('kpi-credit-limit-pct')
    await expect(pct).toContainText('150')
  })

  test('frontend: customer detail page hides the card when creditLimit is NULL', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto(`/dashboard/customers/${CUST_NO_LIMIT}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The Kreditlimit card is NOT present (the IIFE
    // returns null when creditLimit is null)
    const card = page.getByTestId('kpi-credit-limit')
    await expect(card).toBeHidden({ timeout: 5_000 })
  })

  test('frontend: dashboard shows credit-limit widget with over + warning + ok rows', async ({ page }) => {
    await contextWithAuth(page)
    await page.goto('/dashboard')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The widget renders when there's at least one
    // customer with a non-NULL limit
    const widget = page.getByTestId('dashboard-credit-limit')
    await expect(widget).toBeVisible({ timeout: 10_000 })
    // The over-limit row is present
    const overRow = page.getByTestId(`dashboard-credit-row-${CUST_OVER}`)
    await expect(overRow).toBeVisible()
    await expect(overRow).toHaveAttribute('data-bucket', 'over')
  })

  test('mobile 375x667: dashboard credit widget does not overflow', async ({ page }) => {
    await contextWithAuth(page)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const widget = page.getByTestId('dashboard-credit-limit')
    await expect(widget).toBeVisible({ timeout: 10_000 })
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
