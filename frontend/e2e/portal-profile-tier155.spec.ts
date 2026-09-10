/**
 * Playwright spec — Tier 155 portal profile editing.
 *
 * Verifies:
 *   1. GET /api/v1/customer-portal/profile returns the
 *      customer (no token → 400; valid token → public
 *      fields, no internalNotes)
 *   2. PATCH /profile updates name + contact.phone +
 *      address.city; merges into JSON (preserves other
 *      fields like email, country)
 *   3. PATCH with invalid email → 400 (German msg)
 *   4. PATCH with empty name → 400
 *   5. Frontend: profile card renders + "Bearbeiten"
 *      button → edit form → save → success banner
 *   6. Mobile 375x667: profile section does not overflow
 *
 * Pre-flight: backend on :3001, Tier 130 portal
 * service, the test customer
 * `tier133-customer@example.com` has an email set
 * and a non-empty profile.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'
import { PG_CONTAINER } from './fixtures/test-env'

const CUSTOMER_ID = 'b3f7b274-7696-44b8-9345-8bfd460b3e47'
const API = 'http://localhost:3001'

// The portal request-session endpoint is rate-limited
// to 5 requests per 5 min per email. We have ~10
// tests in this suite. We get around the limit by
// using a fresh, run-unique email per spec run, and
// UPSERTing the test customer to that email. The
// customer row itself is shared (so the tests
// interact with the same fixtures the rest of the
// app uses).
const RUN_ID = `t155-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const TEST_EMAIL = `${RUN_ID}@example.com`

function ensureCustomer() {
  // Use a fresh, run-unique email so the request-session
  // rate limit (5 per 5 min per email) doesn't trip. The
  // other fields mirror the Tier 133 fixture so the
  // profile shape matches what the UI expects.
  // Write SQL to a temp file and pipe it via stdin to
  // psql — avoids the shell-quoting hell of trying to
  // embed JSON literal with double quotes inside a
  // double-quoted -c arg.
  const sql = `UPDATE "Customer" SET contact = '{"email":"${TEST_EMAIL}"}'::jsonb, address = '{"country":"Deutschland"}'::jsonb WHERE id = '${CUSTOMER_ID}';`
  const path = `/tmp/tier155-customer-${RUN_ID}.sql`
  require('fs').writeFileSync(path, sql)
  try {
    execSync(
      `docker exec -i ${PG_CONTAINER} psql -U de_invoice -d de_invoice < ${path}`,
      { stdio: 'pipe' },
    )
  } finally {
    try { require('fs').unlinkSync(path) } catch {}
  }
}

async function getToken(): Promise<string> {
  const ctx = await playwrightRequest.newContext()
  const res = await ctx.post(
    `${API}/api/v1/customer-portal/request-session?email=${encodeURIComponent(TEST_EMAIL)}`,
  )
  expect(res.status()).toBe(201)
  await ctx.dispose()
  // Read the latest token from the backend log
  const fs = await import('fs/promises')
  const log = await fs.readFile('/tmp/backend.log', 'utf-8')
  const lines = log.split('\n').filter((l) => l.includes('portal session created'))
  const last = lines[lines.length - 1] || ''
  const m = last.match(/token=([0-9a-f]{64})/)
  expect(m, 'expected to find a portal session token in /tmp/backend.log').toBeTruthy()
  return m![1]
}

async function getProfile(token: string) {
  const ctx = await playwrightRequest.newContext()
  const res = await ctx.get(
    `${API}/api/v1/customer-portal/profile?token=${token}`,
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

async function patchProfile(token: string, body: any) {
  const ctx = await playwrightRequest.newContext()
  const res = await ctx.patch(
    `${API}/api/v1/customer-portal/profile?token=${token}`,
    { data: body },
  )
  const data = await res.json()
  await ctx.dispose()
  return { status: res.status(), data }
}

test.describe('Tier 155 — Portal profile', () => {
  // The portal request-session endpoint is rate-limited to
  // 5 requests per 5 min per email. We have ~10 tests in
  // this suite, so we (a) use a run-unique email to avoid
  // sharing the rate-limit bucket with previous runs, and
  // (b) request ONE token at the start (in beforeAll) and
  // reuse it for every test that needs a valid session —
  // the session has a 30-day sliding TTL.
  let sharedToken: string
  test.beforeAll(async () => {
    ensureCustomer()
    sharedToken = await getToken()
  })

  test.afterAll(() => {
    // Restore the customer to the standard Tier 133
    // fixture so the next spec (or the next run) starts
    // from a known state. (Belt + suspenders: Tier 145
    // / 154 specs may also depend on the contact.email
    // being `tier133-customer@example.com`.)
    const sql = `UPDATE "Customer" SET contact = '{"email":"tier133-customer@example.com"}'::jsonb, address = '{"country":"Deutschland"}'::jsonb WHERE id = '${CUSTOMER_ID}';`
    const path = `/tmp/tier155-restore-${RUN_ID}.sql`
    require('fs').writeFileSync(path, sql)
    try {
      execSync(
        `docker exec -i ${PG_CONTAINER} psql -U de_invoice -d de_invoice < ${path}`,
        { stdio: 'pipe' },
      )
    } finally {
      try { require('fs').unlinkSync(path) } catch {}
    }
  })

  test('GET /profile returns the customer (no internalNotes)', async () => {
    const { status, data } = await getProfile(sharedToken)
    expect(status).toBe(200)
    expect(data.id).toBe(CUSTOMER_ID)
    expect(data.name).toBeTruthy()
    expect(data.contact).toBeTruthy()
    // Public fields only — no operator-only fields
    expect(data.internalNotes).toBeUndefined()
    expect(data.paymentTerms).toBeUndefined()
    expect(data.creditLimit).toBeUndefined()
    expect(data.tags).toBeUndefined()
  })

  test('GET /profile with empty token → 400', async () => {
    const { status, data } = await getProfile('')
    expect(status).toBe(400)
    expect(data.message).toMatch(/token is required/i)
  })

  test('PATCH /profile updates name + contact.phone + address.city', async () => {
    const stamp = `tier155-${Date.now()}`
    const { status, data } = await patchProfile(sharedToken, {
      name: 'BWA Test Kunde (Tier 155)',
      contact: { phone: '+49 40 9999-155' },
      address: { city: 'Hamburg' },
    })
    expect(status).toBe(200)
    expect(data.name).toBe('BWA Test Kunde (Tier 155)')
    expect(data.contact?.phone).toBe('+49 40 9999-155')
    expect(data.address?.city).toBe('Hamburg')
    // The pre-existing email + country must still be there (merge, not replace)
    expect(data.contact?.email).toBe(TEST_EMAIL)
    expect(data.address?.country).toBe('Deutschland')
    expect(stamp.length).toBeGreaterThan(0)
  })

  test('PATCH /profile with invalid email → 400', async () => {
    const { status, data } = await patchProfile(sharedToken, {
      contact: { email: 'not-an-email' },
    })
    expect(status).toBe(400)
    expect(data.message).toMatch(/ungültige e-mail/i)
  })

  test('PATCH /profile with empty name → 400', async () => {
    const { status, data } = await patchProfile(sharedToken, {
      name: '   ',
    })
    expect(status).toBe(400)
    expect(data.message).toMatch(/name is required/i)
  })

  test('PATCH /profile with empty token → 400', async () => {
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.patch(`${API}/api/v1/customer-portal/profile`, {
      data: { name: 'X' },
    })
    expect(res.status()).toBe(400)
    const data = await res.json()
    expect(data.message).toMatch(/token is required/i)
    await ctx.dispose()
  })

  test('PATCH /profile with garbage token → 401', async () => {
    const { status, data } = await patchProfile('a'.repeat(64), { name: 'X' })
    expect(status).toBe(401)
    expect(data.message).toMatch(/ungültiger oder abgelaufener link/i)
  })

  test('Frontend: profile card renders + edit + save flow', async ({ page }) => {
    const token = sharedToken
    await page.goto(`/portal?token=${token}`)
    await expect(page.getByTestId('portal-customer-name')).toBeVisible({
      timeout: 10_000,
    })
    // Profile card is between the summary tiles and the invoice table
    const card = page.getByTestId('portal-profile-card')
    await expect(card).toBeVisible()
    // Display mode shows the current email
    await expect(page.getByTestId('portal-profile-display-email')).toContainText(
      TEST_EMAIL,
    )
    // Click Bearbeiten → form appears
    await page.getByTestId('portal-profile-edit').click()
    const nameInput = page.getByTestId('portal-profile-name-input')
    await expect(nameInput).toBeVisible()
    // Change the city + click save
    await page.getByTestId('portal-profile-city-input').fill('Berlin')
    await page.getByTestId('portal-profile-save').click()
    // Success banner appears
    await expect(page.getByTestId('portal-profile-saved-ok')).toBeVisible({
      timeout: 5_000,
    })
    // Display mode shows the new city
    await expect(page.getByTestId('portal-profile-display-address')).toContainText(
      'Berlin',
    )
  })

  test('Frontend: invalid email in form shows error banner', async ({ page }) => {
    const token = sharedToken
    await page.goto(`/portal?token=${token}`)
    await expect(page.getByTestId('portal-customer-name')).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId('portal-profile-edit').click()
    await expect(page.getByTestId('portal-profile-email-input')).toBeVisible()
    await page.getByTestId('portal-profile-email-input').fill('not-an-email')
    await page.getByTestId('portal-profile-save').click()
    // Error banner (the one in the form, gated by kind === "err")
    await expect(page.getByTestId('portal-profile-save-error')).toBeVisible({
      timeout: 5_000,
    })
  })

  test('Mobile 375x667: profile section does not overflow', async ({ page }) => {
    const token = sharedToken
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/portal?token=${token}`)
    await expect(page.getByTestId('portal-customer-name')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId('portal-profile-card')).toBeVisible()
    await page.waitForTimeout(1500)
    const bodySw = await page.evaluate(() => document.body.scrollWidth)
    expect(bodySw).toBeLessThanOrEqual(376)
  })
})
