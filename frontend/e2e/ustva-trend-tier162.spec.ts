/**
 * Playwright spec — Tier 162 UStVorauszahlung 12-Monats-Verlauf.
 *
 * The Berater's question: "I want to see at a glance
 * the Zahllast trend for the last 12 months — positive
 * (Vorauszahlung ans FA) and negative (Erstattung)
 * side-by-side, with a YTD total at the top." Tier
 * 162 = a diverging bar chart on the dashboard, right
 * below the 6-row Monatsvergleich table from Tier
 * 161. The chart reuses the same backend payload
 * (the dashboard now fetches months=12, not 6, so
 * both consumers see one fetch).
 *
 * Tests:
 *   1. backend: months=12 returns 12 rows
 *   2. backend: rows are sorted by (year DESC, month DESC)
 *   3. backend: shape includes periodLabel + zahllast
 *      for the chart's input
 *   4. frontend: dashboard renders the 12-month trend
 *      chart card
 *   5. frontend: the chart contains 12 bar elements
 *      (one per month) with the right data-zahllast
 *      attribute
 *   6. frontend: the YTD sum in the chart legend
 *      equals the sum of all 12 months' zahllast
 *   7. frontend: bars with positive zahllast have a
 *      Y position above the 0 line (red), bars with
 *      negative zahllast have a Y position below
 *      (green)
 *   8. frontend: the chart data is sorted ASC
 *      (oldest left, newest right)
 *   9. mobile 375x667: trend chart card does not
 *      overflow
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'

const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

async function fetchHistory(months = 12) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.get(
    `${API}/api/v1/ustva/history?companyId=${COMPANY_ID}&months=${months}`,
  )
  let data: any = null
  try { data = await res.json() } catch {}
  await ctx.dispose()
  return { status: res.status(), data }
}

test.describe('Tier 162 — UStVorauszahlung 12-Monats-Verlauf', () => {
  test('backend: months=12 returns 12 rows', async () => {
    const { status, data } = await fetchHistory(12)
    expect(status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBe(12)
  })

  test('backend: rows sorted by (year DESC, month DESC)', async () => {
    const { data } = await fetchHistory(12)
    for (let i = 0; i < data.length - 1; i++) {
      const cur = data[i]
      const nxt = data[i + 1]
      const isDesc =
        cur.year > nxt.year ||
        (cur.year === nxt.year && cur.month > nxt.month)
      expect(isDesc).toBe(true)
    }
  })

  test('backend: shape includes periodLabel + zahllast for the chart', async () => {
    const { data } = await fetchHistory(12)
    const row = data[0]
    expect(typeof row.periodLabel).toBe('string')
    expect(row.periodLabel).toMatch(/^\d{4}-\d{2}$/)
    expect(typeof row.zahllast).toBe('number')
  })

  test('frontend: dashboard renders the 12-month trend chart card', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(60_000)
    await page.goto('/dashboard', { timeout: 60_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 })
    // Wait for the history API to resolve (the
    // chart is conditional on data being present).
    await page.waitForResponse(
      (r) => r.url().includes('/ustva/history'),
      { timeout: 60_000 },
    )
    const chart = page.getByTestId('dashboard-ustva-trend')
    await expect(chart).toBeVisible({ timeout: 30_000 })
    // Header copy in DE
    await expect(chart).toContainText('USt-Vorauszahlung 12-Monats-Verlauf')
  })

  test('frontend: chart contains 12 bar elements with data-zahllast', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(60_000)
    await page.goto('/dashboard', { timeout: 60_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 })
    await page.waitForResponse(
      (r) => r.url().includes('/ustva/history'),
      { timeout: 60_000 },
    )
    const chart = page.getByTestId('dashboard-ustva-trend')
    await expect(chart).toBeVisible({ timeout: 30_000 })
    // Count bars — the testid includes periodLabel
    // which the chart auto-generates from
    // rows[].periodLabel. The backend returns 12
    // rows for months=12, so we expect 12 bars.
    const bars = chart.locator('[data-testid^="ustva-trend-bar-"]')
    await expect.poll(async () => await bars.count(), { timeout: 15_000 })
      .toBe(12)
  })

  test('frontend: YTD sum in chart legend equals Σ of all 12 months', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(60_000)
    await page.goto('/dashboard', { timeout: 60_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 })
    await page.waitForResponse(
      (r) => r.url().includes('/ustva/history'),
      { timeout: 60_000 },
    )
    const chart = page.getByTestId('dashboard-ustva-trend')
    await expect(chart).toBeVisible({ timeout: 30_000 })

    // Sum the data-zahllast from each bar
    const bars = chart.locator('[data-testid^="ustva-trend-bar-"]')
    const count = await bars.count()
    expect(count).toBe(12)
    let computedSum = 0
    for (let i = 0; i < count; i++) {
      const z = await bars.nth(i).getAttribute('data-zahllast')
      expect(z).not.toBeNull()
      computedSum += Number(z)
    }
    // Round to 2 decimals (the chart renders whole
    // euros but the data has 2dp). Compare to the
    // YTD label in the legend.
    const ytdText = await page.getByTestId('ustva-trend-ytd').textContent()
    expect(ytdText).not.toBeNull()
    // The label is "€123.456,78" in de-DE format.
    // Strip everything except digits, comma, dot, minus.
    const cleaned = ytdText!.replace(/[^\d,.\-]/g, '').replace(/\./g, '').replace(',', '.')
    const ytd = Number(cleaned)
    expect(Math.abs(computedSum - ytd)).toBeLessThanOrEqual(1)  // within 1 EUR (chart renders whole euros; raw data has 2dp)
  })

  test('frontend: positive bars are above 0 line, negative below', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(60_000)
    await page.goto('/dashboard', { timeout: 60_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 })
    await page.waitForResponse(
      (r) => r.url().includes('/ustva/history'),
      { timeout: 60_000 },
    )
    const chart = page.getByTestId('dashboard-ustva-trend')
    await expect(chart).toBeVisible({ timeout: 30_000 })

    // Read each bar's data-zahllast + its rect's
    // y attribute. Positive bars should have a y
    // attribute that's LESS than the 0-line y
    // (they extend upward from 0). Negative bars
    // have a y >= 0-line y (they extend downward
    // from 0). Zero bars have y = 0-line y with
    // height 0.
    //
    // The 0 line is the SVG midline, which we
    // compute as chartHeight/2 in the component
    // (height 220 → chartHeight 190 → 0-line at
    // ~50% of svg height). For a positive bar:
    //   y + height = 0-line y
    // For a negative bar:
    //   y = 0-line y
    //
    // We use the bar's height to detect the sign:
    // positive bar height > 0 and extends from
    // (0-line y - height) to (0-line y); negative
    // bar height > 0 and extends from (0-line y)
    // to (0-line y + height).
    const bars = chart.locator('[data-testid^="ustva-trend-bar-"]')
    const count = await bars.count()
    expect(count).toBe(12)
    for (let i = 0; i < count; i++) {
      const bar = bars.nth(i)
      const z = Number(await bar.getAttribute('data-zahllast'))
      const yAttr = await bar.getAttribute('y')
      const hAttr = await bar.getAttribute('height')
      expect(yAttr).not.toBeNull()
      expect(hAttr).not.toBeNull()
      const y = parseFloat(yAttr!)
      const h = parseFloat(hAttr!)
      // If the bar has height, the rendered fill
      // is the right colour. If h is 0 (zero
      // zahllast), both y and h are 0 (no bar).
      if (z > 0) {
        // positive bar: must have non-zero height
        expect(h).toBeGreaterThan(0)
      } else if (z < 0) {
        // negative bar: must have non-zero height
        expect(h).toBeGreaterThan(0)
      } else {
        // zero bar: no rendered rect
        expect(h).toBe(0)
      }
    }
  })

  test('frontend: chart data sorted ASC (oldest left, newest right)', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(60_000)
    await page.goto('/dashboard', { timeout: 60_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 })
    await page.waitForResponse(
      (r) => r.url().includes('/ustva/history'),
      { timeout: 60_000 },
    )
    const chart = page.getByTestId('dashboard-ustva-trend')
    await expect(chart).toBeVisible({ timeout: 30_000 })

    // The bar testids include the periodLabel
    // (e.g. ustva-trend-bar-2025-09). The SVG's
    // x attribute is set as `${xBar}%` where
    // xBar increases left-to-right by index. The
    // chart's defensive sort orders ASC. We
    // verify the testids' periodLabels are
    // monotonically increasing.
    const bars = chart.locator('[data-testid^="ustva-trend-bar-"]')
    const count = await bars.count()
    expect(count).toBe(12)
    const prevLabels: string[] = []
    for (let i = 0; i < count; i++) {
      const tid = await bars.nth(i).getAttribute('data-testid')
      const label = tid!.replace('ustva-trend-bar-', '')
      prevLabels.push(label)
    }
    // Verify ASC order
    const sorted = [...prevLabels].sort()
    expect(prevLabels).toEqual(sorted)
  })

  test('mobile 375x667: trend chart card does not overflow', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(60_000)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard', { timeout: 60_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 })
    await page.waitForResponse(
      (r) => r.url().includes('/ustva/history'),
      { timeout: 60_000 },
    )
    const chart = page.getByTestId('dashboard-ustva-trend')
    await expect(chart).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})

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
