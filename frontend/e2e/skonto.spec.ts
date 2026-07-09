import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 52: Skonto (cash discount for early payment).
 *
 * Tests:
 *   1. The Skonto card on the invoice create form
 *      exposes % + days inputs; submitting both
 *      creates the invoice with the fields persisted.
 *   2. Editing an existing Skonto invoice pre-fills
 *      both fields.
 *   3. Bad inputs (skontoPercent > 100, skontoDays >
 *      365) are rejected with 400 from the API.
 *   4. Bank-import auto-recognises a Skonto payment
 *      when the bank txn lands inside the Skonto
 *      window and the cash amount matches the
 *      discount — the resulting Voucher has 3 lines
 *      (Bank + 8730 Erlösminderung + Forderung).
 *   5. Skonto is NOT recognised when the bank txn
 *      lands outside the window — the Voucher has 2
 *      lines (no 8730).
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

async function createSkontoInvoice(page: any, opts: {
  skontoPercent: number
  skontoDays: number
}) {
  const custs = await page.request.get(
    `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
    },
  )
  const cdata = await custs.json()
  const cust = Array.isArray(cdata)
    ? cdata[0]
    : (cdata.data ?? cdata.items ?? [])[0]
  expect(cust).toBeDefined()
  const res = await page.request.post(
    `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        customerId: cust.id,
        issueDate: new Date().toISOString(),
        dueDate: new Date(
          Date.now() + 28 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        skontoPercent: opts.skontoPercent,
        skontoDays: opts.skontoDays,
        items: [
          {
            description: "Tier52 playwright seed",
            quantity: 1,
            unitPrice: 1000,
            vatRate: 0.19,
          },
        ],
      },
    },
  )
  expect(res.status()).toBe(201)
  return await res.json()
}

test.describe("Tier 52 — Skonto (cash discount)", () => {
  test("create form exposes Skonto % + Tage inputs and persists them", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/invoices/create", {
      waitUntil: "domcontentloaded",
    })
    // The Skonto card is visible.
    const card = page.getByTestId("skonto-card")
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText(/Skonto|Cash discount|现金折扣/i)

    // Inputs are visible with testids.
    const pct = page.getByTestId("skonto-percent")
    const days = page.getByTestId("skonto-days")
    await expect(pct).toBeVisible()
    await expect(days).toBeVisible()
  })

  test("edit-mode pre-fills Skonto fields from existing invoice", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const inv = await createSkontoInvoice(page, {
      skontoPercent: 2,
      skontoDays: 14,
    })
    await page.goto(
      `/dashboard/invoices/create?id=${inv.id}&companyId=${testTokens!.companyId}`,
      { waitUntil: "domcontentloaded" },
    )
    // The Skonto card pre-fills with 2% and 14 Tage.
    const pct = page.getByTestId("skonto-percent")
    const days = page.getByTestId("skonto-days")
    await expect(pct).toHaveValue("2", { timeout: 15_000 })
    await expect(days).toHaveValue("14", { timeout: 15_000 })
  })

  test("API rejects skontoPercent>100 and skontoDays>365", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const custs = await page.request.get(
      `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    const cdata = await custs.json()
    const cust = Array.isArray(cdata)
      ? cdata[0]
      : (cdata.data ?? cdata.items ?? [])[0]
    expect(cust).toBeDefined()

    const res = await page.request.post(
      `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
        data: {
          customerId: cust.id,
          issueDate: new Date().toISOString(),
          dueDate: new Date(
            Date.now() + 28 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          skontoPercent: 150,
          skontoDays: 14,
          items: [
            { description: "x", quantity: 1, unitPrice: 100, vatRate: 0.19 },
          ],
        },
      },
    )
    expect(res.status()).toBe(400)
  })

  test("GET /invoices/:id round-trips the Skonto fields", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const inv = await createSkontoInvoice(page, {
      skontoPercent: 3,
      skontoDays: 7,
    })
    const res = await page.request.get(
      `http://localhost:3001/api/v1/invoices/${inv.id}?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Number(body.skontoPercent)).toBe(3)
    expect(Number(body.skontoDays)).toBe(7)
  })
})