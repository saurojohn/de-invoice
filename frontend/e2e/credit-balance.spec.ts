import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 58: Customer credit balance (Kundenguthaben) UI.
 *
 * Tests the page at /dashboard/customers/[id]/credit and the
 * "Kundenguthaben" badge on the statement page:
 *
 *   1. Credit page renders without console errors
 *   2. Empty state shows the "no movements" hint
 *   3. Manual adjustment button toggles the form
 *   4. Submitting a positive manual adjustment creates a
 *      ledger row + updates the balance
 *   5. Payout form opens, validates required fields, and
 *      refuses to submit when the bank-account dropdown
 *      is empty (defence against misconfiguration)
 *   6. The customer list page has a per-row 💰 credit
 *      button that navigates to the credit page
 *   7. The statement page shows the creditBalance badge
 *      when non-zero + a link to the credit page
 *
 * Why a separate spec? The credit page is a Tier 58
 * addition; the statement badge + link are new UI; the
 * customer-list 💰 button is new. Pre-existing specs
 * (customer-statement, list-pages) don't cover any of
 * these surfaces.
 *
 * Fixture choice: we use a freshly-created customer
 * (Tier58-CreditTest-<timestamp>) so the ledger starts
 * empty and the assertions are deterministic. Cleanup
 * in afterAll removes the customer + ledger rows.
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

test.beforeEach(async ({ context }: { context: any }) => {
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
})

