import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 33: customer self-service portal.
 *
 * Two flows tested:
 *
 *   1. Admin-side: open the invoice detail page, click
 *      "Zahlungslink anzeigen", confirm the URL panel
 *      shows up with a 32-char hex token.
 *
 *   2. Public-side: open /pay/<token> without any
 *      auth cookies, confirm the page renders the
 *      invoice total + the "Als bezahlt markieren"
 *      button, click the button, and confirm the
 *      confirmation banner appears.
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

test.describe("Customer portal (Tier 33)", () => {
  test("admin generates a portal link on the invoice detail page", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    // We need an invoice id. The seed list returns
    // the 50 most-recent invoices — pick the first.
    await page.goto("/dashboard/invoices", {
      waitUntil: "domcontentloaded",
    })
    const firstRow = page.locator('[data-testid="invoice-row"]').first()
    await expect(firstRow).toBeVisible({ timeout: 15_000 })
    await firstRow.click()
    // After click, the view button navigates to the
    // detail page.
    const viewButton = firstRow.locator("text=/Ansehen|View/")
    await viewButton.click()
    // Wait for the detail page — the buttons row
    // (PDF, E-Mail, etc.) is a reliable anchor.
    const portalBtn = page.locator(
      '[data-testid="invoice-portal-link-button"]',
    )
    await expect(portalBtn).toBeVisible({ timeout: 15_000 })
    await portalBtn.click()
    const panel = page.locator(
      '[data-testid="invoice-portal-link-panel"]',
    )
    await expect(panel).toBeVisible({ timeout: 15_000 })
    const urlInput = page.locator(
      '[data-testid="invoice-portal-link-url"]',
    )
    await expect(urlInput).toBeVisible()
    const url = await urlInput.inputValue()
    // The URL has the shape http://host:port/pay/<token>.
    // Token is 32 hex chars in our backend.
    expect(url).toMatch(/\/pay\/[a-f0-9]{32}$/)
  })

  test("public /pay/<token> page renders + mark-paid button works", async ({
    page,
    context,
  }) => {
    // First, generate a token via the API (no UI flow,
    // faster + avoids auth-coupling between admin +
    // public tests).
    const userId = testTokens?.userId ?? ""
    const companyId = testTokens?.companyId ?? ""
    // Tier 369: was a bare test.skip(). These come from the shared auth cache
    // that every spec depends on — if they are missing the cache is gone or
    // corrupt, which is a failure, not a reason to report green.
    expect(
      userId && companyId,
      "the auth cache must provide userId + companyId",
    ).toBeTruthy()
    // Find a real invoice id (skip test fixtures
    // like 'T160-CLONE-SRC' that have non-standard
    // invoice numbers).
    const invResp = await page.request.get(
      `http://localhost:3001/api/v1/invoices?companyId=${companyId}`,
      {
        headers: {
          "x-user-id": userId,
          "x-company-id": companyId,
        },
      },
    )
    const body = await invResp.json()
    const items = Array.isArray(body) ? body : body.data || []
    const invoice = items.find(
      (i: any) => /^INV-\d{4}-\d+$/.test(i.invoiceNumber),
    ) || items[0]
    // Tier 369: was a bare test.skip(). ci-seed.sh always seeds invoices for
    // this company; an empty list means the seed failed.
    expect(invoice, "ci-seed must provide at least one invoice").toBeTruthy()
    // Mint a fresh link via the authed API.
    const linkResp = await page.request.post(
      `http://localhost:3001/api/v1/invoices/${invoice.id}/generate-payment-link?companyId=${companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
          "x-company-id": companyId,
        },
        data: { origin: "http://localhost:3100" },
      },
    )
    const linkBody = await linkResp.json()
    const token = linkBody.token as string
    // Tier 369: was a bare test.skip(). The token is what
    // generate-payment-link exists to return — no token is the very regression
    // this test is here to catch.
    expect(token, "generate-payment-link must return a token").toBeTruthy()

    // Open the public page — deliberately NO context
    // cookies (the portal page is auth-free and the
    // dev-mode rebuild is independent).
    await context.clearCookies()
    const page2 = await context.newPage()
    await page2.goto(`http://localhost:3100/pay/${token}`, {
      waitUntil: "domcontentloaded",
    })
    await expect(
      page2.locator('[data-testid="pay-portal-page"]'),
    ).toBeVisible({ timeout: 15_000 })
    // The invoice number renders.
    const invNumber = await page2
      .locator('[data-testid="pay-invoice-number"]')
      .innerText()
    expect(invNumber).toMatch(/^INV-\d{4}-\d+$/)
    // The total renders.
    const total = await page2
      .locator('[data-testid="pay-total"]')
      .innerText()
    expect(total).toMatch(/€|EUR/)
    // Click "Mark as paid".
    const markBtn = page2.locator('[data-testid="pay-mark-paid"]')
    await markBtn.click()
    // The confirmation banner appears.
    const banner = page2.locator('[data-testid="pay-marked"]')
    await expect(banner).toBeVisible({ timeout: 10_000 })
  })
})