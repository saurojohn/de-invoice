/**
 * Tier 176 (frontend) — settings page defaultVatMode radio
 *
 * Tier 176 backend ships the `defaultVatMode` column on
 * Company and the pre-fill logic in invoice.service.ts.create.
 * This spec verifies the frontend half:
 *
 *   1. The settings page renders the new
 *      "Standard-USt-Behandlung" select with 5 options
 *      (empty / standard / reverseCharge / igL /
 *      kleinunternehmer).
 *   2. The select pre-loads with the value currently
 *      stored on the Company (loaded via /companies/:id).
 *   3. Saving a new defaultVatMode persists it to
 *      PUT /companies/:id and the backend stores it
 *      (verified by re-loading GET /companies/:id).
 *
 * Why no UI e2e for the invoice create page:
 *   The invoice create page pre-fills the radio based
 *   on the same /companies/:id GET. That's already
 *   covered by the backend e2e (e2e/company-defaults-tier176.spec.ts)
 *   which verifies that POST /invoices with no caller
 *   override uses the company default. The frontend
 *   just translates that default into a visual radio
 *   state — a covered user flow is "settings page
 *   → save → invoice create page opens with the
 *   correct radio selected", but that requires UI
 *   navigation which is hard to assert reliably in CI.
 *   We settle for the API-level verification +
 *   a happy-path settings-page render test.
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
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

// Inject auth cookies before each test. We add them
// at the context level (not per-page) so they're
// available to the initial page.goto and to all
// subsequent page.request calls.
test.beforeEach(async ({ context }: { context: any }) => {
  if (!tokens) return
  await context.addCookies([
    { name: "x-user-id", value: tokens.userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: tokens.companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
  // localStorage userId/companyId are read by the
  // frontend for the initial API calls before the
  // cookies are sent in headers.
  await context.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    tokens,
  )
})

// Capture pre-test defaultVatMode so we can restore it.
let originalVatMode: string | null = null
test.beforeAll(async ({ request }) => {
  const res = await request.get(`http://localhost:3001/api/v1/companies/${tokens!.companyId}`, {
    headers: { "x-user-id": tokens!.userId, "x-company-id": tokens!.companyId },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  originalVatMode = body.defaultVatMode
})

test.afterAll(async ({ request }) => {
  // Restore the original defaultVatMode so other e2e
  // suites see a clean state.
  if (originalVatMode === undefined) return
  await request.put(`http://localhost:3001/api/v1/companies/${tokens!.companyId}`, {
    headers: {
      "Content-Type": "application/json",
      "x-user-id": tokens!.userId,
      "x-company-id": tokens!.companyId,
    },
    data: { defaultVatMode: originalVatMode },
  })
})

test.describe("Tier 176 frontend — settings page defaultVatMode", () => {
  test("1. settings page renders the defaultVatMode select with 5 options", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings")
    // The new select is identified by the data-testid
    // we added in the settings page.
    const select = page.getByTestId("settings-default-vat-mode")
    await expect(select).toBeVisible()

    // Should have 5 options: empty + 4 enum values
    const optionValues = await select.locator("option").evaluateAll(
      (els) => els.map((e) => (e as HTMLOptionElement).value),
    )
    expect(optionValues).toEqual([
      "",
      "standard",
      "reverseCharge",
      "igL",
      "kleinunternehmer",
    ])
  })

  test("2. select pre-loads with the company's current defaultVatMode", async ({
    page,
    request,
  }) => {
    // First set a known value via the API
    await request.put(`http://localhost:3001/api/v1/companies/${tokens!.companyId}`, {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
      data: { defaultVatMode: "igL" },
    })

    await page.goto("http://localhost:3100/dashboard/settings")

    const select = page.getByTestId("settings-default-vat-mode")
    await expect(select).toHaveValue("igL")
  })

  test("3. saving a new defaultVatMode persists to the backend", async ({
    page,
    request,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings")

    const select = page.getByTestId("settings-default-vat-mode")
    // Pick reverseCharge
    await select.selectOption("reverseCharge")
    // The settings page has a single main-form "Speichern"
    // button at the bottom (data-testid="settings-save").
    // Other cards (storage, mail, etc.) have their own
    // save buttons; we explicitly target the main form
    // submit to avoid clicking the wrong one.
    const saveResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/companies/${tokens!.companyId}`) &&
        r.request().method() === "PUT",
      { timeout: 10000 },
    )
    await page.getByTestId("settings-save").click()
    const res = await saveResponse
    expect(res.status(), `save failed: ${await res.text()}`).toBe(200)

    // Verify backend stored the value
    const get = await request.get(
      `http://localhost:3001/api/v1/companies/${tokens!.companyId}`,
      {
        headers: { "x-user-id": tokens!.userId, "x-company-id": tokens!.companyId },
      },
    )
    const body = await get.json()
    expect(body.defaultVatMode, "saved defaultVatMode should be reverseCharge").toBe(
      "reverseCharge",
    )

    // And the next invoice create with no caller override
    // should pick up the new default — verified via API.
    const issue = new Date().toISOString()
    const inv = await request.post(
      `http://localhost:3001/api/v1/invoices?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {
          type: "INV",
          customerId: "b3f7b274-7696-44b8-9345-8bfd460b3e47",
          issueDate: issue,
          currency: "EUR",
          language: "de-DE",
          templateType: "standard",
          items: [
            {
              description: "Tier 176 frontend smoke",
              quantity: 1,
              unit: "Stück",
              unitPrice: 1,
              vatRate: 0.19,
            },
          ],
        },
      },
    )
    expect(inv.status()).toBe(201)
    const invBody = await inv.json()
    expect(
      invBody.reverseCharge,
      "new invoice should have reverseCharge=true from the company default",
    ).toBe(true)
  })
})
