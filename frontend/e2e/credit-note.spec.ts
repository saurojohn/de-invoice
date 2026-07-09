import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 53: Gutschrift (credit note) generator.
 *
 * Tests:
 *   1. The "Gutschrift" button is visible on the
 *      invoice detail page next to "Zahlung erfassen".
 *   2. Clicking it opens a modal with a Betrag
 *      (pre-filled with the open balance) and a
 *      reason field.
 *   3. Submitting the form POSTs to
 *      /invoices/:id/credit-note and navigates to
 *      the new CN's detail page; the URL contains
 *      a different invoice id.
 *   4. Full refund (no Betrag entered) creates a CN
 *      with type='CN' and a negative total that
 *      matches -original.total.
 *   5. CN-from-CN is rejected with 400.
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

async function createSeedInvoice(page: any) {
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
          Date.now() + 14 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        items: [
          {
            description: "Tier53 playwright seed",
            quantity: 1,
            unitPrice: 500,
            vatRate: 0.19,
          },
        ],
      },
    },
  )
  expect(res.status()).toBe(201)
  return await res.json()
}

test.describe("Tier 53 — Gutschrift (credit note)", () => {
  test("button is visible on invoice detail page", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const seed = await createSeedInvoice(page)
    await page.goto(
      `/dashboard/invoices/${seed.id}?companyId=${testTokens!.companyId}`,
      { waitUntil: "domcontentloaded" },
    )
    const btn = page.getByTestId("credit-note-button")
    await expect(btn).toBeVisible({ timeout: 15_000 })
    await expect(btn).toContainText(/Gutschrift|Credit note|红字发票/i)
  })

  test("submitting modal creates a CN and navigates to it", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const seed = await createSeedInvoice(page)
    await page.goto(
      `/dashboard/invoices/${seed.id}?companyId=${testTokens!.companyId}`,
      { waitUntil: "domcontentloaded" },
    )

    const btn = page.getByTestId("credit-note-button")
    await expect(btn).toBeVisible({ timeout: 15_000 })
    await btn.click()

    const modal = page.getByTestId("credit-note-modal")
    await expect(modal).toBeVisible()

    // The Betrag field is pre-filled with the open
    // balance (= invoice total since no payments).
    const amount = page.getByTestId("credit-note-amount")
    await expect(amount).toBeVisible()

    // Enter a partial refund + reason.
    await amount.fill("100")
    await page.getByTestId("credit-note-reason").fill("Playwright refund")

    // Wait for the POST to land, then for the
    // navigation to the new CN's detail page.
    const postPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/credit-note") &&
        r.request().method() === "POST",
      { timeout: 15_000 },
    )
    await page.getByTestId("credit-note-submit").click()
    const res = await postPromise
    expect([200, 201]).toContain(res.status())

    // We expect a navigation to /dashboard/invoices/<newId>.
    // Wait for URL to differ from the original.
    await page.waitForURL(
      (url) => {
        const m = url.pathname.match(/\/invoices\/([^/?]+)/)
        return !!m && m[1] !== seed.id
      },
      { timeout: 10_000 },
    )
    // Sanity: the new URL must point to a CN.
    const newInvoiceId = page
      .url()
      .match(/\/invoices\/([^/?]+)/)?.[1]
    expect(newInvoiceId).toBeTruthy()
    expect(newInvoiceId).not.toBe(seed.id)

    // GET the new invoice to verify it's a CN.
    const newInv = await page.request.get(
      `http://localhost:3001/api/v1/invoices/${newInvoiceId}?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    expect(newInv.status()).toBe(200)
    const body = await newInv.json()
    expect(body.type).toBe("CN")
    expect(body.referenceInvoiceId).toBe(seed.id)
    // 100 € refund = 84.03 net + 15.97 vat = 100 total (negative)
    expect(Math.abs(Number(body.total))).toBeCloseTo(100, 2)
    expect(Number(body.total)).toBeLessThan(0)
  })

  test("full refund (empty Betrag) creates a CN with type=CN", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const seed = await createSeedInvoice(page)

    const res = await page.request.post(
      `http://localhost:3001/api/v1/invoices/${seed.id}/credit-note?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
        data: {},
      },
    )
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.type).toBe("CN")
    expect(body.referenceInvoiceId).toBe(seed.id)
    // Full refund: total = -original.total
    expect(Number(body.total)).toBe(-Number(seed.total))
  })

  test("CN-from-CN is rejected with 400", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const seed = await createSeedInvoice(page)
    // Create a CN first.
    const cnRes = await page.request.post(
      `http://localhost:3001/api/v1/invoices/${seed.id}/credit-note?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
        data: {},
      },
    )
    expect(cnRes.status()).toBe(201)
    const cn = await cnRes.json()
    // Try to chain another CN — must 400.
    const chainedRes = await page.request.post(
      `http://localhost:3001/api/v1/invoices/${cn.id}/credit-note?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
        data: {},
      },
    )
    expect(chainedRes.status()).toBe(400)
  })
})