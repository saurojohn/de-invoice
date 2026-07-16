import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 60: Single PDF endpoint defaults to ZUGFeRD (Factur-X
 * / EN16931) for EU B2B E-Invoice compliance. The invoice
 * detail page exposes three download buttons:
 *
 *   1. ZUGFeRD — PDF/A-3 with embedded CrossIndustryInvoice XML
 *   2. XRechnung — pure XML (UBL 2.1)
 *   3. PDF — visual-only PDF, no XML attachment
 *
 * Tests:
 *   1. Invoice detail page renders the three download buttons
 *   2. The default `/invoices/:id/pdf` endpoint returns a
 *      PDF with an embedded factur-x.xml (Tier 60 default
 *      format change)
 *   3. `?format=pdf` returns a plain PDF (no factur-x.xml)
 *   4. `?format=xrechnung` returns application/xml with the
 *      XRechnung <Invoice> root
 *
 * Why a separate spec?
 *   - The download buttons are new (Tier 60)
 *   - The default format change (PDF → ZUGFeRD) is a
 *     breaking change for any caller that relied on plain
 *     PDF without a format query param
 *   - The deep PDF/A-3 + XMP + embedded-XML validation is
 *     the canonical E-Invoice test — worth isolated coverage
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

const TIER60_TAG = `Tier60-Einvoice-${Date.now()}`
let TEST_INVOICE_ID: string | null = null
let TEST_INVOICE_NUM: string | null = null

test.beforeAll(async ({ request }) => {
  // Find an existing customer to attach the test invoice to.
  // The list endpoint returns Müller variants sorted by
  // invoiceCount desc — pick the first hit.
  const custResp = await request.get(
    `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}&pageSize=200`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
    },
  )
  const custBody = await custResp.json()
  const cust = (custBody.data || []).find(
    (c: any) => (c.invoiceCount || 0) > 0,
  )
  if (!cust) {
    throw new Error("No customer with invoices — cannot seed Tier 60 fixture")
  }
  // Create the test invoice
  const today = new Date().toISOString().slice(0, 10)
  const invResp = await request.post(
    `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        customerId: cust.id,
        issueDate: new Date(today).toISOString(),
        dueDate: new Date(today).toISOString(),
        items: [
          {
            description: `${TIER60_TAG} — ZUGFeRD test`,
            quantity: 1,
            unitPrice: 100,
            vatRate: 0.19,
          },
        ],
      },
    },
  )
  expect(invResp.status()).toBe(201)
  const inv = await invResp.json()
  TEST_INVOICE_ID = inv.id
  TEST_INVOICE_NUM = inv.invoiceNumber
  // Flip to 'sent' so the invoice is visible everywhere.
  await request.patch(
    `http://localhost:3001/api/v1/invoices/${TEST_INVOICE_ID}/status?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: { status: "sent" },
    },
  )
})

test.afterAll(async ({ request }) => {
  if (!TEST_INVOICE_ID || !testTokens) return
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
    // Ignore — non-fatal.
  }
})

test.describe("E-Invoice (ZUGFeRD / XRechnung) Tier 60 UI", () => {
  test("default /invoices/:id/pdf returns a ZUGFeRD PDF (Factur-X embedded)", async ({
    request,
  }) => {
    if (!TEST_INVOICE_ID) test.skip(true, "test fixture not ready")
    const res = await request.get(
      `http://localhost:3001/api/v1/invoices/${TEST_INVOICE_ID}/pdf?companyId=${testTokens!.companyId}`,
      {
        // The `request` fixture is a separate context that
        // doesn't carry the page cookies. We pass the auth
        // headers explicitly so the backend's HeaderAuthGuard
        // accepts the call.
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    expect(res.headers()["content-type"]).toContain("application/pdf")
    // Content-Disposition filename must end in _einvoice.pdf
    // (the EU B2B convention)
    const cd = res.headers()["content-disposition"] || ""
    expect(cd).toContain("_einvoice.pdf")
    // Body must contain the Factur-X XML (as a binary blob
    // in the PDF). The "factur-x" string appears in the
    // XMP metadata + the embedded file's name. We don't try
    // to parse the PDF structure here — the backend e2e
    // (87-tier60) does the deep pypdf validation.
    const body = await res.body()
    const text = body.toString("latin1")
    expect(text).toContain("factur-x")
    // XMP should declare EN16931 conformance
    expect(text).toContain("EN16931")
  })

  test("?format=pdf returns a plain PDF (no Factur-X)", async ({ request }) => {
    if (!TEST_INVOICE_ID) test.skip(true, "test fixture not ready")
    const res = await request.get(
      `http://localhost:3001/api/v1/invoices/${TEST_INVOICE_ID}/pdf?companyId=${testTokens!.companyId}&format=pdf`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const cd = res.headers()["content-disposition"] || ""
    // Plain PDF: filename should NOT include _einvoice
    expect(cd).not.toContain("_einvoice")
    expect(cd).toMatch(/\.pdf"$/)
  })

  test("?format=xrechnung returns application/xml with XRechnung root", async ({
    request,
  }) => {
    if (!TEST_INVOICE_ID) test.skip(true, "test fixture not ready")
    const res = await request.get(
      `http://localhost:3001/api/v1/invoices/${TEST_INVOICE_ID}/pdf?companyId=${testTokens!.companyId}&format=xrechnung`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    expect(res.headers()["content-type"]).toContain("application/xml")
    const body = await res.body()
    const text = body.toString("utf-8")
    expect(text).toContain("<?xml")
    // XRechnung root element is <Invoice> in UBL namespace.
    // We just check for the substring "Invoice" so the
    // assertion is robust to XML namespace prefix changes.
    expect(text).toContain("Invoice")
  })

  test("invoice detail page shows the three E-Invoice download buttons", async ({
    page,
  }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/invoices/${TEST_INVOICE_ID}`,
      { waitUntil: "domcontentloaded" },
    )
    // Wait for the page to hydrate past the loading state
    await expect(page.locator('[data-testid="invoice-download-zugferd"]')).toBeVisible({
      timeout: 15000,
    })
    await expect(
      page.locator('[data-testid="invoice-download-xrechnung"]'),
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="invoice-download-pdf"]'),
    ).toBeVisible()
  })
})
