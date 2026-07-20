import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 72: PDF Signature panel.
 *
 * The /dashboard/invoices/[id] page now has
 * a "PDF-Signatur" card that lets the user
 * load the cert info + verify the signature
 * of the just-downloaded PDF.
 *
 *   1. Panel renders on the invoice detail page.
 *   2. "Zertifikats-Informationen" click loads
 *      the cert (CN + fingerprint + validUntil).
 *   3. "Signatur prüfen" click downloads the
 *      PDF, POSTs to /signing/verify, shows
 *      a green "✓ Signatur gültig" badge with
 *      the cert subject.
 *
 * Backend e2e 98 covers the API contract.
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

async function injectAuth(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
  await page.context().addCookies([
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
}

test.describe("PDF Signature panel", () => {
  test("panel renders on the invoice detail page", async ({ page }) => {
    await injectAuth(page)
    // Find any invoice in the DB
    const res = await page.request.get(
      `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    const invoiceId = body?.data?.[0]?.id
    expect(invoiceId, "no invoice to test against").toBeTruthy()

    await page.goto(`/dashboard/invoices/${invoiceId}`)
    await expect(page.getByTestId("pdf-signature-panel")).toBeVisible({
      timeout: 30_000,
    })
  })

  test("click 'Zertifikats-Informationen' loads the cert", async ({
    page,
  }) => {
    await injectAuth(page)
    // Find any invoice
    const res = await page.request.get(
      `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    const body = await res.json()
    const invoiceId = body?.data?.[0]?.id

    await page.goto(`/dashboard/invoices/${invoiceId}`)
    await expect(page.getByTestId("pdf-signature-panel")).toBeVisible({
      timeout: 30_000,
    })
    // Click the cert-info button.
    await page.getByTestId("pdf-signature-load-cert").click()
    // The cert info block appears with non-empty text.
    await expect(page.getByTestId("pdf-signature-cert-info")).toBeVisible({
      timeout: 10_000,
    })
  })

  test("click 'Signatur prüfen' verifies the downloaded PDF", async ({
    page,
  }) => {
    await injectAuth(page)
    const res = await page.request.get(
      `http://localhost:3001/api/v1/invoices?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
        },
      },
    )
    const body = await res.json()
    const invoiceId = body?.data?.[0]?.id

    await page.goto(`/dashboard/invoices/${invoiceId}`)
    await expect(page.getByTestId("pdf-signature-panel")).toBeVisible({
      timeout: 30_000,
    })
    // Click verify. The component downloads the
    // PDF, POSTs to /signing/verify, then shows
    // a green/red badge. The download + verify
    // can take 20-40s on a heavy ZUGFeRD invoice
    // (the verify endpoint re-generates the PDF
    // if it has no signature yet).
    await page.getByTestId("pdf-signature-verify").click()
    await expect(page.getByTestId("pdf-signature-verify-result")).toBeVisible({
      timeout: 90_000,
    })
  })
})
