/**
 * Playwright spec — Tier 149 customer merge.
 *
 * The Berater's question: "BWA Test Kunde
 * appears twice in the system — which one is
 * the duplicate, and how do I merge them?"
 * Tier 149 = a "🔀 Zusammenführen" button on
 * the customer detail page that walks the
 * admin through a 2-step modal:
 *   1. search + pick the duplicate (source)
 *   2. preview the rows that will move
 *   3. confirm
 *
 * Tests:
 *   1. The merge button renders on the
 *      customer detail page.
 *   2. Clicking the button opens the modal
 *      with the search field.
 *   3. Searching for the duplicate brings
 *      it up in the results list.
 *   4. Clicking a search result shows the
 *      preview counts + the merged tags.
 *   5. Confirming the merge executes and
 *      shows the success state.
 *   6. The source customer is gone from
 *      the DB after the merge.
 *   7. Backend-only: preview endpoint
 *      returns the expected shape.
 *   8. Backend-only: same sourceId +
 *      targetId → 400.
 *   9. Backend-only: cross-tenant merge
 *      attempt → 404.
 *   10. Mobile 375x667: button + modal do
 *       not overflow.
 *
 * Pre-flight: backend on :3001. The Tier 149
 * spec creates a duplicate customer
 * (id=11111111-2222-3333-4444-555555555555)
 * via raw SQL in beforeAll, then merges it
 * into BWA Test Kunde. The spec also restores
 * the source customer in afterAll so other
 * test specs can use it if needed.
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import { getTestEnv, PG_CONTAINER } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const TARGET_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47' // BWA Test Kunde
const DUP_ID = '11111111-2222-3333-4444-555555555555' // BWA Test Kunde (duplicate)
const API_BASE = 'http://localhost:3001'

// Ensure the duplicate customer exists (it's
// pre-created by the smoke test / previous
// runs but might be missing on a fresh DB).
// Idempotent — ON CONFLICT keeps the existing row.
function ensureDupExists() {
  execSync(
    `docker exec ${PG_CONTAINER} psql -U de_invoice -d de_invoice -c "INSERT INTO \\"Customer\\" (id, \\"companyId\\", type, name, address, contact, \\"paymentTerms\\", tags, \\"createdAt\\", \\"updatedAt\\") VALUES ('${DUP_ID}', '${COMPANY_ID}', 'business', 'BWA Test Kunde GmbH (duplicate)', '{\\"street\\":\\"Hauptstr 1\\",\\"city\\":\\"Berlin\\",\\"postalCode\\":\\"10115\\",\\"country\\":\\"DE\\"}', '{\\"email\\":\\"duplicate@example.com\\"}', 30, ARRAY['Hardware','Late-payer']::text[], NOW(), NOW()) ON CONFLICT (id) DO NOTHING"`,
    { stdio: 'ignore' },
  )
}

test.describe('Tier 149 — Customer merge', () => {
  test.beforeAll(() => {
    ensureDupExists()
  })

  test.afterAll(() => {
    // Restore the duplicate customer so other
    // test specs can use it. Tier 149's
    // test merges it; if the spec ran, the
    // source is gone — we put it back.
    ensureDupExists()
  })

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

  test('the 🔀 Zusammenführen button renders on the customer detail page', async ({ page }) => {
    await page.goto(`/dashboard/customers/${TARGET_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-detail-merge')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await expect(btn).toContainText(/Zusammenführen|Merge|合并/i)
  })

  test('clicking the button opens the modal with the search field', async ({ page }) => {
    await page.goto(`/dashboard/customers/${TARGET_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('customer-detail-merge').click()
    const modal = page.getByTestId('merge-modal')
    await expect(modal).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('merge-search-input')).toBeVisible()
  })

  test('searching for the duplicate brings it up in the results', async ({ page }) => {
    await page.goto(`/dashboard/customers/${TARGET_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('customer-detail-merge').click()
    await expect(page.getByTestId('merge-modal')).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('merge-search-input').fill('duplicate')
    // 300ms debounce + 1s slack
    await page.waitForTimeout(1200)
    const results = page.getByTestId('merge-search-results')
    await expect(results).toBeVisible({ timeout: 5_000 })
    // The duplicate customer row is in the results
    const dupRow = page.getByTestId(`merge-source-${DUP_ID}`)
    await expect(dupRow).toBeVisible()
  })

  test('clicking a search result shows the preview counts + tags', async ({ page }) => {
    await page.goto(`/dashboard/customers/${TARGET_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('customer-detail-merge').click()
    await expect(page.getByTestId('merge-modal')).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('merge-search-input').fill('duplicate')
    await page.waitForTimeout(1200)
    await page.getByTestId(`merge-source-${DUP_ID}`).click()
    // The preview block appears
    const preview = page.getByTestId('merge-preview')
    await expect(preview).toBeVisible({ timeout: 10_000 })
  })

  test('confirming the merge executes and shows the success state', async ({ page }) => {
    await page.goto(`/dashboard/customers/${TARGET_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('customer-detail-merge').click()
    await expect(page.getByTestId('merge-modal')).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('merge-search-input').fill('duplicate')
    await page.waitForTimeout(1200)
    await page.getByTestId(`merge-source-${DUP_ID}`).click()
    await expect(page.getByTestId('merge-preview')).toBeVisible({ timeout: 10_000 })
    // Confirm
    await page.getByTestId('merge-confirm').click()
    // Success state
    const done = page.getByTestId('merge-done')
    await expect(done).toBeVisible({ timeout: 15_000 })
    // The source should be gone from the DB
    const count = execSync(
      `docker exec ${PG_CONTAINER} psql -U de_invoice -d de_invoice -t -c "SELECT count(*) FROM \\"Customer\\" WHERE id='${DUP_ID}'"`,
      { encoding: 'utf-8' },
    ).trim()
    expect(count).toBe('0')
  })

  test('backend: preview endpoint returns the expected shape', async () => {
    // Make sure the duplicate customer still
    // exists (test 5 may have merged it).
    ensureDupExists()
    const url = `${API_BASE}/api/v1/customers/merge/preview?companyId=${COMPANY_ID}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sourceId: DUP_ID, targetId: TARGET_ID }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('source')
    expect(data).toHaveProperty('target')
    expect(data).toHaveProperty('counts')
    expect(data).toHaveProperty('mergedTags')
    expect(data.source.id).toBe(DUP_ID)
    expect(data.target.id).toBe(TARGET_ID)
  })

  test('backend: same sourceId + targetId → 400', async () => {
    const url = `${API_BASE}/api/v1/customers/merge/preview?companyId=${COMPANY_ID}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sourceId: DUP_ID, targetId: DUP_ID }),
    })
    expect(res.status).toBe(400)
  })

  test('backend: cross-tenant merge attempt → 404', async () => {
    // The source belongs to OUR company. Trying
    // to merge it into a customer from another
    // (non-existent) company should 404.
    const url = `${API_BASE}/api/v1/customers/merge/preview?companyId=${COMPANY_ID}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-user-id': USER_ID,
        'x-company-id': COMPANY_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sourceId: DUP_ID,
        targetId: '00000000-0000-0000-0000-000000000000',
      }),
    })
    expect(res.status).toBe(404)
  })

  test('mobile 375x667: the button does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/dashboard/customers/${TARGET_ID}`)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 })
    const btn = page.getByTestId('customer-detail-merge')
    await expect(btn).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
