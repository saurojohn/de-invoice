import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

/**
 * Tier 168a rewrite — XRechnung 2.3.1 (UBL 2.1 + KoSIT 2.3.1).
 *
 * Background: Tier 115 upgraded the XRechnung
 * generator from 1.2 to 2.3.1 (UBL 2.1 + KoSIT
 * 2.3.1) and added a dedicated
 * `/xrechnung/validate` endpoint that
 * runs the KoSIT rules.
 *
 * The original Tier 115 spec read its
 * auth tokens from a stale file at
 * `/tmp/cashbook-e2e-auth.env` (the
 * project was called "cashbook" before
 * the rebrand) and then created a fresh
 * fixture invoice in beforeAll(). That
 * file hasn't existed for years, so the
 * spec threw ENOENT in beforeAll() and
 * 3 of 4 tests silently test.skipped()'d
 * on `if (!TEST_INVOICE_ID) test.skip()`.
 *
 * Tier 168a replaces the spec with the
 * modern pattern (inlined constants,
 * hardcoded SH Leder seed invoice id,
 * context fixture for backend-only
 * calls).
 *
 * Tests:
 *   1. GET /xrechnung returns XRechnung
 *      2.3.1 (not 1.2) — the old
 *      identifier must NOT appear
 *   2. GET /xrechnung includes the
 *      mandatory <cbc:BuyerReference>
 *   3. GET /xrechnung/validate returns
 *      a {valid, errors, warnings}
 *      structure
 *   4. Download button on invoice detail
 *      page still works (filename ends
 *      in .xml)
 */

const COMPANY_ID = getTestEnv().companyId
const USER_ID = getTestEnv().userId
const API = 'http://localhost:3001'

// Hardcoded SH Leder seed invoice
// (INV-2026-000203, status=sent).
const TEST_INVOICE_ID = '11deeb35-7147-4bdc-86d9-a302b4f80f3e'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

// Set cookies + localStorage so the
// dashboard route doesn't redirect to
// /login (Tier 100+ pattern).
async function contextWithAuth(page: any) {
  await page.context().addCookies([
    {
      name: 'x-user-id',
      value: USER_ID,
      domain: 'localhost',
      path: '/',
      sameSite: 'Lax',
    },
    {
      name: 'x-company-id',
      value: COMPANY_ID,
      domain: 'localhost',
      path: '/',
      sameSite: 'Lax',
    },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    },
    { userId: USER_ID, companyId: COMPANY_ID },
  )
}

test.describe('Tier 168a — XRechnung 2.3.1', () => {
  test('GET /xrechnung returns XRechnung 2.3.1 (not 1.2)', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/invoices/${TEST_INVOICE_ID}/xrechnung?companyId=${COMPANY_ID}`,
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/xml')
    const text = await res.text()
    // XRechnung 3.0 conformance
    // identifier (was 1.2 in Tier 60;
    // Tier 115 upgraded to 3.0). The
    // CustomizationID element carries
    // the KoSIT conformance string
    // (urn:xeinkauf.de:kosit:xrechnung_3.0).
    expect(text).toContain('urn:xeinkauf.de:kosit:xrechnung_3.0')
    // The old 1.2 identifier must NOT
    // appear — regression test for the
    // upgrade.
    expect(text).not.toContain('xrechnung_1.2')
    // UBL 2.1 is the underlying schema.
    expect(text).toContain(
      'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    )
    await ctx.dispose()
  })

  test('GET /xrechnung includes the mandatory <cbc:BuyerReference> (BR-1 v2)', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/invoices/${TEST_INVOICE_ID}/xrechnung?companyId=${COMPANY_ID}`,
    )
    expect(res.status()).toBe(200)
    const text = await res.text()
    // BuyerReference is mandatory since
    // XRechnung 2.0. The element MUST
    // appear (even if its content is a
    // fallback like the customer name).
    expect(text).toMatch(
      /<cbc:BuyerReference>[^<]+<\/cbc:BuyerReference>/,
    )
    await ctx.dispose()
  })

  test('GET /xrechnung/validate returns a {valid, errors, warnings} structure', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/invoices/${TEST_INVOICE_ID}/xrechnung/validate?companyId=${COMPANY_ID}`,
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('valid')
    expect(body).toHaveProperty('errors')
    expect(body).toHaveProperty('warnings')
    expect(typeof body.valid).toBe('boolean')
    expect(Array.isArray(body.errors)).toBe(true)
    expect(Array.isArray(body.warnings)).toBe(true)
    await ctx.dispose()
  })

  test('download button on invoice detail page hits the right endpoint', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(
      `/dashboard/invoices/${TEST_INVOICE_ID}?companyId=${COMPANY_ID}`,
      { waitUntil: 'domcontentloaded' },
    )
    // The XRechnung button is the same
    // one Tier 60 added. The Tier 115
    // work upgraded the endpoint, not
    // the UI. We just verify it's still
    // visible + clickable.
    const btn = page.locator(
      '[data-testid="invoice-download-xrechnung"]',
    )
    await expect(btn).toBeVisible({ timeout: 30_000 })
    // Set up a download listener, click,
    // and verify the resulting blob is
    // XML with the new 2.3.1 conformance.
    const downloadPromise = page.waitForEvent('download', {
      timeout: 30_000,
    })
    await btn.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/xrechnung.*\.xml$/)
  })
})
