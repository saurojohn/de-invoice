import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 65: Auto-Ratenplan banner on the invoice detail page.
 *
 * Two flows under test:
 *
 *   1. High-amount sent invoice + no active plan
 *      → banner "Ratenplan anbieten?" + click opens
 *      a modal with the suggestion defaults
 *      (3 Raten, 30 days, first due today+14d).
 *
 *   2. Low-amount invoice → no banner (the
 *      suggestion endpoint says eligible=false).
 *
 * We don't test the submit path because it creates
 * a real Ratenplan + Mahnungspause in the DB.
 * The backend e2e 92 covers the submit contract.
 *
 * Why this test: backend e2e 92 covers the API
 * shape. This Playwright spec covers the UI
 * affordance — the banner shows up on the right
 * invoices and the modal pre-fills from the
 * suggestion defaults.
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

const TAG = `Tier65-Playwright-${Date.now()}`
let TEST_CUSTOMER_ID: string | null = null
let TEST_HIGH_INV_ID: string | null = null
let TEST_LOW_INV_ID: string | null = null

test.beforeAll(async ({ request }) => {
  // Create a hermetic customer.
  const res = await request.post(
    `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        name: `${TAG}-Cust`,
        type: "business",
        address: { country: "DE" },
      },
    },
  )
  expect(res.status(), "create test customer").toBe(201)
  TEST_CUSTOMER_ID = (await res.json()).id

  // Create a HIGH-amount sent invoice (>= 500 EUR).
  // We use a high total so the suggestion is eligible.
  // CreateInvoiceDto doesn't accept `status` — the
  // service always starts new invoices as 'draft'.
  // The suggestion logic accepts both 'sent' and
  // 'draft' (no, actually it requires 'sent'). The
  // page's button visibility is also conditional on
  // status. So we ship a draft for now and just
  // assert the suggestion payload (not the banner
  // visibility) — the banner test is more nuanced
  // because it requires the invoice to be 'sent'.
  // For the BANNER test we need to manually mark
  // the invoice as 'sent' via SQL after creation.
  const today = new Date().toISOString().slice(0, 10)
  const highRes = await request.post(
    `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        customerId: TEST_CUSTOMER_ID,
        type: "INV",
        issueDate: today,
        dueDate: today,
        currency: "EUR",
        language: "de-DE",
        items: [
          {
            description: "High amount test",
            quantity: 1,
            unit: "Stk",
            unitPrice: 1500, // well above the €500 threshold
            vatRate: 0.19,
          },
        ],
      },
    },
  )
  expect(highRes.status(), "create high invoice").toBe(201)
  TEST_HIGH_INV_ID = (await highRes.json()).id

  // Same for a LOW-amount invoice.
  const lowRes = await request.post(
    `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        customerId: TEST_CUSTOMER_ID,
        type: "INV",
        issueDate: today,
        dueDate: today,
        currency: "EUR",
        language: "de-DE",
        items: [
          {
            description: "Low amount test",
            quantity: 1,
            unit: "Stk",
            unitPrice: 50, // well below the €500 threshold
            vatRate: 0.19,
          },
        ],
      },
    },
  )
  expect(lowRes.status(), "create low invoice").toBe(201)
  TEST_LOW_INV_ID = (await lowRes.json()).id

  // Mark both invoices as 'sent' so the page renders
  // the action buttons (the suggestion logic is
  // status='sent' gated). The "today" invoice path
  // also enables the day-of editing buttons
  // (Bearbeiten, Löschen, etc.) but we don't need
  // them for these tests.
  // We use a docker exec to UPDATE the row — there's
  // no public endpoint that flips draft → sent.
  const { execSync } = await import("child_process")
  execSync(
    `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "UPDATE \\"Invoice\\" SET status = 'sent' WHERE id IN ('${TEST_HIGH_INV_ID}', '${TEST_LOW_INV_ID}');"`,
    { stdio: "pipe" },
  )
})

test.afterAll(async ({ request }) => {
  if (!testTokens) return
  if (TEST_HIGH_INV_ID) {
    try {
      await request.delete(
        `http://localhost:3001/api/v1/invoices/${TEST_HIGH_INV_ID}?companyId=${testTokens.companyId}`,
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
  if (TEST_LOW_INV_ID) {
    try {
      await request.delete(
        `http://localhost:3001/api/v1/invoices/${TEST_LOW_INV_ID}?companyId=${testTokens.companyId}`,
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

test.describe("Tier 65 — Auto-Ratenplan banner", () => {
  test("high-amount invoice shows the suggestion banner", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    if (!TEST_HIGH_INV_ID) throw new Error("TEST_HIGH_INV_ID missing")

    await page.goto(`/dashboard/invoices/${TEST_HIGH_INV_ID}`, {
      waitUntil: "domcontentloaded",
    })
    // Same hydration wait as Tiers 185 / 183 / 49.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    // Wait for the page + the suggestion fetch.
    // The banner has data-testid="ratensplan-suggest-banner".
    const banner = page.locator('[data-testid="ratensplan-suggest-banner"]')
    await expect(banner).toBeVisible({ timeout: 15_000 })
    // The button is inside the banner.
    const button = page.locator('[data-testid="ratensplan-suggest-button"]')
    await expect(button).toBeVisible()
    await expect(button).toContainText(/Ratenplan erstellen|Installment plan/i)
  })

  test("clicking the button opens the pre-filled modal", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    if (!TEST_HIGH_INV_ID) throw new Error("TEST_HIGH_INV_ID missing")

    await page.goto(`/dashboard/invoices/${TEST_HIGH_INV_ID}`, {
      waitUntil: "domcontentloaded",
    })
    // Same hydration wait as test 1.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    await expect(
      page.locator('[data-testid="ratensplan-suggest-button"]'),
    ).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-testid="ratensplan-suggest-button"]').click()

    // The modal mounts with pre-filled fields from
    // the suggestion defaults (3 Raten, 30 days,
    // firstDueDate = today+14d).
    const modal = page.locator('[data-testid="ratensplan-suggest-modal"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // The form fields render with the defaults.
    const countInput = page.locator(
      '[data-testid="ratensplan-modal-count"]',
    )
    await expect(countInput).toBeVisible()
    await expect(countInput).toHaveValue("3")
    const intervalInput = page.locator(
      '[data-testid="ratensplan-modal-interval"]',
    )
    await expect(intervalInput).toHaveValue("30")

    // Close the modal by clicking the backdrop.
    await modal.click({ position: { x: 10, y: 10 } })
  })

  test("low-amount invoice does NOT show the banner", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    if (!TEST_LOW_INV_ID) throw new Error("TEST_LOW_INV_ID missing")

    await page.goto(`/dashboard/invoices/${TEST_LOW_INV_ID}`, {
      waitUntil: "domcontentloaded",
    })
    // The banner should NOT render — the suggestion
    // endpoint says eligible=false (below threshold).
    // We wait for the page to settle (the Ratenplan
    // card title or the payment table) so we know the
    // page rendered, then assert the banner count is 0.
    await expect(
      page.locator('[data-testid="installment-plan-card"]'),
    ).toBeVisible({ timeout: 15_000 })
    const banner = page.locator('[data-testid="ratensplan-suggest-banner"]')
    expect(await banner.count()).toBe(0)
  })
})
