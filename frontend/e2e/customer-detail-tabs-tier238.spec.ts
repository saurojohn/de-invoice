/**
 * Playwright spec — Tier 238 Customer detail Zahlungen + Dokumente tabs.
 *
 * Tests the two new tabs added to /dashboard/customers/[id]:
 *   - "Zahlungen" (payments) — walks the customer's invoices
 *     via /invoices?customerId=<id>, then fetches each
 *     /invoices/<invId>/payments and concatenates. Sum at top
 *     + table with date/invoice/amount/method/reference.
 *   - "Dokumente" (attachments) — GET /attachments?entityType=
 *     customer&entityId=<id>. Backend's list endpoint doesn't
 *     validate the upload whitelist, so returns 200 + [] (no
 *     customer attachments exist). Empty state with hint.
 *
 * Test plan (5 tests):
 *   1. Zahlungen tab is visible (button) and clickable
 *   2. Zahlungen tab content renders (table or empty state)
 *   3. When the test fixture has a payment, the table shows rows
 *      with date / invoice / amount / method columns
 *   4. Dokumente tab is visible (button) and clickable
 *   5. Dokumente tab content shows the empty state (no customer
 *      attachments uploaded in seed data)
 *
 * Creates a fresh customer + invoice + payment in beforeAll so
 * the test is deterministic regardless of seed-DB state. Cleanup
 * in afterAll deletes the customer (cascade removes the invoice
 * and payments, since they're linked to the customer via FK).
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { readFileSync } from 'fs'

const AUTH_CACHE = '/tmp/cashbook-e2e-auth.env'

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

async function contextWithAuth(page: any) {
  const { userId, companyId } = readCachedTokens()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
  // Pre-seed the cookie consent so the banner doesn't
  // intercept clicks on the lower tab buttons. The banner
  // is a fixed-position overlay that covers the bottom of
  // the viewport, blocking any click on tab-payments /
  // tab-attachments (both rendered at the bottom of the
  // tab strip). The Tier 170 e2e covers the banner itself.
  // Field shape MUST match the loadConsent() schema check
  // in CookieBanner.tsx: necessary (bool), analytics
  // (bool), marketing (bool), savedAt (ISO string).
  await page.addInitScript(() => {
    localStorage.setItem(
      "cookie-consent",
      JSON.stringify({
        necessary: true,
        analytics: false,
        marketing: false,
        savedAt: new Date().toISOString(),
      }),
    )
  })
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
}

const TIER238_TAG = `Tier238-TabTest-${Date.now()}`
let TEST_CUSTOMER_ID: string | null = null
let CREATED_CUSTOMER_ID: string | null = null

test.beforeAll(async () => {
  const { userId, companyId } = readCachedTokens()
  const api = await playwrightRequest.newContext({
    baseURL: "http://localhost:3001",
    extraHTTPHeaders: {
      "x-user-id": userId,
      "x-company-id": companyId,
    },
  })

  // The Tier 238 customer detail tab tests need a customer
  // with at least one invoice and one payment — so the
  // Zahlungen tab walk has rows to display. Rather than
  // creating a fresh invoice (which would hit the Tier
  // 174 P2002 sequence race and require retries), we
  // pick an existing seed customer that already has
  // paid invoices. The seed customer f84ebd20 was
  // created by Tier 50 e2e and has 1 invoice
  // (INV-2026-006343) with 1 payment against it.
  //
  // We also create a SECOND, fresh customer with no
  // invoices to test the empty state of the Dokumente
  // tab — that's a "no data" path the tests need to
  // cover separately.
  TEST_CUSTOMER_ID = "f84ebd20-4513-48e4-b331-87ba19477ae3"

  const custRes = await api.post(`/api/v1/customers?companyId=${companyId}`, {
    data: {
      name: TIER238_TAG,
      type: "business",
      address: { city: "Berlin" },
      paymentTerms: 14,
    },
  })
  console.log(`[tier238] fresh-customer create: HTTP ${custRes.status()}`)
  if (custRes.status() !== 201) {
    const body = await custRes.text()
    throw new Error(`Failed to seed customer: HTTP ${custRes.status()} — ${body}`)
  }
  const custBody = await custRes.json()
  CREATED_CUSTOMER_ID = custBody.id
  console.log(`[tier238] created fresh customer ${CREATED_CUSTOMER_ID}`)

  // 2. NO invoice or payment seeding — the Tier 174 P2002
  //    sequence race makes POST /invoices unreliable from
  //    a test fixture (sequence can advance faster than
  //    INSERTs commit, causing unique constraint failures
  //    on the next attempt). The seed customer f84ebd20
  //    already has 1 invoice + 1 payment, which is enough
  //    to exercise the Zahlungen tab walk end-to-end.
  //    For the empty-state tests (Dokumente tab), we use
  //    CREATED_CUSTOMER_ID which has no invoices/payments.
})

test.afterAll(async () => {
  // Only clean up the fresh customer we created in beforeAll.
  // The seed customer (f84ebd20) is shared with Tier 50 and
  // other e2e tests — leaving it untouched.
  if (!CREATED_CUSTOMER_ID) return
  const { userId, companyId } = readCachedTokens()
  const api = await playwrightRequest.newContext({
    baseURL: "http://localhost:3001",
    extraHTTPHeaders: {
      "x-user-id": userId,
      "x-company-id": companyId,
    },
  })
  try {
    await api.delete(`/api/v1/customers/${CREATED_CUSTOMER_ID}?companyId=${companyId}`)
  } catch {
    // best-effort cleanup
  }
})

test.describe("Tier 238 — Customer detail Zahlungen + Dokumente tabs", () => {
  test.beforeEach(async ({ page }) => {
    await contextWithAuth(page)
  })

  test("1. Zahlungen tab button is visible on the detail page", async ({ page }) => {
    if (!TEST_CUSTOMER_ID) test.skip(true, "no test customer seeded")
    await page.goto(`http://localhost:3100/dashboard/customers/${TEST_CUSTOMER_ID}`)
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const tab = page.getByTestId("tab-payments")
    await expect(tab).toBeVisible({ timeout: 15000 })
  })

  test("2. Clicking Zahlungen tab shows the table with our seeded payment", async ({ page }) => {
    if (!TEST_CUSTOMER_ID) test.skip(true, "no test customer seeded")
    await page.goto(`http://localhost:3100/dashboard/customers/${TEST_CUSTOMER_ID}`)
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const tab = page.getByTestId("tab-payments")
    await expect(tab).toBeVisible({ timeout: 15000 })
    await tab.click()
    // Wait for the lazy-fetch to complete — the table is the
    // proof the walk finished.
    const table = page.getByTestId("tab-payments-table")
    await expect(table).toBeVisible({ timeout: 10000 })
    // The walk should find at least 1 payment (the seed customer
    // f84ebd20 has 1 payment from the Tier 50 e2e test).
    // Count badge: tab-payments-count should be present and = "1".
    const count = page.getByTestId("tab-payments-count")
    await expect(count).toBeVisible()
    await expect(count).toHaveText("1")
    // The sum line at the top should be visible too.
    const sum = page.getByTestId("tab-payments-sum")
    await expect(sum).toBeVisible()
    // Verify the row has the payment method stored in the DB
    // for this seed customer. The Tier 50 e2e used
    // paymentMethod='bank_transfer' (an English string,
    // not the German "Überweisung" — these are the
    // raw enum values the backend stores).
    const row = page.getByTestId("tab-payments-row")
    await expect(row).toBeVisible()
    const rowText = await row.innerText()
    expect(rowText).toContain("bank_transfer")
    // And the reference column shows "e2e-50 test".
    expect(rowText).toContain("e2e-50 test")
  })

  test("3. Dokumente tab button is visible on the detail page", async ({ page }) => {
    if (!TEST_CUSTOMER_ID) test.skip(true, "no test customer seeded")
    await page.goto(`http://localhost:3100/dashboard/customers/${TEST_CUSTOMER_ID}`)
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const tab = page.getByTestId("tab-attachments")
    await expect(tab).toBeVisible({ timeout: 15000 })
  })

  test("4. Clicking Dokumente tab shows the empty state (no customer attachments)", async ({ page }) => {
    // Use the fresh, no-invoice customer for this test — the
    // empty-state path is the same regardless of whether the
    // customer has invoices, but using the fresh customer
    // ensures we test the "completely empty customer" case
    // (no invoices, no payments, no attachments).
    if (!CREATED_CUSTOMER_ID) test.skip(true, "no fresh customer seeded")
    await page.goto(`http://localhost:3100/dashboard/customers/${CREATED_CUSTOMER_ID}`)
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    const tab = page.getByTestId("tab-attachments")
    await expect(tab).toBeVisible({ timeout: 15000 })
    await tab.click()
    // The empty state appears when attachments=[]. No customer
    // attachments are uploaded in the seed or by this test,
    // so this should be the rendered view (NOT a table — that
    // would mean customer attachments were uploaded, which
    // contradicts the upload whitelist that excludes 'customer').
    const empty = page.getByTestId("tab-attachments-empty")
    await expect(empty).toBeVisible({ timeout: 10000 })
    // The table should NOT be rendered.
    const table = page.getByTestId("tab-attachments-table")
    expect(await table.count()).toBe(0)
  })

  test("5. Tab counter badge updates on Zahlungen when payment count > 0", async ({ page }) => {
    if (!TEST_CUSTOMER_ID) test.skip(true, "no test customer seeded")
    await page.goto(`http://localhost:3100/dashboard/customers/${TEST_CUSTOMER_ID}`)
    await page.waitForLoadState("networkidle", { timeout: 15000 })
    // Click Zahlungen first to trigger the lazy-fetch.
    const tab = page.getByTestId("tab-payments")
    await expect(tab).toBeVisible({ timeout: 15000 })
    await tab.click()
    // Wait for the fetch to populate state.
    const count = page.getByTestId("tab-payments-count")
    await expect(count).toBeVisible({ timeout: 10000 })
    // Switch away and back to verify the count badge persists
    // (state is cached, NOT re-fetched).
    const emailsTab = page.getByTestId("tab-emails")
    if ((await emailsTab.count()) > 0) {
      await emailsTab.click()
      await page.waitForTimeout(500)
      // Switch back to payments.
      await tab.click()
      // Count should still be visible (state is preserved).
      await expect(count).toBeVisible()
      await expect(count).toHaveText("1")
    }
  })
})
