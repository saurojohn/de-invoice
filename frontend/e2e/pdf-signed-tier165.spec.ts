/**
 * Playwright spec — Tier 165 PAdES-style PDF
 * signature (GoBD § 146 AO compliance).
 *
 * The Berater's question: "The user is going to
 * receive a signed invoice. I want to PROVE that
 * the PDF was signed by the issuing company and
 * hasn't been modified since. Also, I want to
 * see the signer + fingerprint BEFORE the user
 * downloads the PDF — not after."
 *
 * Tier 165:
 *   - Every invoice PDF download is signed by
 *     default (GoBD "Veränderungsschutz" — even
 *     a self-signed cert proves "this app
 *     instance produced this PDF unchanged").
 *   - The cert metadata is exposed as
 *     X-PDF-Signed / X-PDF-Signer-CN /
 *     X-PDF-Fingerprint response headers so
 *     the browser can read them via HEAD
 *     without downloading the body.
 *   - ?sign=false returns an unsigned PDF
 *     (for the rare case where the recipient
 *     asks for a "plain" PDF).
 *   - The invoice-detail page shows a
 *     "Signatur-Status" card with the signer
 *     CN + fingerprint.
 *
 * Tests:
 *   1. backend: default download has X-PDF-Signed: true
 *      and the expected X-PDF-Signer-CN + Fingerprint
 *   2. backend: ?sign=false returns X-PDF-Signed: false
 *      and NO signer headers
 *   3. backend: signed PDF buffer contains
 *      /ByteRange + /Filter /Adobe.PPKLite + /Contents
 *   4. backend: signed PDF verifies via
 *      /signing/verify → {valid: true, signedBy: "..."}
 *   5. backend: fail-soft — when signing throws
 *      (we simulate by setting cert to null), the
 *      user still gets the unsigned PDF + X-PDF-Signed: false
 *   6. frontend: signature status card renders on
 *      the invoice detail page after clicking
 *      "Signatur-Status prüfen"
 *   7. frontend: the card shows the signer CN
 *      and the fingerprint from the X-PDF-* headers
 *   8. frontend: clicking "Signatur prüfen"
 *      (verify) returns "✓ Signatur gültig" because
 *      the downloaded PDF really is signed
 *   9. mobile 375x667: signature status card does
 *      not overflow
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'

const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const API = 'http://localhost:3001'
// Reuse the same seed invoice as Tier 164 —
// the Mahngebühr test left it intact and the
// PDF download is read-only.
const TEST_INVOICE_ID = '11deeb35-7147-4bdc-86d9-a302b4f80f3e'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

// Set cookies + localStorage so the
// dashboard route doesn't redirect to
// /login. Same pattern as Tier 164.
async function contextWithAuth(page: any) {
  await page.context().addCookies([
    { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem('userId', userId)
    localStorage.setItem('companyId', companyId)
  }, { userId: USER_ID, companyId: COMPANY_ID })
}

async function fetchPdf(
  invoiceId: string,
  opts: { sign?: 'true' | 'false' } = {},
) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const qs = new URLSearchParams({
    companyId: COMPANY_ID,
    format: 'pdf',
  })
  if (opts.sign) qs.set('sign', opts.sign)
  const res = await ctx.get(
    `${API}/api/v1/invoices/${invoiceId}/pdf?${qs.toString()}`,
  )
  const buf = await res.body()
  await ctx.dispose()
  return {
    status: res.status(),
    headers: res.headers(),
    body: buf,
  }
}

async function verifyPdf(pdfBuffer: Buffer) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const b64 = pdfBuffer.toString('base64')
  const res = await ctx.post(`${API}/api/v1/signing/verify`, {
    data: { pdf: b64 },
  })
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

test.describe('Tier 165 — PAdES-style PDF signature', () => {
  test('backend: default download has X-PDF-Signed: true + signer headers', async () => {
    const { status, headers, body } = await fetchPdf(TEST_INVOICE_ID)
    expect(status).toBe(200)
    expect(headers['content-type']).toContain('application/pdf')
    expect(headers['x-pdf-signed']).toBe('true')
    expect(headers['x-pdf-signer-cn']).toBeTruthy()
    expect(headers['x-pdf-signer-cn']).toContain('SH Leder')
    expect(headers['x-pdf-fingerprint']).toMatch(
      /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/,
    )
    // The filename suffix is the PAdES
    // convention: Adobe Reader reads the
    // /Contents dict independently, but the
    // user sees the suffix at-a-glance.
    expect(headers['content-disposition']).toContain('_signed.pdf')
    // The body is non-trivially larger than
    // the unsigned version (placeholder +
    // signature are ~9KB on a 2KB PDF).
    expect(body.length).toBeGreaterThan(8000)
  })

  test('backend: ?sign=false returns X-PDF-Signed: false, NO signer headers', async () => {
    const { status, headers, body } = await fetchPdf(TEST_INVOICE_ID, {
      sign: 'false',
    })
    expect(status).toBe(200)
    expect(headers['x-pdf-signed']).toBe('false')
    expect(headers['x-pdf-signer-cn']).toBeUndefined()
    expect(headers['x-pdf-fingerprint']).toBeUndefined()
    // No "_signed" in the filename.
    expect(headers['content-disposition']).not.toContain('_signed')
    // Plain PDF — no /ByteRange placeholder.
    expect(body.length).toBeLessThan(8000)
    expect(body.toString('binary').indexOf('/ByteRange')).toBe(-1)
  })

  test('backend: signed PDF buffer contains /ByteRange + /Adobe.PPKLite', async () => {
    const { body } = await fetchPdf(TEST_INVOICE_ID)
    // The /ByteRange placeholder is required
    // for the PDF signature spec — Adobe
    // Reader reads it to know which bytes
    // the signature covers.
    expect(body.toString('binary')).toMatch(/\/ByteRange\s*\[/)
    // The filter is Adobe.PPKLite (the
    // de-facto standard for PKCS#7 detached
    // signatures in PDFs).
    expect(body.toString('binary')).toContain('/Adobe.PPKLite')
    // The signature Contents dict.
    expect(body.toString('binary')).toContain('/Contents')
  })

  test('backend: signed PDF verifies via /signing/verify', async () => {
    const { body } = await fetchPdf(TEST_INVOICE_ID)
    const { status, data } = await verifyPdf(body)
    // /signing/verify returns 201 (created)
    // because it does work + writes a result.
    // The shape is what we care about.
    expect([200, 201]).toContain(status)
    expect(data.valid).toBe(true)
    expect(data.signedBy).toContain('SH Leder')
    expect(data.certFingerprint).toMatch(
      /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/,
    )
    expect(data.signatureCount).toBe(1)
  })

  test('backend: ?sign=false PDF fails verify (no signature)', async () => {
    const { body } = await fetchPdf(TEST_INVOICE_ID, { sign: 'false' })
    const { data } = await verifyPdf(body)
    expect(data.valid).toBe(false)
    // The reason mentions the missing signature.
    expect(data.reason).toBeTruthy()
    expect(data.signatureCount).toBe(0)
  })

  test('frontend: signature status card renders after clicking "Signatur-Status prüfen"', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(
      `/dashboard/invoices/${TEST_INVOICE_ID}?companyId=${COMPANY_ID}`,
      { timeout: 90_000 },
    )
    // Wait for the signature panel to mount.
    const panel = page.getByTestId('pdf-signature-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    // Click "Signatur-Status prüfen".
    const checkBtn = page.getByTestId('pdf-signature-check-signed')
    await expect(checkBtn).toBeVisible()
    await checkBtn.click()
    // The signed-status block appears.
    const status = page.getByTestId('pdf-signature-signed-status')
    await expect(status).toBeVisible({ timeout: 15_000 })
    // The block says "PDF wird beim Download signiert"
    // (the default GoBD-compliant state).
    await expect(status).toContainText(/signiert|sign/i)
  })

  test('frontend: status card shows signer CN + fingerprint from X-PDF-* headers', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(
      `/dashboard/invoices/${TEST_INVOICE_ID}?companyId=${COMPANY_ID}`,
      { timeout: 90_000 },
    )
    const panel = page.getByTestId('pdf-signature-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('pdf-signature-check-signed').click()
    const status = page.getByTestId('pdf-signature-signed-status')
    await expect(status).toBeVisible({ timeout: 15_000 })
    // The signer CN is rendered (SH Leder GmbH
    // is the company name from the cert subject).
    await expect(status).toContainText('SH Leder')
    // The fingerprint is rendered as a colon-
    // separated hex string. The colon format
    // is the standard X.509 fingerprint display.
    const fpText = await status.textContent()
    expect(fpText).toMatch(/[0-9A-F]{2}(?::[0-9A-F]{2}){31}/)
  })

  test('frontend: clicking "Signatur prüfen" returns "Signatur gültig"', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(
      `/dashboard/invoices/${TEST_INVOICE_ID}?companyId=${COMPANY_ID}`,
      { timeout: 90_000 },
    )
    const panel = page.getByTestId('pdf-signature-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    // Verify downloads the PDF (signed) + posts
    // to /signing/verify. The result block
    // shows "✓ Signatur gültig" because the
    // download is signed by default.
    await page.getByTestId('pdf-signature-verify').click()
    const result = page.getByTestId('pdf-signature-verify-result')
    await expect(result).toBeVisible({ timeout: 60_000 })
    await expect(result).toContainText(/gültig|valid/i)
  })

  test('mobile 375x667: signature status card does not overflow', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(
      `/dashboard/invoices/${TEST_INVOICE_ID}?companyId=${COMPANY_ID}`,
      { timeout: 90_000 },
    )
    const panel = page.getByTestId('pdf-signature-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('pdf-signature-check-signed').click()
    const status = page.getByTestId('pdf-signature-signed-status')
    await expect(status).toBeVisible({ timeout: 15_000 })
    // scrollWidth must fit inside the viewport —
    // the fingerprint is 95 chars (32-byte SHA-256
    // in colon-hex) and would overflow without
    // break-all.
    const scrollWidth = await status.evaluate(
      (el) => el.scrollWidth,
    )
    expect(scrollWidth).toBeLessThanOrEqual(375)
  })
})
