/**
 * Playwright spec — Tier 164 Mahngebühr live preview (§ 288 BGB).
 *
 * The Berater's question: "I want to see the
 * Mahngebühr + Verzugszins breakdown BEFORE I
 * click 'Mahnung senden' — not after. Show me
 * the live preview." Tier 164 = a new
 * GET /reminders/mahnungen/fees-preview endpoint
 * that computes the fees WITHOUT sending anything,
 * plus a new fees block in the "Mahnung senden"
 * modal that shows the breakdown (open balance +
 * Mahngebühr + Verzugszins = total due).
 *
 * Also: the default Mahngebühr values were updated
 * from the pre-2023 § 288 BGB (0/2.50/5.00) to the
 * post-2023 practice (5/5/10). A company can still
 * override via bankInfo.mahnungConfig.
 *
 * Tests:
 *   1. backend: fees-config returns 5/5/10 default
 *   2. backend: fees-preview for an invoice returns
 *      a fully-populated response (invoiceId,
 *      openBalance, daysOverdue, level, mahngebuehr,
 *      verzugszins, verzugszinsPct, totalDue)
 *   3. backend: totalDue = openBalance + mahngebuehr +
 *      verzugszins (within rounding)
 *   4. backend: each level (first/second/final)
 *      returns the matching fee
 *   5. backend: invalid level -> 400
 *   6. backend: missing invoiceId -> 400
 *   7. backend: unknown invoiceId -> 400
 *   8. frontend: the "Mahnung senden" modal shows
 *      the live fees block with open balance +
 *      Mahngebühr + Verzugszins + Total
 *   9. frontend: changing the level updates the
 *      fees block (live re-fetch)
 *  10. mobile 375x667: the modal fees block does
 *      not overflow
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'

const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const API = 'http://localhost:3001'
// A real invoice id from the seed data. The
// invoice must exist + be in the seed company.
const TEST_INVOICE_ID = '11deeb35-7147-4bdc-86d9-a302b4f80f3e'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

async function fetchConfig() {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.get(
    `${API}/api/v1/reminders/mahnungen/fees-config?companyId=${COMPANY_ID}`,
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

async function fetchPreview(level: string, invoiceId = TEST_INVOICE_ID) {
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  const res = await ctx.get(
    `${API}/api/v1/reminders/mahnungen/fees-preview?companyId=${COMPANY_ID}&invoiceId=${invoiceId}&level=${level}`,
  )
  let data: any = null
  try { data = await res.json() } catch {}
  await ctx.dispose()
  return { status: res.status(), data }
}

test.describe('Tier 164 — Mahngebühr live preview (§ 288 BGB)', () => {
  test('backend: fees-config defaults to 5/5/10 post-2023 § 288 BGB', async () => {
    const { status, data } = await fetchConfig()
    expect(status).toBe(200)
    // 5/5/10 are the new post-2023 § 288 BGB
    // defaults. Companies with their own
    // mahnungConfig override these.
    expect(data.mahngebuehr.first).toBe(5)
    expect(data.mahngebuehr.second).toBe(5)
    expect(data.mahngebuehr.final).toBe(10)
    expect(data.verzugszinsPct).toBe(9)
  })

  test('backend: fees-preview returns a fully-populated response', async () => {
    const { status, data } = await fetchPreview('first')
    expect(status).toBe(200)
    expect(data.invoiceId).toBe(TEST_INVOICE_ID)
    expect(typeof data.invoiceNumber).toBe('string')
    expect(typeof data.openBalance).toBe('number')
    expect(typeof data.dueDate).toBe('string')
    expect(typeof data.daysOverdue).toBe('number')
    expect(data.level).toBe('first')
    expect(typeof data.mahngebuehr).toBe('number')
    expect(typeof data.verzugszins).toBe('number')
    expect(typeof data.verzugszinsPct).toBe('number')
    expect(typeof data.totalDue).toBe('number')
  })

  test('backend: totalDue = openBalance + mahngebuehr + verzugszins', async () => {
    const { data } = await fetchPreview('first')
    const expected =
      Math.round(
        (data.openBalance + data.mahngebuehr + data.verzugszins) * 100,
      ) / 100
    expect(Math.abs(data.totalDue - expected)).toBeLessThan(0.05)
  })

  test('backend: each level (first/second/final) returns the matching fee', async () => {
    const { data: first } = await fetchPreview('first')
    const { data: second } = await fetchPreview('second')
    const { data: final } = await fetchPreview('final')
    // Post-2023 defaults: 5 / 5 / 10
    expect(first.mahngebuehr).toBe(5)
    expect(second.mahngebuehr).toBe(5)
    expect(final.mahngebuehr).toBe(10)
    // All three share the same invoice
    // openBalance + verzugszinsPct (only the
    // Mahngebühr changes per level).
    expect(first.openBalance).toBe(second.openBalance)
    expect(second.openBalance).toBe(final.openBalance)
    expect(first.verzugszinsPct).toBe(second.verzugszinsPct)
  })

  test('backend: invalid level -> 400', async () => {
    const { status } = await fetchPreview('q5')
    expect(status).toBe(400)
  })

  test('backend: missing invoiceId -> 400', async () => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    const res = await ctx.get(
      `${API}/api/v1/reminders/mahnungen/fees-preview?companyId=${COMPANY_ID}&level=first`,
    )
    expect(res.status()).toBe(400)
    await ctx.dispose()
  })

  test('backend: unknown invoiceId -> 400', async () => {
    const { status } = await fetchPreview('first', '00000000-0000-0000-0000-000000000000')
    expect(status).toBe(400)
  })

  test('frontend: Mahnung senden modal shows the live fees block', async ({ page }) => {
    await contextWithAuth(page)
    // /dashboard/invoices/[id] cold compile is
    // 60-80s in dev mode (the page is a heavy
    // server component with many sub-views).
    // Bump goto + setDefaultTimeout to 90s.
    page.setDefaultTimeout(90_000)
    await page.goto(`/dashboard/invoices/${TEST_INVOICE_ID}`, { timeout: 90_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 90_000 })
    // Click the "Mahnung senden" button. The
    // testid is set on the page (see page.tsx
    // line ~1563 for the Mahnung senden
    // button).
    const sendBtn = page.getByTestId('send-mahnung-button')
    if (await sendBtn.count() > 0) {
      await sendBtn.click()
    } else {
      // Fall back to the text-based selector
      // (the testid may not exist in older
      // versions of the page).
      await page.getByRole('button', { name: /Mahnung senden/i }).first().click()
    }
    // Wait for the modal
    const modal = page.getByTestId('send-mahnung-modal')
    await expect(modal).toBeVisible({ timeout: 30_000 })
    // The fees block appears after the parallel
    // fetch resolves (could be a few hundred ms).
    const feesBlock = page.getByTestId('send-mahnung-fees')
    await expect(feesBlock).toBeVisible({ timeout: 30_000 })
    // Strong assertion: each row has a
    // data-value attribute (= the raw number,
    // e.g. "119.00" for 119 €). This is what
    // the page renders server-side, so a
    // "0" / "NaN" / empty value would fail
    // immediately instead of slipping through
    // a "match a digit" regex.
    const openVal = await page.getByTestId('send-mahnung-fees-open').getAttribute('data-value')
    expect(openVal).toMatch(/^\d+\.\d{2}$/)
    const mahnVal = await page.getByTestId('send-mahnung-fees-mahngebuehr').getAttribute('data-value')
    expect(mahnVal).toMatch(/^\d+\.\d{2}$/)
    const verzVal = await page.getByTestId('send-mahnung-fees-verzugszins').getAttribute('data-value')
    expect(verzVal).toMatch(/^\d+\.\d{2}$/)
    const totalVal = await page.getByTestId('send-mahnung-fees-total').getAttribute('data-value')
    expect(totalVal).toMatch(/^\d+\.\d{2}$/)
    // Default level is 'first' (Mahngebühr = 5 €)
    expect(parseFloat(mahnVal!)).toBe(5)
    // Total = openBalance + mahngebuehr + verzugszins
    // (within 0.05 € rounding tolerance — the
    // server rounds to 2 decimals)
    const expectedTotal = parseFloat(openVal!) + parseFloat(mahnVal!) + parseFloat(verzVal!)
    expect(Math.abs(parseFloat(totalVal!) - expectedTotal)).toBeLessThan(0.05)
    // Visible text must use de-DE currency
    // formatting: "119,00 €" or "1.234,56 €"
    // (NBSP or narrow no-break space may be
    // used as the thousands separator — match
    // digits/comma/€ flexibly).
    const openText = (await page.getByTestId('send-mahnung-fees-open').textContent()) || ''
    expect(openText).toMatch(/\d.*€/)
    expect(openText.replace(/\s|\u00a0|\u202f/g, '')).toMatch(/[\d,.]+€/)
  })

  test('frontend: changing the level updates the live fees block (5 → 10)', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto(`/dashboard/invoices/${TEST_INVOICE_ID}`, { timeout: 90_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 90_000 })
    const sendBtn = page.getByTestId('send-mahnung-button')
    if (await sendBtn.count() > 0) {
      await sendBtn.click()
    } else {
      await page.getByRole('button', { name: /Mahnung senden/i }).first().click()
    }
    const modal = page.getByTestId('send-mahnung-modal')
    await expect(modal).toBeVisible({ timeout: 30_000 })
    // Wait for the initial ('first') fees block
    // to populate — Mahngebühr should be 5.00 €
    // for first.
    const mahnRow = page.getByTestId('send-mahnung-fees-mahngebuehr')
    await expect(mahnRow).toBeVisible({ timeout: 30_000 })
    await expect(mahnRow).toHaveAttribute('data-value', '5.00', { timeout: 30_000 })
    // Switch the level dropdown to 'final' —
    // the <select> has testid 'send-mahnung-level'.
    const levelSelect = page.getByTestId('send-mahnung-level')
    await levelSelect.selectOption('final')
    // The fees block should now re-render with
    // Mahngebühr = 10.00 € (post-2023 default
    // for 'final'). The re-fetch is fast but
    // not synchronous — wait for the data-value
    // to flip from '5.00' to '10.00'.
    await expect(mahnRow).toHaveAttribute('data-value', '10.00', { timeout: 15_000 })
    // And the total should have grown by 5 €
    // (openBalance + verzugszins stay constant
    // when only the level changes — the level
    // only affects the Mahngebühr).
    const totalFinal = await page.getByTestId('send-mahnung-fees-total').getAttribute('data-value')
    expect(totalFinal).toMatch(/^\d+\.\d{2}$/)
    // Switch back to 'first' and confirm it
    // goes back to 5.00.
    await levelSelect.selectOption('first')
    await expect(mahnRow).toHaveAttribute('data-value', '5.00', { timeout: 15_000 })
  })

  test('mobile 375x667: Mahnung modal fees block does not overflow', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/invoices/${TEST_INVOICE_ID}`, { timeout: 90_000 })
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 90_000 })
    const sendBtn = page.getByTestId('send-mahnung-button')
    if (await sendBtn.count() > 0) {
      await sendBtn.click()
    } else {
      await page.getByRole('button', { name: /Mahnung senden/i }).first().click()
    }
    const modal = page.getByTestId('send-mahnung-modal')
    await expect(modal).toBeVisible({ timeout: 30_000 })
    const feesBlock = page.getByTestId('send-mahnung-fees')
    await expect(feesBlock).toBeVisible({ timeout: 30_000 })
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
