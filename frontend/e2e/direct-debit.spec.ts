import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { readFileSync } from "fs"

// Tier 112: SEPA pain.008 (Lastschrift / direct debit).
//
// Tests for /dashboard/payments/direct-debit.
// We re-use the same AUTH_CACHE pattern as the
// /payments spec (Tier 108). The e2e setup at
// /Users/shledergmbh/Projects/de-invoice/backend/e2e
// writes the test user/company to /tmp/cashbook-e2e-auth.env
// before the frontend suite starts.

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"
const API_BASE = "http://localhost:3001"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[m.length - 1]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(`Auth cache ${AUTH_CACHE} missing — run backend e2e first`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let tokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  tokens = readCachedTokens()
})

async function injectAuth(page: Page) {
  if (!tokens) return
  const { userId, companyId } = tokens
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    tokens,
  )
}

function authHeaders() {
  if (!tokens) throw new Error("tokens not loaded")
  return {
    "x-user-id": tokens.userId,
    "x-company-id": tokens.companyId,
  }
}

test.describe("SEPA pain.008 direct-debit — /dashboard/payments/direct-debit", () => {
  test("page loads with title and tabs", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId("direct-debit-title")).toBeVisible()
    // Both tabs should be present.
    await expect(page.getByTestId("tab-pain001")).toBeVisible()
    await expect(page.getByTestId("tab-pain008")).toBeVisible()
  })

  test("three cards are rendered (mandates, open invoices, batches)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId("mandates-card")).toBeVisible()
    await expect(page.getByTestId("open-invoices-card")).toBeVisible()
    await expect(page.getByTestId("batches-card")).toBeVisible()
  })

  test("mandates card shows table or empty state", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    // One of these must be visible — either mandates exist
    // (table) or no mandates yet (empty state). The Tier 112
    // e2e setup typically leaves an active mandate behind
    // for customer K-00001.
    const table = page.getByTestId("mandates-table")
    const empty = page.getByTestId("mandates-empty")
    await expect(table.or(empty)).toBeVisible({ timeout: 15_000 })
  })

  test("add-mandate form toggles open and create button is present", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    // Form starts collapsed
    await expect(page.getByTestId("mandate-form")).not.toBeVisible()
    // Click "+ Neues Mandat"
    await page.getByTestId("add-mandate-button").click()
    await expect(page.getByTestId("mandate-form")).toBeVisible()
    await expect(page.getByTestId("mandate-submit-button")).toBeVisible()
    // Customer select + IBAN + BIC + debitor + date + description are present
    await expect(page.getByTestId("mandate-customer-select")).toBeVisible()
    await expect(page.getByTestId("mandate-date-input")).toBeVisible()
    await expect(page.getByTestId("mandate-iban-input")).toBeVisible()
    await expect(page.getByTestId("mandate-bic-input")).toBeVisible()
    await expect(page.getByTestId("mandate-debitor-input")).toBeVisible()
    await expect(page.getByTestId("mandate-description-input")).toBeVisible()
  })

  test("create mandate via direct API + refresh", async ({
    page,
    request,
  }: {
    page: Page
    request: APIRequestContext
  }) => {
    await injectAuth(page)
    // Use the API to ensure a customer exists, then create
    // a mandate through the API too — this keeps the test
    // independent of UI state, then we verify the table
    // renders the new row on /dashboard/payments/direct-debit.
    const customersRes = await request.get(
      `${API_BASE}/api/v1/customers?companyId=${tokens!.companyId}&pageSize=500`,
      { headers: authHeaders() },
    )
    expect(customersRes.status()).toBe(200)
    const customersJson = (await customersRes.json()) as
      | { data: Array<{ id: string; name: string }> }
      | Array<{ id: string; name: string }>
    const list = Array.isArray(customersJson) ? customersJson : customersJson.data
    expect(list.length).toBeGreaterThan(0)
    const customer = list[0]
    const today = new Date().toISOString().slice(0, 10)
    const uniqueIban = `DE89370400440532013${String(Date.now()).slice(-3)}`
    const createRes = await request.post(
      `${API_BASE}/api/v1/payments/mandates`,
      {
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        data: {
          companyId: tokens!.companyId,
          customerId: customer.id,
          dateOfSignature: today,
          type: "CORE",
          iban: uniqueIban,
          bic: "COBADEFFXXX",
          debitorName: customer.name,
          description: "e2e Tier 112 probe",
        },
      },
    )
    expect([200, 201]).toContain(createRes.status())
    const created = (await createRes.json()) as { id: string; iban: string }
    expect(created.id).toBeTruthy()
    // Now load the page and verify the row appears.
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId("mandates-table")).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId(`mandate-row-${created.id}`)).toBeVisible()
  })

  test("open-invoices card shows table or empty state", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    // The Tier 112 e2e setup typically leaves at least one
    // open invoice with a mandate behind for K-00001.
    const table = page.getByTestId("open-invoices-table")
    const empty = page.getByTestId("open-invoices-empty")
    await expect(table.or(empty)).toBeVisible({ timeout: 15_000 })
  })

  test("create-batch CTA + execution-date input visible when invoices exist", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    // If the table is present, the create form must be too.
    // The button starts disabled (0 selected).
    const table = page.getByTestId("open-invoices-table")
    const empty = page.getByTestId("open-invoices-empty")
    await expect(table.or(empty)).toBeVisible({ timeout: 15_000 })
    if (await table.isVisible().catch(() => false)) {
      await expect(
        page.getByTestId("direct-debit-create-form"),
      ).toBeVisible()
      await expect(
        page.getByTestId("direct-debit-execution-date-input"),
      ).toBeVisible()
      const btn = page.getByTestId("direct-debit-create-batch-button")
      await expect(btn).toBeVisible()
      await expect(btn).toBeDisabled()
    }
  })

  test("batches card shows table or empty state", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    // The e2e 134 setup may or may not have produced a batch
    // (it depends on whether previous runs created one). Either
    // the table or the empty hint is shown.
    const table = page.getByTestId("batches-table")
    const empty = page.getByTestId("batches-empty")
    await expect(table.or(empty)).toBeVisible({ timeout: 15_000 })
  })

  test("tab navigation switches between pain.001 and pain.008", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments/direct-debit")
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 30_000,
    })
    // The pain.001 tab on this page should take us to /payments.
    await page.getByTestId("tab-pain001").click()
    await page.waitForURL("**/dashboard/payments", { timeout: 15_000 })
    await expect(page.getByTestId("payments-page")).toBeVisible({
      timeout: 15_000,
    })
    // The pain.008 tab on /payments should take us back.
    await page.getByTestId("tab-pain008").click()
    await page.waitForURL("**/dashboard/payments/direct-debit", {
      timeout: 15_000,
    })
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 15_000,
    })
  })

  test("dashboard card for SEPA-Lastschriften links to /dashboard/payments/direct-debit", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("dashboard-card-direct-debit")).toBeVisible({
      timeout: 30_000,
    })
    await page.getByTestId("dashboard-card-direct-debit").click()
    await page.waitForURL("**/dashboard/payments/direct-debit", {
      timeout: 15_000,
    })
    await expect(page.getByTestId("direct-debit-page")).toBeVisible({
      timeout: 15_000,
    })
  })
})
