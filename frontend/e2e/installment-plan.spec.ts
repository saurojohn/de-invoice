import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

/**
 * Tier 168a rewrite — Installment-Plan (Ratenplan) e2e.
 *
 * The original Tier 51 spec (circa 2026-04, pre-
 * multi-tenant, pre-PDF-signature, pre-DATEV-
 * Buchungsliste) read its auth tokens from a
 * stale file at `/tmp/cashbook-e2e-auth.env`
 * (the project was called "cashbook" before
 * the rebrand to "de-invoice"). That file
 * hasn't existed for years, so the spec
 * threw ENOENT in beforeAll() and 3 of 4
 * tests silently test.skipped()'d because
 * the testToken check at the top of each
 * `if (!testTokens) test.skip()` would have
 * caught it.
 *
 * Tier 168a replaces the entire spec with
 * the modern pattern (inlined constants,
 * contextWithAuth helper that sets cookies
 * + localStorage) that all Tier 100+ specs
 * use. No external state needed.
 *
 * Tests:
 *   1. create button opens modal + creates
 *      a 3-Raten plan
 *   2. by-invoice endpoint returns the plan
 *   3. pay button marks a Rate as paid
 *   4. invoice detail page still renders
 */

const COMPANY_ID = getTestEnv().companyId
const USER_ID = getTestEnv().userId
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

// Set cookies + localStorage so the
// dashboard route doesn't redirect to
// /login. Same pattern as Tier 100+
// specs (mahnung-fees-preview, pdf-signed,
// gobd-export, datev-buchungsliste, etc).
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

