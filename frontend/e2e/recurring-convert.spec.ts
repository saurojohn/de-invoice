import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 63: "Wiederkehrend" button on the invoice
 * detail page.
 *
 * Flow under test:
 *   1. The user opens an existing invoice (one we
 *      just created).
 *   2. Clicks the "Wiederkehrend" button next to
 *      the Gutschrift button.
 *   3. The page calls
 *      `GET /api/v1/recurring-invoices/from-invoice/:id`
 *      which returns a prefill payload mirroring the
 *      invoice's customer + line items.
 *   4. The prefill is stashed in sessionStorage
 *      and the page router.pushes to
 *      `/dashboard/recurring-invoices?prefill=1`.
 *   5. The recurring-invoices page reads the stash
 *      and opens the create modal pre-populated.
 *
 * Why this matters: without this flow, creating a
 * recurring template from a real invoice required
 * 6+ manual clicks to re-enter customer + items.
 * The button saves 90% of that effort and avoids
 * transcription errors.
 *
 * Why an isolated test: the existing
 * `recurring-invoices.spec.ts` doesn't navigate
 * INTO a detail page. The convert flow is a
 * cross-page interaction (invoice detail →
 * recurring page) that deserves its own spec.
 */

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing — run backend e2e first`,
    )
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

const TAG = `Tier63-Convert-${Date.now()}`
let TEST_CUSTOMER_ID: string | null = null
let TEST_INVOICE_ID: string | null = null

test.beforeAll(async ({ request }) => {
  // Create a fresh customer + a real invoice with one
  // line item. The "convert to recurring" flow reads
  // the invoice's items to build the prefill.
  const headers = {
    "x-user-id": testTokens!.userId,
    "x-company-id": testTokens!.companyId,
  }

  // 1. Customer
  const custRes = await request.post(
    `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`,
    {
      headers,
      data: {
        name: `${TAG}-Cust`,
        type: "business",
        address: { country: "DE" },
      },
    },
  )
  expect(custRes.status(), "create customer").toBe(201)
  TEST_CUSTOMER_ID = (await custRes.json()).id

  // 2. Optional product (the invoice's items can be
  // free-form or tied to a product). We use a
  // free-form item for the test — no product FK
  // needed.

  // 3. Create a real invoice via POST. We hand-build
  // the JSON so we have a known issueDate + total.
  // Note: CreateInvoiceDto does NOT accept a `status`
  // field at creation time — the service always
  // starts new invoices as 'draft'. Sending `status`
  // in the body returns 400 with
  // "property status should not exist".
  const today = new Date().toISOString().slice(0, 10)
  const invRes = await request.post(
    `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
    {
      headers,
      data: {
        customerId: TEST_CUSTOMER_ID,
        type: "INV",
        issueDate: today,
        dueDate: today,
        currency: "EUR",
        language: "de-DE",
        items: [
          {
            description: "Wartungsvertrag monatlich",
            quantity: 1,
            unit: "Monat",
            unitPrice: 199.0,
            vatRate: 0.19,
          },
          {
            description: "Einrichtung",
            quantity: 1,
            unit: "Stk",
            unitPrice: 49.0,
            vatRate: 0.19,
          },
        ],
        notes: "Auto-Konvert Test",
      },
    },
  )
  expect(invRes.status(), "create invoice").toBe(201)
  TEST_INVOICE_ID = (await invRes.json()).id
})

test.afterAll(async ({ request }) => {
  if (!testTokens) return
  // Best-effort cleanup. We don't need a 200 — the
  // /recurring-invoices/cleanup is already covered
  // by other specs.
  if (TEST_INVOICE_ID) {
    try {
      await request.delete(
        `http://localhost:3001/api/v1/invoices/${TEST_INVOICE_ID}?companyId=${testTokens.companyId}`,
        {
          headers: {
            "x-user-id": testTokens.userId,
            "x-company-id": testTokens.companyId,
          },
        },
      )
    } catch {
      // best-effort
    }
  }
  if (TEST_CUSTOMER_ID) {
    try {
      await request.delete(
        `http://localhost:3001/api/v1/customers/${TEST_CUSTOMER_ID}?companyId=${testTokens.companyId}`,
        {
          headers: {
            "x-user-id": testTokens.userId,
            "x-company-id": testTokens.companyId,
          },
        },
      )
    } catch {
      // best-effort
    }
  }
})

async function setupAuth(context: any, page: any) {
  if (!testTokens) return
  await context.addCookies([
    {
      name: "x-user-id",
      value: testTokens.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

test.describe("Tier 63 — Convert invoice to recurring template", () => {
  test("Wiederkehrend button visible on the invoice detail page", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    if (!TEST_INVOICE_ID) throw new Error("TEST_INVOICE_ID missing")

    await page.goto(`/dashboard/invoices/${TEST_INVOICE_ID}`, {
      waitUntil: "domcontentloaded",
    })
    // The button is rendered only on INV-typed invoices
    // that aren't cancelled. We created a draft INV
    // so the button should be visible.
    const button = page.locator('[data-testid="make-recurring-button"]')
    await expect(button).toBeVisible({ timeout: 15_000 })
  })

  test("clicking Wiederkehrend navigates to recurring page with prefill", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    if (!TEST_INVOICE_ID) throw new Error("TEST_INVOICE_ID missing")

    // Register the prefill-API response waiter BEFORE
    // the click. Per the MEMORY gotcha, the waiter
    // must be in place when the fetch fires — React
    // onClick handlers run synchronously, so the
    // GET /from-invoice/:id response can land
    // before any post-click promise has a chance.
    const prefillResp = page.waitForResponse(
      (r) =>
        r.url().includes(
          `/api/v1/recurring-invoices/from-invoice/${TEST_INVOICE_ID}`,
        ) && r.status() === 200,
      { timeout: 15_000 },
    )

    await page.goto(`/dashboard/invoices/${TEST_INVOICE_ID}`, {
      waitUntil: "domcontentloaded",
    })
    const button = page.locator('[data-testid="make-recurring-button"]')
    await expect(button).toBeVisible({ timeout: 15_000 })
    await button.click()

    // The prefill API must have returned 200.
    const r = await prefillResp
    expect(r.status()).toBe(200)

    // The handler stashes the payload in sessionStorage
    // and router.pushes to /recurring-invoices?prefill=1.
    await page.waitForURL(/\/dashboard\/recurring-invoices/, { timeout: 10_000 })
    expect(page.url()).toMatch(/\/dashboard\/recurring-invoices\?prefill=1/)

    // The recurring page should have opened the
    // create modal. The modal contains the
    // "Neue Vorlage" header (or its i18n equivalent).
    // We assert via the modal's data-testid.
    const modalTitle = page.locator("text=Neue Vorlage").first()
    await expect(modalTitle).toBeVisible({ timeout: 10_000 })

    // The name field should be pre-populated with
    // "Aus Rechnung INV-..." (the default prefill
    // name from the backend's fromInvoice method).
    const nameInput = page.locator('input[type="text"]').first()
    const nameValue = await nameInput.inputValue()
    expect(nameValue).toMatch(/Aus Rechnung/)

    // The items list should have 2 entries (matching
    // the source invoice's 2 line items). We assert
    // this by counting the description inputs inside
    // the modal — there should be at least 2.
    // (Exact selector depends on the modal markup;
    // using a broad match that won't break on
    // small refactors.)
    const descInputs = page.locator(
      'input[placeholder*="Beschreibung"], input[placeholder*="Position"]',
    )
    const descCount = await descInputs.count()
    expect(descCount).toBeGreaterThanOrEqual(2)
  })
})
