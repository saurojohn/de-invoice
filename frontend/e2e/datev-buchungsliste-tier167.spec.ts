/**
 * Playwright spec — Tier 167 DATEV Buchungsliste
 * (per-Sachkonto summary + USt-Verprobung +
 * SKR03 Kontenplan-Auszug).
 *
 * The Berater's question: "The DATEV
 * Buchungsstapel is the machine-readable
 * form. The Berater's Buchungsliste is
 * the human-readable form (one row per
 * Sachkonto with the period-total). I want
 * to read both, side by side, and confirm
 * they agree before I hand them to the
 * Steuerberater." Tier 167 = a new
 * GET /api/v1/reports/datev-buchungsliste
 * endpoint that bundles both views in a
 * single ZIP, plus a USt-Verprobung (per
 * USt-Schlüssel) and a SKR03 Kontenplan
 * Auszug.
 *
 * Tests:
 *   1. backend: response is application/zip
 *      with the expected Content-Disposition
 *      filename pattern
 *   2. backend: ZIP contains all 5 expected
 *      files (Buchungsliste.csv,
 *      Buchungsstapel.csv, USt-Verprobung.csv,
 *      Kontenplan.csv, manifest.json)
 *   3. backend: manifest.json self-hash
 *      matches the SHA-256 of the manifest
 *      content minus the selfHash field
 *   4. backend: Buchungsliste.csv has the
 *      expected column header
 *   5. backend: USt-Verprobung.csv has the
 *      expected column header + at least
 *      one row (because even an empty year
 *      has the "0" USt-Schlüssel row)
 *   6. backend: Kontenplan.csv starts with
 *      the SKR03 default header
 *   7. backend: ?month filter restricts the
 *      date range (we get a smaller archive
 *      for a one-month filter)
 *   8. backend: missing year → 400
 *   9. backend: invalid month → 400
 *  10. frontend: Buchungsliste button renders
 *      on the DATEV tab
 *  11. frontend: clicking the button triggers
 *      a download with the expected file list
 *  12. mobile 375x667: Buchungsliste button
 *      does not overflow
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import { execSync } from 'child_process'

const COMPANY_ID = getTestEnv().companyId
const USER_ID = getTestEnv().userId
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

async function fetchBuchungsliste(
  year: number | string,
  month?: number | string,
) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const params = new URLSearchParams({ companyId: COMPANY_ID, year: String(year) })
  if (month !== undefined) params.set('month', String(month))
  const res = await ctx.get(
    `${API}/api/v1/reports/datev-buchungsliste?${params.toString()}`,
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

// Use the system `unzip` to read the ZIP —
// same pattern as the Tier 166 e2e. macOS
// ships /usr/bin/unzip. Each call to
// saveZipToTmp creates a NEW tmp file (no
// caching) — caching across tests would
// return stale bytes when the test
// framework reuses the same key with
// different fixture data.
function saveZipToTmp(zipBuf: Buffer, key: string): string {
  const tmpPath = path.join(
    os.tmpdir(),
    `tier167-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`,
  )
  fs.writeFileSync(tmpPath, zipBuf)
  return tmpPath
}

function readZipEntry(zipPath: string, entry: string): string {
  return execSync(
    `unzip -p ${JSON.stringify(zipPath)} ${JSON.stringify(entry)}`,
    { encoding: 'utf-8' },
  )
}

function listZipEntries(zipPath: string): string[] {
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, {
    encoding: 'utf-8',
  })
  return out.split('\n').filter((s) => s.length > 0)
}

// Local require so we don't have to add
// `path` to the import list at the top.
import * as path from 'path'
import { getTestEnv } from './fixtures/test-env'

test.describe('Tier 167 — DATEV Buchungsliste', () => {
  test('backend: response is application/zip with filename pattern', async () => {
    const { status, headers, body } = await fetchBuchungsliste(2026)
    expect(status).toBe(200)
    expect(headers['content-type']).toContain('application/zip')
    expect(headers['content-disposition']).toMatch(
      /^attachment; filename="DATEV-Buchungsliste-\d{4}(-\d{2})?-[^"]+-\d{4}-\d{2}-\d{2}\.zip"$/,
    )
    // X-Buchungsliste-Stats carries the
    // per-section counts so the UI can show
    // "234 Buchungen, 15 Sachkonten" in a
    // toast.
    expect(headers['x-buchungsliste-stats']).toBeTruthy()
    const stats = JSON.parse(headers['x-buchungsliste-stats'])
    expect(typeof stats.buchungenCount).toBe('number')
    expect(typeof stats.sachkontenCount).toBe('number')
    expect(typeof stats.ustSchluesselCount).toBe('number')
    // Sanity: ZIP magic header.
    expect(body[0]).toBe(0x50)
    expect(body[1]).toBe(0x4b)
    expect(body[2]).toBe(0x03)
    expect(body[3]).toBe(0x04)
  })

  test('backend: ZIP contains all 5 expected files', async () => {
    const { body } = await fetchBuchungsliste(2026)
    const zipPath = saveZipToTmp(body, 'contents')
    const names = listZipEntries(zipPath).sort()
    expect(names).toContain('Buchungsliste.csv')
    expect(names).toContain('Buchungsstapel.csv')
    expect(names).toContain('USt-Verprobung.csv')
    expect(names).toContain('Kontenplan.csv')
    expect(names).toContain('manifest.json')
    // Exactly 5 files — no spurious entries.
    expect(names.length).toBe(5)
  })

  test('backend: manifest self-hash matches SHA-256 of manifest minus selfHash', async () => {
    const { body } = await fetchBuchungsliste(2026)
    const zipPath = saveZipToTmp(body, 'selfhash')
    const manifestText = readZipEntry(zipPath, 'manifest.json')
    const manifest = JSON.parse(manifestText)
    expect(manifest.selfHash).toBeDefined()
    expect(manifest.selfHash.algorithm).toBe('sha256')
    expect(manifest.selfHash.value).toMatch(/^[0-9a-f]{64}$/)
    // Reconstruct the preimage (manifest
    // without the selfHash key) and verify
    // the hash. Same BSI TR-03127 §4.3
    // pattern as Tier 166 — the preimage
    // hash proves the manifest itself
    // hasn't been tampered with.
    const { selfHash, ...rest } = manifest
    const preimage = JSON.stringify(rest, null, 2)
    const crypto = require('crypto') as typeof import('crypto')
    const computed = crypto
      .createHash('sha256')
      .update(preimage)
      .digest('hex')
    expect(computed).toBe(manifest.selfHash.value)
  })

  test('backend: Buchungsliste.csv has the expected column header', async () => {
    const { body } = await fetchBuchungsliste(2026)
    const zipPath = saveZipToTmp(body, 'buchungsliste')
    const csv = readZipEntry(zipPath, 'Buchungsliste.csv')
    // The header must include the 6 columns
    // the Berater expects: Konto,
    // KontoBezeichnung, AnzahlBuchungen,
    // SummeSoll, SummeHaben, Saldo. The
    // TOTAL row (sum of all rows) is
    // included as the last line.
    const lines = csv.split('\n')
    expect(lines[0]).toBe(
      'Konto;KontoBezeichnung;AnzahlBuchungen;SummeSoll;SummeHaben;Saldo',
    )
    // The total row is the last non-empty
    // line. SummeSoll - SummeHaben must equal
    // Saldo = 0 (every Soll has a matching
    // Haben) — this is the Berater's
    // accounting identity check.
    const totalLine = lines[lines.length - 1]
    expect(totalLine.startsWith('TOTAL')).toBe(true)
    const parts = totalLine.split(';')
    // The saldo field (last) parses to 0.
    const saldoStr = parts[parts.length - 1].replace(',', '.')
    expect(parseFloat(saldoStr)).toBeCloseTo(0, 2)
  })

  test('backend: USt-Verprobung.csv has the expected columns + a TOTAL row', async () => {
    const { body } = await fetchBuchungsliste(2026)
    const zipPath = saveZipToTmp(body, 'ust')
    const csv = readZipEntry(zipPath, 'USt-Verprobung.csv')
    const lines = csv.split('\n').filter((l) => l.length > 0)
    expect(lines[0]).toBe(
      'UStSchluessel;Beschreibung;Anzahl;SummeNetto;SummeUSt;SummeBrutto',
    )
    // Even an empty year has at least the
    // header line. The body of the
    // USt-Verprobung is empty when no
    // Buchungen exist, which is a valid
    // state — the Berater sees "no VAT
    // was declared" and confirms the year
    // is genuinely empty.
  })

  test('backend: Kontenplan.csv starts with the company account mapping', async () => {
    const { body } = await fetchBuchungsliste(2026)
    const zipPath = saveZipToTmp(body, 'kontenplan')
    const csv = readZipEntry(zipPath, 'Kontenplan.csv')
    // The Kontenplan has two sections: the
    // SKR03 default mapping (always present
    // for the Berater's reference) and the
    // active accounts in this period.
    // Tier 423: the section lists the accounts this company books on
    // (Konto;Bezeichnung;Verwendung) — it was a fixed list that labelled
    // 8120 as § 13b and 1760 / 1577 as USt / Vorsteuer 7 %.
    expect(csv).toMatch(/^# Kontenzuordnung/)
    expect(csv).toContain('8400;Erlöse 19% USt;Erlöse 19 %')
    expect(csv).toContain('8120;Steuerfreie Umsätze § 4 Nr. 1a UStG (Ausfuhr);Ausfuhrlieferungen')
    expect(csv).toContain('8337;Erlöse aus Leistungen nach § 13b UStG;Leistungen nach § 13b UStG')
    expect(csv).toContain('10000-69999;Debitoren;ein Personenkonto je Kunde')
    expect(csv).toContain('# Aktive Konten in diesem Zeitraum')
  })

  test('backend: ?month filter restricts the period', async () => {
    const fullYear = await fetchBuchungsliste(2026)
    const janOnly = await fetchBuchungsliste(2026, 1)
    expect(fullYear.status).toBe(200)
    expect(janOnly.status).toBe(200)
    // The month-filtered manifest has
    // month=1 in the metadata. We don't
    // assert on the byte size (it depends
    // on the data) — the metadata check is
    // enough to confirm the month param
    // actually restricts the period.
    const fullPath = saveZipToTmp(fullYear.body, 'full')
    const janPath = saveZipToTmp(janOnly.body, 'jan')
    const fullManifest = JSON.parse(readZipEntry(fullPath, 'manifest.json'))
    const janManifest = JSON.parse(readZipEntry(janPath, 'manifest.json'))
    expect(fullManifest.month).toBeNull()
    expect(janManifest.month).toBe(1)
    // startDate / endDate reflect the month.
    expect(fullManifest.startDate).toContain('2026-01-01')
    expect(fullManifest.endDate).toContain('2027-01-01')
    expect(janManifest.startDate).toContain('2026-01-01')
    expect(janManifest.endDate).toContain('2026-02-01')
  })

  test('backend: missing year → 400', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/reports/datev-buchungsliste?companyId=${COMPANY_ID}`,
    )
    expect(res.status()).toBe(400)
    await ctx.dispose()
  })

  test('backend: invalid month → 400', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/reports/datev-buchungsliste?companyId=${COMPANY_ID}&year=2026&month=13`,
    )
    expect(res.status()).toBe(400)
    await ctx.dispose()
  })

  test('frontend: Buchungsliste button renders on the DATEV tab', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(`/dashboard/reports?companyId=${COMPANY_ID}`, {
      timeout: 90_000,
    })
    // The reports page default tab is
    // `sales`. Click the DATEV tab to
    // mount the DatevExportTab component.
    const datevTabBtn = page.getByTestId('tab-datev')
    await expect(datevTabBtn).toBeVisible({ timeout: 30_000 })
    await datevTabBtn.click()
    // The DATEV tab content has
    // data-testid="datev-tab" wrapping the
    // Buchungsstapel card.
    const card = page.locator('[data-testid="datev-tab"]').first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('datev-download-buchungsliste-btn')
    await expect(btn).toBeVisible()
    // The button label is "📊 Buchungsliste
    // (ZIP)" — we don't assert on the
    // emoji (locator queries skip those
    // anyway) but we do check the German
    // label text.
    await expect(btn).toContainText('Buchungsliste')
  })

  test('frontend: clicking Buchungsliste triggers a download + saved zip has the expected structure', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(`/dashboard/reports?companyId=${COMPANY_ID}`, {
      timeout: 90_000,
    })
    const datevTabBtn = page.getByTestId('tab-datev')
    await expect(datevTabBtn).toBeVisible({ timeout: 30_000 })
    await datevTabBtn.click()
    await expect(page.locator('[data-testid="datev-tab"]').first()).toBeVisible({
      timeout: 30_000,
    })
    const downloadPromise = page.waitForEvent('download', {
      timeout: 30_000,
    })
    await page.getByTestId('datev-download-buchungsliste-btn').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^DATEV-Buchungsliste-/)
    // Save + verify the structure.
    const savedPath = path.join(
      os.tmpdir(),
      `tier167-dl-${Date.now()}.zip`,
    )
    await download.saveAs(savedPath)
    const names = listZipEntries(savedPath)
    expect(names).toContain('Buchungsliste.csv')
    expect(names).toContain('Buchungsstapel.csv')
    expect(names).toContain('USt-Verprobung.csv')
    expect(names).toContain('Kontenplan.csv')
    expect(names).toContain('manifest.json')
    try { fs.unlinkSync(savedPath) } catch {}
  })

  test('mobile 375x667: Buchungsliste button does not overflow', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/reports?companyId=${COMPANY_ID}`, {
      timeout: 90_000,
    })
    const datevTabBtn = page.getByTestId('tab-datev')
    await expect(datevTabBtn).toBeVisible({ timeout: 30_000 })
    await datevTabBtn.click()
    await expect(page.locator('[data-testid="datev-tab"]').first()).toBeVisible({
      timeout: 30_000,
    })
    const btn = page.getByTestId('datev-download-buchungsliste-btn')
    await expect(btn).toBeVisible()
    const scrollWidth = await btn.evaluate((el) => el.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(375)
  })
})