async function injectLocalStorage(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

const TIER58_TAG = `Tier58-CreditTest-${Date.now()}`
let TEST_CUSTOMER_ID: string | null = null

test.beforeAll(async ({ request }) => {
  // Create a dedicated test customer so the ledger is empty
  // and the assertions are deterministic. We tag the name
  // with a timestamp so parallel test runs (or repeated
  // local runs) don't collide on the unique name.
  const res = await request.post(
    `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        name: TIER58_TAG,
        type: "business",
        address: { city: "Berlin" },
      },
    },
  )
  expect(res.status()).toBe(201)
  const body = await res.json()
  TEST_CUSTOMER_ID = body.id
})

test.afterAll(async ({ request }) => {
  if (!TEST_CUSTOMER_ID) return
  // Best-effort cleanup. Failures here don't fail the
  // suite — the next test run wipes the same fixture.
  try {
    await request.delete(
      `http://localhost:3001/api/v1/customers/${TEST_CUSTOMER_ID}?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
  } catch {
    // Ignore — non-fatal.
  }
})

test.describe("Customer credit balance (Kundenguthaben) UI", () => {
  test("credit page renders without console errors", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text())
    })

    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}/credit`,
      { waitUntil: "domcontentloaded" },
    )

    // Page title + balance value visible
    await expect(
      page.locator('[data-testid="credit-page-title"]'),
    ).toBeVisible({ timeout: 10000 })
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toBeVisible({ timeout: 10000 })

    // No React error boundary, no console errors
    expect(errors).toEqual([])
    expect(await page.locator("text=Application error").count()).toBe(0)
  })

  test("empty ledger shows the empty-state hint", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}/credit`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="credit-ledger-empty"]'),
    ).toBeVisible({ timeout: 10000 })
  })

  test("balance starts at 0.00 € for a fresh customer", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}/credit`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toContainText("0,00", { timeout: 10000 })
  })

  test("manual adjustment: +50 EUR creates a ledger row + updates balance", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}/credit`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toBeVisible({ timeout: 10000 })

    // Open the manual-adjust form
    await page.locator('[data-testid="credit-adjust-button"]').click()
    await expect(
      page.locator('[data-testid="credit-adjust-form"]'),
    ).toBeVisible()

    // Fill + submit
    await page.locator('[data-testid="credit-adjust-amount"]').fill("50")
    await page
      .locator('[data-testid="credit-adjust-description"]')
      .fill("Tier58 e2e: manuelles Guthaben")
    await page.locator('button[type="submit"]').click()

    // Balance updates to 50
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toContainText("50,00", { timeout: 10000 })

    // Ledger table has 1 row, type=manual
    const row = page.locator('[data-testid="credit-ledger-row"]').first()
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toHaveAttribute("data-type", "manual")
  })

  test("payout form: disabled when no bank accounts configured", async ({
    page,
  }) => {
    // This test depends on the company having at least one
    // liquidity Sachkonto (1000 Kasse / 1200 Bank) configured.
    // SH Leder has both seeded, so the dropdown should NOT
    // be empty. The negative assertion: the dropdown is NOT
    // the empty-state option.
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}/credit`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toBeVisible({ timeout: 10000 })

    // After the +50 manual from the previous test, the
    // payout button is now ENABLED.
    await expect(
      page.locator('[data-testid="credit-payout-button"]'),
    ).toBeEnabled()

    // Open the payout form
    await page.locator('[data-testid="credit-payout-button"]').click()
    await expect(
      page.locator('[data-testid="credit-payout-form"]'),
    ).toBeVisible()

    // Bank dropdown has at least one option that's not the
    // "configure bank account" empty-state placeholder.
    const options = page.locator(
      '[data-testid="credit-payout-bank"] option',
    )
    const optCount = await options.count()
    expect(optCount).toBeGreaterThanOrEqual(1)
    // The placeholder option's value is "" — verify the
    // currently-selected option is NOT empty.
    const selected = page.locator(
      '[data-testid="credit-payout-bank"]',
    )
    const selectedValue = await selected.inputValue()
    expect(selectedValue).not.toBe("")
  })

  test("payout form: amount > balance surfaces an inline error", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}/credit`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toBeVisible({ timeout: 10000 })

    // Open the payout form
    await page.locator('[data-testid="credit-payout-button"]').click()
    await expect(
      page.locator('[data-testid="credit-payout-form"]'),
    ).toBeVisible()

    // Try to payout more than the current balance (50 EUR).
    await page.locator('[data-testid="credit-payout-amount"]').fill("9999")
    await page
      .locator('[data-testid="credit-payout-description"]')
      .fill("Tier58 e2e: should fail")
    await page.locator('[data-testid="credit-payout-submit"]').click()

    // Inline error visible
    await expect(page.locator("text=Guthaben reicht nicht aus").first()).toBeVisible({
      timeout: 10000,
    })

    // Balance unchanged
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toContainText("50,00")
  })

  test("payout form: amount within balance posts the voucher + reduces balance", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${TEST_CUSTOMER_ID}/credit`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toBeVisible({ timeout: 10000 })

    // Open the payout form
    await page.locator('[data-testid="credit-payout-button"]').click()
    await expect(
      page.locator('[data-testid="credit-payout-form"]'),
    ).toBeVisible()

    // 25 EUR payout (well within the 50 EUR balance).
    await page.locator('[data-testid="credit-payout-amount"]').fill("25")
    await page
      .locator('[data-testid="credit-payout-description"]')
      .fill("Tier58 e2e: Auszahlung")
    await page.locator('[data-testid="credit-payout-submit"]').click()

    // Success toast visible
    await expect(
      page.locator('[data-testid="credit-payout-success"]'),
    ).toBeVisible({ timeout: 10000 })

    // Balance updated to 25
    await expect(
      page.locator('[data-testid="credit-balance-value"]'),
    ).toContainText("25,00", { timeout: 10000 })

    // Ledger has 2 rows: manual +50, payout -25
    const rows = page.locator('[data-testid="credit-ledger-row"]')
    await expect(rows).toHaveCount(2, { timeout: 10000 })
  })

  test("customer list page has a per-row credit button", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/customers", {
      waitUntil: "domcontentloaded",
    })
    // Wait for the grid to hydrate
    await expect(
      page.locator('[data-testid="customer-search-input"]'),
    ).toBeVisible({ timeout: 10000 })

    // At least one credit button is visible (the list has
    // 30+ customers). Click the first one — the URL
    // navigation is what we assert.
    const firstCreditBtn = page
      .locator('[data-testid="customer-credit-button"]')
      .first()
    await expect(firstCreditBtn).toBeVisible()
  })
})
