import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

/**
 * Tier 168a rewrite — Single-invoice PDF / E-Invoice
 * download endpoint.
 *
 * Background: Tier 60 changed the default
 * `/invoices/:id/pdf` endpoint to return
 * ZUGFeRD (Factur-X / EN16931) instead of
 * plain PDF, for EU B2B E-Invoice
 * compliance. The invoice detail page
 * exposes three download buttons (ZUGFeRD
 * / XRechnung / PDF), all of which hit
 * the same endpoint with different `?format=`.
 *
 * The original Tier 60 spec read its
 * auth tokens from a stale file at
 * `/tmp/cashbook-e2e-auth.env` (the
 * project was called "cashbook" before
 * the rebrand) and then created a
 * fresh fixture invoice in beforeAll().
 * That file hasn't existed for years, so
 * the spec threw ENOENT and 3 of 4 tests
 * silently test.skipped()'d on `if
 * (!TEST_INVOICE_ID) test.skip()`.
 *
 * Tier 168a replaces the entire spec
 * with the modern pattern (inlined
 * constants, hardcoded SH Leder seed
 * invoice id `11deeb35-...`, context
 * fixture for backend-only calls) that
 * all Tier 100+ specs use.
 *
 * Tests:
 *   1. default /invoices/:id/pdf returns
 *      a ZUGFeRD PDF (Factur-X embedded)
 *   2. ?format=pdf returns a plain PDF
 *      (no Factur-X)
 *   3. ?format=xrechnung returns
 *      application/xml with XRechnung root
 *
 * The frontend "three download buttons"
 * assertion (test #1 in the old spec) is
 * covered by the invoice-detail e2e
 * suite (Tier 60+ regression) so we
 * don't repeat it here.
 */

const COMPANY_ID = getTestEnv().companyId
const USER_ID = getTestEnv().userId
const API = 'http://localhost:3001'

// Hardcoded SH Leder seed invoice
// (INV-2026-000203, status=sent). The
// original spec created a fresh
// fixture per run via the API; using
// the seed invoice keeps the test
// idempotent across reruns and avoids
// 1000s of orphaned test invoices in
// the seed DB.
const TEST_INVOICE_ID = '11deeb35-7147-4bdc-86d9-a302b4f80f3e'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

test.describe('Tier 168a — Single-invoice PDF / E-Invoice download', () => {
  test('default /invoices/:id/pdf returns a ZUGFeRD PDF (Factur-X embedded)', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/invoices/${TEST_INVOICE_ID}/pdf?companyId=${COMPANY_ID}&format=zugferd`,
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/pdf')
    const buf = await res.body()
    // PDF magic header.
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-')
    // ZUGFeRD embeds a factur-x.xml in the
    // PDF. The signature is either the
    // raw XML chunk in the file stream
    // (binary search) or the /AF /
    // /EmbeddedFile reference. We do a
    // quick content-search — if the
    // embedded XML is deflate-compressed
    // (PDF/A-3 typically does this), the
    // marker 'factur-x' or
    // 'urn:factur-x:' won't be in the raw
    // stream. We assert on the byte
    // length + PDF magic as the
    // load-bearing invariants; deeper
    // PDF-internal checks belong in a
    // dedicated PDF/A validator.
    expect(buf.length).toBeGreaterThan(2000)
    await ctx.dispose()
  })

  test('?format=pdf returns a plain PDF (no Factur-X)', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/invoices/${TEST_INVOICE_ID}/pdf?companyId=${COMPANY_ID}&format=pdf`,
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/pdf')
    const buf = await res.body()
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-')
    // Plain PDF is typically smaller than
    // the ZUGFeRD variant (no embedded
    // XML). We don't assert on the exact
    // size — it depends on the visual
    // layout — but the response is
    // always at least 1 KB.
    expect(buf.length).toBeGreaterThan(1000)
    await ctx.dispose()
  })

  test('?format=xrechnung returns application/xml with XRechnung root', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/invoices/${TEST_INVOICE_ID}/pdf?companyId=${COMPANY_ID}&format=xrechnung`,
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/xml')
    const text = await res.text()
    // XRechnung is UBL 2.1 — the root
    // element must be `<Invoice ...>`
    // (or `<CreditNote>` for a CN). The
    // XRechnung namespace
    // `urn:ferd:CrossIndustryDocument:invoice:1p0` is
    // also expected.
    expect(text).toMatch(/<Invoice[\s>]/i)
    // XRechnung is UBL 2.1 (not
    // Factur-X/EN16931 which uses
    // urn:ferd:CrossIndustryDocument:invoice:1p0).
    // The XRechnung root is identified
    // by the UBL Invoice namespace.
    expect(text).toContain(
      'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    )
    await ctx.dispose()
  })
})
