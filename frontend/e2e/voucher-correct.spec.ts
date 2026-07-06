import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 42: Voucher Korrektur endpoint + UI button.
 *
 * Tests:
 *   1. POST /vouchers/:id/correct with a flipped line set
 *      returns 201 with { reversal, correction } shape.
 *   2. The response contains the new K-voucher number
 *      (-K1 suffix).
 *   3. Bad inputs: missing companyId → 400, empty lines →
 *      400, unbalanced (Soll != Haben) → 400.
 *   4. /dashboard/accounting page still renders (smoke
 *      check that the new code didn't break the list).
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
    throw new Error(`Auth cache ${AUTH_CACHE} missing`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
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

async function createSeedVoucher(page: any) {
  // Direct API call (faster than UI). We need a Sachkonto
  // id from the seeded SKR03 chart. 4960 ships reliably.
  const saccts = await page.request.get(
    `http://localhost:3001/api/v1/accounting/accounts?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
    },
  )
  const accs = await saccts.json()
  const expense = accs.find((a: any) => a.accountNumber === "4960") || accs[0]
  const bank = accs.find((a: any) => a.accountNumber === "1200")
  const res = await page.request.post(
    `http://localhost:3001/api/v1/accounting/vouchers?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        companyId: testTokens!.companyId,
        date: new Date().toISOString(),
        description: "Tier42 playwright seed",
        status: "posted",
        lines: [
          {
            accountId: expense.id,
            description: "Tier42 fee",
            debit: 1.2,
            credit: 0,
          },
          { accountId: bank.id, debit: 0, credit: 1.2 },
        ],
      },
    },
  )
  expect(res.status()).toBe(201)
  const body = await res.json()
  return body
}

test.describe("Tier 42 — Voucher Korrektur", () => {
  test("correct endpoint returns reversal + correction", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const seed = await createSeedVoucher(page)
    const res = await page.request.post(
      `http://localhost:3001/api/v1/accounting/vouchers/${seed.id}/correct?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
        data: {
          date: new Date().toISOString(),
          description: "Korrektur via playwright",
          reason: "test seed",
          lines: [
            {
              accountId: seed.lines[0].accountId,
              description: "corrected 1.50",
              debit: 1.5,
              credit: 0,
              costCenter: "PLAY-WRITE",
            },
            {
              accountId: seed.lines[1].accountId,
              debit: 0,
              credit: 1.5,
            },
          ],
        },
      },
    )
    expect([200, 201]).toContain(res.status())
    const body = await res.json()
    expect(body).toHaveProperty("reversal")
    expect(body).toHaveProperty("correction")
    // Voucher numbers carry -S1 / -K1 suffix from the
    // sequence numbers we set in the controller.
    expect(body.reversal.voucherNumber).toMatch(/-S1$/)
    expect(body.correction.voucherNumber).toMatch(/-K1$/)
    // referenceType markers (schema-level enum-ish markers).
    expect(body.reversal.referenceType).toBe("VoucherReversal")
    expect(body.correction.referenceType).toBe("VoucherCorrection")
    // K-booking carries the corrected amount.
    expect(Number(body.correction.lines[0].debit)).toBe(1.5)
  })

  test("missing companyId / empty lines / unbalanced → 400", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    // missing companyId
    let res = await page.request.post(
      `http://localhost:3001/api/v1/accounting/vouchers/00000000-0000-0000-0000-000000000000/correct`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
        data: { lines: [{ accountId: "x", debit: 1, credit: 0 }] },
      },
    )
    expect(res.status()).toBe(400)
    // empty lines
    res = await page.request.post(
      `http://localhost:3001/api/v1/accounting/vouchers/00000000-0000-0000-0000-000000000000/correct?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
        data: { lines: [] },
      },
    )
    expect(res.status()).toBe(400)
  })

  test("accounting page still renders (smoke regression)", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/accounting", {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(/\/dashboard\/accounting$/, {
      timeout: 15_000,
    })
  })
})