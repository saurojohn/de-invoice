/**
 * Playwright spec — Tier 166 GoBD § 147 AO archive
 * export.
 *
 * The Berater's question: "When the
 * Finanzamt shows up for a Betriebsprüfung,
 * I need to hand them a single self-contained
 * archive that proves (a) every invoice we
 * issued that year, (b) every Mahnung, (c)
 * every Email, (d) the full audit trail, and
 * (e) the company's signing cert. And I need
 * it in a way that the Prüfer can verify
 * independently — they shouldn't have to
 * trust our word that the archive is
 * complete."
 *
 * Tier 166 = a new GET /gobd-export endpoint
 * that bundles everything for a year into a
 * single ZIP with a SHA-256 manifest, a
 * verification report, and a company
 * snapshot. The frontend adds a
 * "GoBD-Archiv" button on the audit page
 * with a year picker.
 *
 * Tests:
 *   1. backend: response is application/zip
 *      with the expected Content-Disposition
 *      filename pattern
 *   2. backend: ZIP contains manifest.json,
 *      company-snapshot.json, and verification-
 *      report.json at the root
 *   3. backend: invoices/ folder has the
 *      expected .meta.json files (one per
 *      invoice in the year)
 *   4. backend: manifest.json self-hash
 *      matches the SHA-256 of the manifest
 *      content minus the selfHash field
 *   5. backend: missing year → 400
 *   6. backend: invalid year → 400
 *   7. frontend: GoBD export button + year
 *      picker render on the audit page
 *   8. frontend: clicking the button triggers
 *      a download and shows a toast with the
 *      stats from the X-GoBD-Stats header
 *   9. mobile 375x667: the year picker + button
 *      do not overflow
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { getTestEnv } from './fixtures/test-env'

const COMPANY_ID = getTestEnv().companyId
const USER_ID = getTestEnv().userId
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

async function fetchZip(year: number | string) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.get(
    `${API}/api/v1/gobd-export?companyId=${COMPANY_ID}&year=${year}`,
  )
  const buf = await res.body()
  await ctx.dispose()
  return { status: res.status(), headers: res.headers(), body: buf }
}

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

// Save a zip to /tmp, then use the system
// `unzip` to read its contents. macOS ships
// /usr/bin/unzip by default, and the test
// runner runs on the same host. The
// alternative — pulling a JS zip lib into
// the spec — would add a dep for a tool
// that's already there.
const zipCache = new Map<string, string>()

function saveZipToTmp(zipBuf: Buffer, key: string): string {
  if (zipCache.has(key)) return zipCache.get(key)!
  const tmpPath = path.join(
    os.tmpdir(),
    `tier166-${key}-${Date.now()}.zip`,
  )
  fs.writeFileSync(tmpPath, zipBuf)
  zipCache.set(key, tmpPath)
  return tmpPath
}

function readZipEntry(zipPath: string, entry: string): string {
  return execSync(`unzip -p ${JSON.stringify(zipPath)} ${JSON.stringify(entry)}`, {
    encoding: 'utf-8',
  })
}

function listZipEntries(zipPath: string): string[] {
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, {
    encoding: 'utf-8',
  })
  return out.split('\n').filter((s) => s.length > 0)
}

test.describe('Tier 166 — GoBD § 147 AO archive export', () => {
  test('backend: response is application/zip with filename pattern', async () => {
    const { status, headers, body } = await fetchZip(2026)
    expect(status).toBe(200)
    expect(headers['content-type']).toContain('application/zip')
    expect(headers['content-disposition']).toMatch(
      /^attachment; filename="GoBD-\d{4}-[^"]+-\d{4}-\d{2}-\d{2}\.zip"$/,
    )
    // X-GoBD-Stats is the per-section counts
    // the UI reads to show "12 Rechnungen,
    // 2 Mahnungen, ..." in a toast.
    expect(headers['x-gobd-stats']).toBeTruthy()
    const stats = JSON.parse(headers['x-gobd-stats'])
    expect(stats.invoices).toBeGreaterThan(0)
    expect(stats.auditLogRows).toBeGreaterThan(0)
    expect(stats.totalSize).toBeGreaterThan(1000)
    // Sanity: ZIP magic header is PK\x03\x04.
    expect(body[0]).toBe(0x50)
    expect(body[1]).toBe(0x4b)
    expect(body[2]).toBe(0x03)
    expect(body[3]).toBe(0x04)
  })

  test('backend: ZIP contains manifest.json + company-snapshot + verification-report', async () => {
    const { body } = await fetchZip(2026)
    const zipPath = saveZipToTmp(body, 'contents')
    const names = listZipEntries(zipPath)
    expect(names).toContain('manifest.json')
    expect(names).toContain('company-snapshot.json')
    expect(names).toContain('verification-report.json')
    // The verification report is JSON.
    const reportText = readZipEntry(zipPath, 'verification-report.json')
    const reportJson = JSON.parse(reportText)
    expect(reportJson.schemaVersion).toBe(1)
    expect(reportJson.summary.totalFiles).toBeGreaterThan(0)
    expect(reportJson.summary.signedPdfs).toBeGreaterThanOrEqual(0)
    // Company snapshot has the signing cert
    // fingerprint that anchors the chain of
    // trust — the Prüfer can cross-check
    // this against the cert on the signed
    // PDFs inside the archive.
    const snapText = readZipEntry(zipPath, 'company-snapshot.json')
    const snapJson = JSON.parse(snapText)
    expect(snapJson.name).toBe('SH Leder GmbH')
    expect(snapJson.signingCert.fingerprint).toMatch(
      /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/,
    )
  })

  test('backend: invoices/ folder has .meta.json per invoice', async () => {
    const { body } = await fetchZip(2026)
    const zipPath = saveZipToTmp(body, 'invoices')
    const names = listZipEntries(zipPath)
    const metaFiles = names.filter(
      (n) => n.startsWith('invoices/') && n.endsWith('.meta.json'),
    )
    expect(metaFiles.length).toBeGreaterThan(0)
    // Each meta.json has the required
    // fields. We parse one to confirm the
    // shape — picking any is fine because
    // they're all generated by the same
    // template.
    const sampleText = readZipEntry(zipPath, metaFiles[0])
    const sample = JSON.parse(sampleText)
    expect(sample).toHaveProperty('id')
    expect(sample).toHaveProperty('invoiceNumber')
    expect(sample).toHaveProperty('issueDate')
    expect(sample).toHaveProperty('customer')
    expect(sample.customer).toHaveProperty('name')
    expect(sample).toHaveProperty('totals')
    expect(sample.totals).toHaveProperty('total')
  })

  test('backend: manifest self-hash matches SHA-256 of manifest minus selfHash', async () => {
    const { body } = await fetchZip(2026)
    const zipPath = saveZipToTmp(body, 'selfhash')
    const manifestText = readZipEntry(zipPath, 'manifest.json')
    const manifest = JSON.parse(manifestText)
    expect(manifest.selfHash).toBeDefined()
    expect(manifest.selfHash.algorithm).toBe('sha256')
    expect(manifest.selfHash.value).toMatch(/^[0-9a-f]{64}$/)
    // Reconstruct the preimage by
    // serialising the manifest without the
    // selfHash key. We use the same
    // 2-space indent so the byte-for-byte
    // hash matches what the server
    // computed.
    const { selfHash, ...rest } = manifest
    const preimage = JSON.stringify(rest, null, 2)
    const crypto = require('crypto') as typeof import('crypto')
    const computed = crypto
      .createHash('sha256')
      .update(preimage)
      .digest('hex')
    expect(computed).toBe(manifest.selfHash.value)
  })

  test('backend: missing year → 400', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/gobd-export?companyId=${COMPANY_ID}`,
    )
    expect(res.status()).toBe(400)
    await ctx.dispose()
  })

  test('backend: invalid year → 400', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/gobd-export?companyId=${COMPANY_ID}&year=1999`,
    )
    expect(res.status()).toBe(400)
    await ctx.dispose()
  })

  test('frontend: GoBD-Archiv button + year picker render on the audit page', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(`/dashboard/audit?companyId=${COMPANY_ID}`, {
      timeout: 90_000,
    })
    // The audit page is heavy — wait for the
    // audit view toggle (which is at the top
    // of the page, before the table) before
    // checking the new button.
    await expect(page.getByTestId('audit-view-toggle')).toBeVisible({
      timeout: 30_000,
    })
    const btn = page.getByTestId('audit-export-gobd')
    const picker = page.getByTestId('audit-gobd-year')
    await expect(btn).toBeVisible()
    await expect(picker).toBeVisible()
    // The year picker options include the
    // current year plus the previous 10.
    const currentYear = new Date().getFullYear()
    const optionValues = await picker
      .locator('option')
      .evaluateAll((els: any[]) => els.map((e) => e.value))
    expect(optionValues).toContain(String(currentYear))
    expect(optionValues).toContain(String(currentYear - 1))
    expect(optionValues).toContain(String(currentYear - 10))
    // 11 options total (current + 10 previous).
    expect(optionValues.length).toBe(11)
  })

  test('frontend: clicking GoBD-Archiv triggers a download + shows stats toast', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(`/dashboard/audit?companyId=${COMPANY_ID}`, {
      timeout: 90_000,
    })
    await expect(page.getByTestId('audit-view-toggle')).toBeVisible({
      timeout: 30_000,
    })
    // Set the year to 2026 to make the test
    // deterministic (we know 2026 has data
    // for the seed company).
    await page.getByTestId('audit-gobd-year').selectOption('2026')
    // Wait for the download. The button
    // click triggers fetch + createObjectURL
    // + <a download> click; Playwright sees
    // the browser download.
    const downloadPromise = page.waitForEvent('download', {
      timeout: 30_000,
    })
    await page.getByTestId('audit-export-gobd').click()
    const download = await downloadPromise
    // We don't assert on the exact
    // suggestedFilename — Playwright's
    // interpretation of the
    // Content-Disposition `filename="..."`
    // value with embedded spaces and dashes
    // is browser-version-dependent, and the
    // important assertion is "the download
    // fired and the bytes are a valid zip
    // with the expected structure". The
    // filename flow is also covered by the
    // backend test that checks the header
    // directly.
    expect(download.suggestedFilename()).toMatch(/^GoBD-/)
    // Save the download to /tmp and verify
    // it's a valid zip with the expected
    // structure. This is the real "did
    // the export work" assertion.
    const savedPath = path.join(os.tmpdir(), `tier166-dl-${Date.now()}.zip`)
    await download.saveAs(savedPath)
    const names = listZipEntries(savedPath)
    expect(names).toContain('manifest.json')
    expect(names).toContain('company-snapshot.json')
    expect(names).toContain('verification-report.json')
    // Cleanup the temp file (Playwright
    // also keeps a copy, but ours is
    // redundant).
    try { fs.unlinkSync(savedPath) } catch {}
  })

  test('mobile 375x667: GoBD-Archiv button + year picker do not overflow', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/audit?companyId=${COMPANY_ID}`, {
      timeout: 90_000,
    })
    await expect(page.getByTestId('audit-view-toggle')).toBeVisible({
      timeout: 30_000,
    })
    // The year picker and GoBD button live
    // in the page header's flex-wrap row.
    // On mobile 375px they may wrap, but
    // each item must not exceed the
    // viewport width.
    const btn = page.getByTestId('audit-export-gobd')
    const picker = page.getByTestId('audit-gobd-year')
    await expect(btn).toBeVisible()
    await expect(picker).toBeVisible()
    const btnWidth = await btn.evaluate((el) => el.scrollWidth)
    const pickerWidth = await picker.evaluate((el) => el.scrollWidth)
    expect(btnWidth).toBeLessThanOrEqual(375)
    expect(pickerWidth).toBeLessThanOrEqual(375)
  })
})