// Create a fresh seed invoice via the
// public API. Returns the invoice row.
// We create a unique customer per run
// (RUN_ID suffix) to avoid the "test
// customer unexpectedly has invoices"
// issue documented in customer-detail.spec.ts.
async function createSeedInvoice(
  page: any,
  suffix: string,
): Promise<any> {
  const customer = await page.request.post(
    `${API}/api/v1/customers?companyId=${COMPANY_ID}`,
    {
      headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
      data: {
        name: `Tier168a Ratenplan Cust ${suffix}`,
        address: {
          street: 'A',
          city: 'B',
          postalCode: '12345',
          country: 'DE',
        },
      },
    },
  )
  expect(customer.status()).toBe(201)
  const cust = await customer.json()
  const res = await page.request.post(
    `${API}/api/v1/invoices?companyId=${COMPANY_ID}`,
    {
      headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
      data: {
        customerId: cust.id,
        issueDate: new Date().toISOString(),
        dueDate: new Date(
          Date.now() + 14 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        items: [
          {
            description: `Tier168a plan test ${suffix}`,
            quantity: 1,
            unitPrice: 1200,
            vatRate: 0.19,
          },
        ],
      },
    },
  )
  expect(res.status()).toBe(201)
  return await res.json()
}

test.describe('Tier 168a — Ratenplan (installment plans) rewrite', () => {
  test('create button opens modal + creates a 3-Raten plan', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    const seed = await createSeedInvoice(page, String(Date.now()))

    await page.goto(
      `/dashboard/invoices/${seed.id}?companyId=${COMPANY_ID}`,
      { waitUntil: 'domcontentloaded' },
    )
    // The "Ratenplan anlegen" button is in the
    // new Ratenplan card header.
    const createBtn = page.getByTestId('installment-plan-create-button')
    await expect(createBtn).toBeVisible({ timeout: 30_000 })
    await createBtn.click()

    // Modal opens
    const modal = page.getByTestId('installment-plan-modal')
    await expect(modal).toBeVisible()
    // Fill the form (defaults are 3 Raten, 30
    // days, first due in 30 days). Override
    // the amount to match the invoice total.
    const countInput = page.getByTestId('installment-plan-count')
    await expect(countInput).toHaveValue('3')

    // Wait for the POST response so the
    // success close-animation doesn't race
    // the test.
    const postResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/installment-plans') &&
        r.url().includes('companyId=') &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    )
    await page.getByTestId('installment-plan-submit').click()
    const res = await postResponse
    expect([200, 201]).toContain(res.status())

    // The Raten schedule renders with 3 Raten.
    const rows = page.getByTestId('installment-row')
    await expect(rows).toHaveCount(3, { timeout: 10_000 })
  })

  test('by-invoice endpoint returns the freshly-created plan', async () => {
    // Tier 168 GTM multi-tenant drill uses
    // ADMIN_HEADERS directly via the
    // request fixture; we don't need a
    // browser context for this backend-only
    // assertion. (Same pattern as the other
    // backend-only tests in this spec file.)
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: ADMIN_HEADERS,
    })
    // List plans to find a Tier168a plan
    // (any plan with 3 installments).
    const list = await ctx.get(
      `${API}/api/v1/installment-plans?companyId=${COMPANY_ID}`,
    )
    const body = await list.json()
    const listData = Array.isArray(body) ? body : body.data || []
    const pw = listData.find(
      (p: any) => (p.installments ?? []).length === 3,
    )
    // Tier 369: was a test.skip(). The first test in this describe creates the
    // 3-Raten plan, and playwright.config sets workers: 1 + fullyParallel:
    // false, so it has always run before this one. The skip therefore only ever
    // fired when that create FAILED — turning one real failure into a green
    // run here. Assert instead, so a broken create fails in both places.
    expect(
      pw,
      'the create test above must have left a 3-Raten plan in the DB',
    ).toBeTruthy()
    const byInv = await ctx.get(
      `${API}/api/v1/installment-plans/by-invoice/${pw.invoiceId}?companyId=${COMPANY_ID}`,
    )
    expect(byInv.status()).toBe(200)
    const invPlan = await byInv.json()
    expect(invPlan.id).toBe(pw.id)
    expect(invPlan.installments.length).toBe(3)
    // Sum of installment amounts = totalAmount
    const sum = invPlan.installments.reduce(
      (s: number, i: any) => s + Number(i.amount),
      0,
    )
    expect(Math.abs(sum - Number(invPlan.totalAmount))).toBeLessThan(0.01)
    await ctx.dispose()
  })

  test('pay button marks a Rate as paid', async ({ page }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    // Use the request fixture (carries
    // cookies already from contextWithAuth
    // above) to find an existing plan with
    // an open Rate.
    // Tier 351b: ADMIN_HEADERS is REQUIRED here. HeaderAuthGuard reads
    // req.headers['x-user-id'] (header-auth.guard.ts:29), while
    // contextWithAuth() only sets COOKIES of that name plus localStorage.
    // Cookies travel as `Cookie:`, not as `x-user-id:`, and page.request
    // bypasses the browser entirely so the localStorage-based header
    // injection in lib/api.ts never runs either. Without the headers this
    // GET returns 403 with a {statusCode, message} body, `listBody.data
    // || []` yields [], and the test test.skip()'d itself on "no plan" --
    // which is why these two have never once executed. The setup calls at
    // the top of this file always passed ADMIN_HEADERS; these two list
    // calls just forgot.
    const list = await page.request.get(
      `${API}/api/v1/installment-plans?companyId=${COMPANY_ID}`,
      { headers: ADMIN_HEADERS },
    )
    const listBody = await list.json()
    const listData = Array.isArray(listBody)
      ? listBody
      : listBody.data || []
    const plan = listData.find((p: any) =>
      (p.installments ?? []).some(
        (i: any) => i.status === 'open' || i.status === 'partial',
      ),
    )
    // Tier 369: was a test.skip() — see the note on the by-invoice test above.
    expect(
      plan,
      'the create test above must have left a plan with an open Rate',
    ).toBeTruthy()
    const invoiceId = plan.invoiceId
    // Capture the first open Rate's
    // sequence number BEFORE navigating so
    // we can re-locate the row after the
    // pay (the row's pay button disappears
    // once the Rate is paid).
    const openInst = (plan.installments as any[]).find(
      (i) => i.status === 'open' || i.status === 'partial',
    )
    const seq = openInst.sequenceNumber

    await page.goto(
      `/dashboard/invoices/${invoiceId}?companyId=${COMPANY_ID}`,
      { waitUntil: 'domcontentloaded' },
    )
    // Wait for the Raten schedule to render.
    const rows = page.getByTestId('installment-row')
    await expect(rows.first()).toBeVisible({ timeout: 30_000 })

    // Find the first row that has a pay
    // button (i.e. is still open / partial).
    const openRow = page
      .getByTestId('installment-row')
      .filter({ has: page.getByTestId('installment-pay-button') })
      .first()
    await expect(openRow).toBeVisible({ timeout: 10_000 })

    const payResponse = page.waitForResponse(
      (r) => r.url().includes('/pay?companyId='),
      { timeout: 15_000 },
    )
    await openRow.getByTestId('installment-pay-button').click()
    const res = await payResponse
    expect([200, 201]).toContain(res.status())

    // The Rate that was just paid is now
    // in the N-th row (1-based
    // sequenceNumber). Reload the page to
    // get the server-rendered status, then
    // assert the badge text is the German
    // "bezahlt".
    //
    // Tier 351c: the flag on this regex is load-bearing. The badge
    // renders capitalised -- "Bezahlt" -- so the original
    // /bezahlt|paid/ could never match. The pay itself always worked;
    // only the assertion was wrong, and nobody found out because the
    // test skipped before ever reaching this line (its list call was
    // missing ADMIN_HEADERS, so it 401'd and bailed on "no plan").
    await page.reload({ waitUntil: 'domcontentloaded' })
    const nthRow = page.getByTestId('installment-row').nth(seq - 1)
    await expect(nthRow).toBeVisible({ timeout: 15_000 })
    await expect(nthRow).toContainText(/bezahlt|paid/i, { timeout: 5_000 })
  })

  test('invoice detail page still renders (smoke regression)', async ({
    page,
  }) => {
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    // Tier 351b: ADMIN_HEADERS is REQUIRED here. HeaderAuthGuard reads
    // req.headers['x-user-id'] (header-auth.guard.ts:29), while
    // contextWithAuth() only sets COOKIES of that name plus localStorage.
    // Cookies travel as `Cookie:`, not as `x-user-id:`, and page.request
    // bypasses the browser entirely so the localStorage-based header
    // injection in lib/api.ts never runs either. Without the headers this
    // GET returns 403 with a {statusCode, message} body, `listBody.data
    // || []` yields [], and the test test.skip()'d itself on "no plan" --
    // which is why these two have never once executed. The setup calls at
    // the top of this file always passed ADMIN_HEADERS; these two list
    // calls just forgot.
    const list = await page.request.get(
      `${API}/api/v1/installment-plans?companyId=${COMPANY_ID}`,
      { headers: ADMIN_HEADERS },
    )
    const listBody = await list.json()
    const listData = Array.isArray(listBody)
      ? listBody
      : listBody.data || []
    const plan = listData[0]
    // Tier 369: was a test.skip() — see the note on the by-invoice test above.
    expect(
      plan,
      'the create test above must have left at least one installment plan',
    ).toBeTruthy()
    await page.goto(
      `/dashboard/invoices/${plan.invoiceId}?companyId=${COMPANY_ID}`,
      { waitUntil: 'domcontentloaded' },
    )
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/invoices/${plan.invoiceId}`),
      { timeout: 15_000 },
    )
    // The new Ratenplan card is present.
    await expect(
      page.getByTestId('installment-plan-card'),
    ).toBeVisible({ timeout: 10_000 })
  })
})
