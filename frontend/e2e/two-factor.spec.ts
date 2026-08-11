import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execSync } from 'child_process'

/**
 * Tier 168a rewrite — 2FA / TOTP UI end-to-end.
 *
 * The 2FA API is covered by the backend
 * e2e (24-2fa-totp.sh — full setup →
 * enable → verify → recovery code →
 * disable lifecycle). This file exercises
 * the React UI on /dashboard/security.
 *
 * The original Tier 73 spec read its
 * auth tokens from a stale file at
 * `/tmp/cashbook-e2e-auth.env` (the
 * project was called "cashbook" before
 * the rebrand to "de-invoice"). That file
 * hasn't existed for years, so the spec
 * threw ENOENT in beforeAll() and the 3
 * tests silently no-op'd.
 *
 * Tier 168a replaces the spec with the
 * modern pattern (inlined constants,
 * contextWithAuth helper, hardcoded SH
 * Leder seed user id) that all Tier 100+
 * specs use.
 *
 * Tests:
 *   1. /dashboard/security renders with
 *      "2FA ist nicht aktiv" when 2FA off
 *   2. setup → enable → 10 recovery codes
 *      → status "aktiv"
 *   3. disable with valid TOTP code →
 *      status "nicht aktiv"
 *
 * Cleanup: every test starts by
 * force-disabling 2FA (so test order
 * doesn't matter and the dev admin is
 * never left behind a TOTP code).
 */

const COMPANY_ID = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const USER_ID = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const API = 'http://localhost:3001'

const ADMIN_HEADERS = {
  'x-user-id': USER_ID,
  'x-company-id': COMPANY_ID,
}

// Set cookies + localStorage so the
// dashboard route doesn't redirect to
// /login (Tier 100+ pattern).
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
      if (!localStorage.getItem('userId')) {
        localStorage.setItem('userId', userId)
        localStorage.setItem('companyId', companyId)
      }
    },
    { userId: USER_ID, companyId: COMPANY_ID },
  )
}

// Compute a TOTP code for a base32 secret
// using the same algorithm the user's
// authenticator would use. We hit the
// backend's otplib via a Node one-liner
// (mirrors what e2e 24 does).
function totpForSecret(secret: string): string {
  const cmd = `node -e "const { authenticator } = require('/Users/shledergmbh/Projects/de-invoice/backend/node_modules/otplib'); authenticator.options = { step: 30, window: 1, digits: 6 }; console.log(authenticator.generate('${secret}'));"`
  return execSync(cmd, { encoding: 'utf-8' }).trim()
}

// Read the TOTP secret from the DB
// (or null if 2FA is not enabled).
function readTwoFactorSecret(): string | null {
  const r = execSync(
    `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "SELECT \\"twoFactorSecret\\" FROM \\"User\\" WHERE id='${USER_ID}';"`,
    { encoding: 'utf-8' },
  ).trim()
  return r && r.length >= 16 ? r : null
}

// Force-disable 2FA on the dev admin. We
// need the TOTP secret (or a recovery
// code) to disable — we read the secret
// from the DB and compute a fresh code.
// This makes the test order-independent.
async function ensure2faOff() {
  const secret = readTwoFactorSecret()
  if (!secret) return // already off
  const code = totpForSecret(secret)
  const ctx = await playwrightRequest.newContext({
    extraHTTPHeaders: ADMIN_HEADERS,
  })
  await ctx.post(`${API}/api/v1/auth/2fa/disable`, {
    data: { code },
  })
  await ctx.dispose()
}

test.describe('Tier 168a — 2FA / TOTP /dashboard/security', () => {
  test.afterAll(async () => {
    // Don't leave the dev admin behind
    // a code.
    await ensure2faOff()
  })

  test("renders '2FA ist nicht aktiv' on a fresh account", async ({
    page,
  }) => {
    await ensure2faOff()
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto('/dashboard/security', { waitUntil: 'domcontentloaded' })
    await expect(
      page.getByTestId('two-factor-status-disabled'),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('2FA ist nicht aktiv')).toBeVisible()
  })

  test('setup → enable → 10 recovery codes → status aktiv', async ({
    page,
  }) => {
    await ensure2faOff()
    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto('/dashboard/security', { waitUntil: 'domcontentloaded' })
    await expect(
      page.getByTestId('two-factor-status-disabled'),
    ).toBeVisible({ timeout: 30_000 })

    // Click setup → QR appears.
    await page.getByTestId('two-factor-setup-start').click()
    await expect(page.getByTestId('two-factor-setup-card')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId('two-factor-qr')).toBeVisible()

    // Pull the pending secret from the
    // DOM (the <details> block).
    const secret =
      (
        await page.getByTestId('two-factor-secret').textContent()
      )?.trim() || ''
    expect(secret.length).toBeGreaterThanOrEqual(16)
    const code = totpForSecret(secret)

    // Type the 6-digit code + verify.
    await page.getByTestId('two-factor-setup-code').fill(code)
    await page.getByTestId('two-factor-verify-enable').click()

    // Recovery codes card appears (10
    // of them).
    const codeItems = page
      .getByTestId('two-factor-recovery-codes-list')
      .locator('li')
    await expect(codeItems).toHaveCount(10, { timeout: 10_000 })

    // Click "Verstanden" → status flips
    // to "2FA ist aktiv".
    await page.getByTestId('two-factor-recovery-continue').click()
    await expect(
      page.getByTestId('two-factor-status-enabled'),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('2FA ist aktiv')).toBeVisible()
  })

  test('disable with valid TOTP code → nicht aktiv', async ({ page }) => {
    // Previous test left 2FA enabled.
    const secret = readTwoFactorSecret()
    expect(
      secret?.length ?? 0,
      'secret from DB (test 2 must have enabled 2FA)',
    ).toBeGreaterThanOrEqual(16)
    const code = totpForSecret(secret!)

    await contextWithAuth(page)
    page.setDefaultTimeout(90_000)
    await page.goto('/dashboard/security', { waitUntil: 'domcontentloaded' })
    await expect(
      page.getByTestId('two-factor-status-enabled'),
    ).toBeVisible({ timeout: 30_000 })

    // Click "2FA deaktivieren" → disable
    // form appears.
    await page.getByTestId('two-factor-disable-start').click()
    await expect(page.getByTestId('two-factor-disable-form')).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId('two-factor-disable-code').fill(code)
    await page.getByTestId('two-factor-disable-confirm').click()

    // Status flips back to "nicht aktiv".
    await expect(
      page.getByTestId('two-factor-status-disabled'),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('2FA ist nicht aktiv')).toBeVisible()
  })
})
