/**
 * Tier 176 — Company.defaultVatMode + defaultPaymentDays
 * pre-fill for invoice create
 *
 * Phase 3 Berater-Walkthrough found that the
 * company-settings page had no way to set a default
 * USt-Behandlung, and the existing defaultPaymentDays
 * field wasn't being used to pre-fill the invoice
 * create form's dueDate. Every invoice required the
 * user to pick the radio button + calculate the
 * due date manually, even though 95% of invoices are
 * standard §12 UStG with 30-day payment terms.
 *
 * Tier 176 closes that gap:
 *   1. New `defaultVatMode` column on Company
 *      (migration 20260812230000_company_default_vat_mode)
 *   2. Backend pre-fills dueDate from defaultPaymentDays
 *      and reverseCharge/euTransaction from defaultVatMode
 *      when the caller didn't pass them.
 *   3. Caller-provided values always win (override
 *      semantics, not merge).
 *
 * This spec verifies the contract:
 *   1. PUT /companies/:id accepts defaultVatMode
 *      (validated against an enum: standard /
 *      reverseCharge / igL / kleinunternehmer)
 *   2. POST /invoices with no dueDate uses
 *      Company.defaultPaymentDays as the due date
 *      (issueDate + N days).
 *   3. POST /invoices with no reverseCharge/euTransaction
 *      uses Company.defaultVatMode to pre-fill:
 *        "standard"          → both false
 *        "reverseCharge"     → reverseCharge: true
 *        "igL"               → euTransaction: true
 *   4. Caller-provided dueDate / reverseCharge / euTransaction
 *      always wins over the company default.
 *   5. NULL defaultVatMode (the conservative default for
 *      Mandanten that don't have a dominant pattern)
 *      leaves the booleans false.
 *
 * Why no frontend test: the pre-fill happens in the
 * backend, not the form. The form just calls
 * POST /invoices and gets back a fully-populated
 * row. The frontend change for Tier 176 is cosmetic
 * (read /companies/:id on the create page and pre-populate
 * the form's radio button / dueDate input) and is verified
 * by the existing invoice-create spec in regression.
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

// All tests touch the same Company, so we capture the
// pre-test state and restore it afterAll to keep the
// test deterministic and not pollute other e2e suites.
let originalDefaults: { defaultPaymentDays: number | null; defaultVatMode: string | null } | null =
  null

test.beforeAll(async ({ request }) => {
  const res = await request.get(`http://localhost:3001/api/v1/companies/${tokens!.companyId}`, {
    headers: { "x-user-id": tokens!.userId, "x-company-id": tokens!.companyId },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  originalDefaults = {
    defaultPaymentDays: body.defaultPaymentDays,
    defaultVatMode: body.defaultVatMode,
  }
})

test.afterAll(async ({ request }) => {
  if (!originalDefaults) return
  await request.put(`http://localhost:3001/api/v1/companies/${tokens!.companyId}`, {
    headers: {
      "Content-Type": "application/json",
      "x-user-id": tokens!.userId,
      "x-company-id": tokens!.companyId,
    },
    data: {
      defaultPaymentDays: originalDefaults.defaultPaymentDays,
      defaultVatMode: originalDefaults.defaultVatMode,
    },
  })
})

async function setDefaults(request: any, defaults: any) {
  const res = await request.put(
    `http://localhost:3001/api/v1/companies/${tokens!.companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
      data: defaults,
    },
  )
  // IMPORTANT: Playwright's `Response.text()` consumes
  // the body, so we can't read it again with `.json()`.
  // Capture the body in a variable first, then assert.
  const body = await res.text()
  expect(res.status(), `setDefaults failed: ${body}`).toBe(200)
  return res
}

async function createInvoice(request: any, body: any) {
  const res = await request.post(
    `http://localhost:3001/api/v1/invoices?companyId=${tokens!.companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
      data: body,
    },
  )
  return res
}

function makeBody(customerId: string) {
  return {
    type: "INV",
    customerId,
    issueDate: new Date().toISOString(),
    currency: "EUR",
    language: "de-DE",
    templateType: "standard",
    items: [
      {
        description: "Tier 176 prefill test",
        quantity: 1,
        unit: "Stück",
        unitPrice: 100,
        vatRate: 0.19,
      },
    ],
    notes: "Tier 176 — Company defaults pre-fill test",
  }
}

test.describe("Tier 176 — Company.defaultVatMode + defaultPaymentDays pre-fill", () => {
  test("1. PUT /companies/:id accepts defaultVatMode enum", async ({ request }) => {
    // Set reverseCharge
    const r1 = await setDefaults(request, {
      defaultPaymentDays: 14,
      defaultVatMode: "reverseCharge",
    })
    const body1 = await r1.json()
    expect(body1.defaultVatMode).toBe("reverseCharge")
    expect(body1.defaultPaymentDays).toBe(14)

    // Reject invalid value
    const badRes = await request.put(
      `http://localhost:3001/api/v1/companies/${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: { defaultVatMode: "invalid_value" },
      },
    )
    expect(badRes.status(), "invalid defaultVatMode should 400").toBe(400)
  })

  test("2. dueDate pre-fills from defaultPaymentDays when caller omits it", async ({
    request,
  }) => {
    await setDefaults(request, {
      defaultPaymentDays: 21,
      defaultVatMode: "standard",
    })

    const issueDate = new Date()
    const r = await createInvoice(request, {
      ...makeBody("b3f7b274-7696-44b8-9345-8bfd460b3e47"),
      issueDate: issueDate.toISOString(),
    })
    expect(r.status(), `create failed: ${await r.text()}`).toBe(201)
    const body = await r.json()

    expect(body.dueDate, "dueDate should be set from defaultPaymentDays").toBeTruthy()
    const expected = new Date(issueDate.getTime() + 21 * 86400_000)
    const actual = new Date(body.dueDate)
    // Compare the day, not the millisecond — the backend
    // may store the date truncated to midnight depending
    // on the time zone. We allow ±1 day.
    const dayDiff = Math.abs(expected.getTime() - actual.getTime()) / 86400_000
    expect(dayDiff, `dueDate off by ${dayDiff} days`).toBeLessThan(1)
  })

  test("3. reverseCharge pre-fills from defaultVatMode='reverseCharge'", async ({
    request,
  }) => {
    await setDefaults(request, {
      defaultPaymentDays: 30,
      defaultVatMode: "reverseCharge",
    })

    const r = await createInvoice(
      request,
      makeBody("b3f7b274-7696-44b8-9345-8bfd460b3e47"),
    )
    expect(r.status()).toBe(201)
    const body = await r.json()
    expect(body.reverseCharge, "expected reverseCharge=true from company default").toBe(true)
    expect(body.euTransaction, "expected euTransaction=false for reverseCharge default").toBe(
      false,
    )
  })

  test("4. euTransaction pre-fills from defaultVatMode='igL'", async ({ request }) => {
    await setDefaults(request, {
      defaultPaymentDays: 30,
      defaultVatMode: "igL",
    })

    const r = await createInvoice(
      request,
      makeBody("b3f7b274-7696-44b8-9345-8bfd460b3e47"),
    )
    expect(r.status()).toBe(201)
    const body = await r.json()
    expect(body.reverseCharge, "igL should not set reverseCharge").toBe(false)
    expect(body.euTransaction, "igL should set euTransaction=true").toBe(true)
  })

  test("5. caller-provided values override the company default", async ({ request }) => {
    await setDefaults(request, {
      defaultPaymentDays: 30,
      defaultVatMode: "reverseCharge",
    })

    const explicitIssue = new Date()
    // Caller provides: dueDate = same day, reverseCharge=false,
    // euTransaction=true (the forbidden combination with
    // reverseCharge=true — but explicit caller wins over
    // the company default, so this is what should be
    // stamped on the row).
    const r = await createInvoice(request, {
      ...makeBody("b3f7b274-7696-44b8-9345-8bfd460b3e47"),
      issueDate: explicitIssue.toISOString(),
      dueDate: explicitIssue.toISOString(),
      reverseCharge: false,
      euTransaction: true,
    })
    expect(r.status(), `create failed: ${await r.text()}`).toBe(201)
    const body = await r.json()

    // The USt-Behandlung validation (§ 27 + § 1a) is
    // Tier 27 logic in the service. The combination
    // reverseCharge=true AND euTransaction=true throws
    // 400. So we expect either:
    //   (a) the service throws 400 and we assert that
    //   (b) the service permits the combination (Tier
    //       27 may have been relaxed — current code
    //       blocks it)
    //
    // Either way, the test verifies the caller values
    // are NOT silently overwritten by the company
    // default. If the service permitted the combination,
    // both booleans should match the caller's input.
    if (r.status() === 201) {
      expect(body.reverseCharge, "caller-provided reverseCharge should win").toBe(false)
      expect(body.euTransaction, "caller-provided euTransaction should win").toBe(true)
      // dueDate should be the same day, not issueDate + 30
      const expected = new Date(explicitIssue)
      const actual = new Date(body.dueDate)
      const dayDiff = Math.abs(expected.getTime() - actual.getTime()) / 86400_000
      expect(dayDiff, `explicit dueDate should win, off by ${dayDiff} days`).toBeLessThan(1)
    }
    // If 400, the service correctly rejected the
    // contradictory caller input — that's also fine.
  })

  test("6. NULL defaultVatMode: booleans stay false (no silent mis-classification)", async ({
    request,
  }) => {
    await setDefaults(request, {
      defaultPaymentDays: 30,
      defaultVatMode: null,
    })

    const r = await createInvoice(
      request,
      makeBody("b3f7b274-7696-44b8-9345-8bfd460b3e47"),
    )
    expect(r.status()).toBe(201)
    const body = await r.json()
    expect(body.reverseCharge, "no default → reverseCharge=false").toBe(false)
    expect(body.euTransaction, "no default → euTransaction=false").toBe(false)
  })
})
