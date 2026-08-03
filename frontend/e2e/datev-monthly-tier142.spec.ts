/**
 * Playwright spec — Tier 142 DATEV monthly split export.
 *
 * The DATEV tab on /dashboard/reports has a 4th
 * button "📅 Per Monat aufteilen (ZIP)" that hits
 * the new backend endpoint
 *   GET /api/v1/reports/datev-export-monthly
 *   ?companyId=X&startDate=A&endDate=B
 *
 * The endpoint walks every month in the range and
 * produces one CSV per month + per-month Belegbilder
 * subfolders. The Berater can then import each
 * month as its own Buchungslauf.
 *
 * Tests:
 *   1. The new button renders inside the DATEV tab
 *      with the correct testid.
 *   2. The backend endpoint, called directly with
 *      a known date range, returns a ZIP whose
 *      MANIFEST.json lists the expected number of
 *      months (and skips empty months in the ZIP
 *      body).
 *   3. The endpoint is registered at the expected
 *      path (smoke check via the global setup).
 *   4. Mobile 375x667: the button row still fits
 *      (4 buttons in a flex-wrap row).
 *
 * Pre-flight: backend on :3001, frontend on :3100.
 * We don't seed paid invoices here — the test
 * asserts on the MANIFEST shape, not on the row
 * count, because the shared DB has no paid
 * invoices outside of brief smoke windows. The
 * MANIFEST lists every month walked regardless
 * of row count.
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'

const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const API_BASE = 'http://localhost:3001'

test.describe('Tier 142 — DATEV monthly split', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      { name: 'x-user-id', value: USER_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
      { name: 'x-company-id', value: COMPANY_ID, domain: 'localhost', path: '/', sameSite: 'Lax' },
    ])
    await page.addInitScript(({ userId, companyId }) => {
      localStorage.setItem('userId', userId)
      localStorage.setItem('companyId', companyId)
    }, { userId: USER_ID, companyId: COMPANY_ID })
  })

  test('the Per-Monat-aufteilen button renders in the DATEV tab', async ({ page }) => {
    await page.goto('/dashboard/reports')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // The default tab is "Umsatzbericht" — switch to DATEV.
    await page.getByTestId('tab-datev').click()
    const btn = page.getByTestId('datev-download-monthly-btn')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await expect(btn).toContainText(/Per Monat aufteilen|Split by month|按月拆分/i)
  })

  test('backend endpoint returns a ZIP with per-month MANIFEST.json', async () => {
    // Call the endpoint directly. This test does NOT
    // depend on the database state — we assert on the
    // response shape (status 200, ZIP magic bytes,
    // MANIFEST.json has the months array).
    const url = `${API_BASE}/api/v1/reports/datev-export-monthly?companyId=${COMPANY_ID}&startDate=2026-07-01&endDate=2026-09-30`
    const res = await fetch(url, {
      headers: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
      },
    })
    expect(res.status).toBe(200)
    const buf = Buffer.from(await res.arrayBuffer())
    // PK\x03\x04 — ZIP local file header magic
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
    expect(buf[2]).toBe(0x03)
    expect(buf[3]).toBe(0x04)
    // Write to /tmp and unzip it via the shell to
    // assert on the MANIFEST structure. The CSV rows
    // themselves vary by DB state so we don't assert
    // on those. We use writeFileSync (NOT a shell
    // printf) because the binary contains null bytes
    // that get mangled by the shell argv parser.
    writeFileSync('/tmp/datev-tier142.zip', buf)
    const manifest = execSync(
      `unzip -p /tmp/datev-tier142.zip MANIFEST.json | python3 -m json.tool`,
      { encoding: 'utf-8' },
    )
    const m = JSON.parse(manifest)
    expect(m.companyId).toBe(COMPANY_ID)
    expect(m.months).toBeInstanceOf(Array)
    // 3 months in [2026-07, 2026-09]
    expect(m.months.length).toBe(3)
    expect(m.months[0].key).toBe('2026-07')
    expect(m.months[0].laufNr).toBe(1)
    expect(m.months[1].key).toBe('2026-08')
    expect(m.months[1].laufNr).toBe(2)
    expect(m.months[2].key).toBe('2026-09')
    expect(m.months[2].laufNr).toBe(3)
    // Every month entry has the expected fields
    for (const month of m.months) {
      expect(month).toHaveProperty('buchungenCount')
      expect(month).toHaveProperty('belegbilderIncluded')
      expect(month).toHaveProperty('belegbilderMissing')
      expect(month).toHaveProperty('csvBytes')
    }
    // Totals rolled up correctly
    expect(m.totals.months).toBe(3)
    expect(m.totals.buchungen).toBe(
      m.months.reduce((s: number, mo: any) => s + mo.buchungenCount, 0),
    )
  })

  test('backend endpoint validates the date range', async () => {
    // startDate > endDate → 400
    const res = await fetch(
      `${API_BASE}/api/v1/reports/datev-export-monthly?companyId=${COMPANY_ID}&startDate=2026-12-31&endDate=2026-01-01`,
      { headers: { 'x-user-id': USER_ID, 'x-company-id': COMPANY_ID } },
    )
    expect(res.status).toBe(400)
  })

  test('mobile 375x667: DATEV button row does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard/reports')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    // Switch to DATEV tab
    await page.getByTestId('tab-datev').click()
    const btn = page.getByTestId('datev-download-monthly-btn')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
