import { test, expect, request as playwrightRequest } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 73: 2FA / TOTP UI end-to-end.
 *
 * The 2FA API is covered by backend e2e 24
 * (24-2fa-totp.sh — full setup → enable → verify →
 * recovery code → disable lifecycle). This file
 * exercises the React UI:
 *
 *   1. /dashboard/security page renders with
 *      "2FA ist nicht aktiv" when no 2FA.
 *   2. Click "2FA einrichten" → QR code + secret
 *      appear. We compute a valid TOTP code from
 *      the displayed secret, paste it, click
 *      "Bestätigen & aktivieren", the page shows
 *      the 10 recovery codes.
 *   3. "Verstanden" → status flips to
 *      "2FA ist aktiv".
 *   4. Click "2FA deaktivieren" → enter code
 *      (computed from the TOTP secret) → 2FA off.
 *
 * Why we compute TOTP ourselves: Playwright can't
 * easily scan a QR code. The secret is shown in
 * a <details> block on the page, so we extract it
 * from the DOM and run it through otplib (the same
 * code path the user's authenticator would have
 * produced). This matches what e2e 24 does.
 *
 * Cleanup: each test starts by ensuring 2FA is
 * disabled, so test order doesn't matter and no
 * dev-admin is left behind a TOTP code.
 */

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing — run backend e2e first`,
    )
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

async function injectAuth(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
  await page.context().addCookies([
    {
      name: "x-user-id",
      value: testTokens!.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens!.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
}

// Compute a TOTP code for a base32 secret using
// the same algorithm the user's authenticator
// would use. We hit the backend's otplib via a
// Node one-liner (mirrors what e2e 24 does).
async function totpForSecret(secret: string): Promise<string> {
  const { execSync } = await import("child_process")
  const cmd = `node -e "const { authenticator } = require('/Users/shledergmbh/Projects/de-invoice/backend/node_modules/otplib'); authenticator.options = { step: 30, window: 1, digits: 6 }; console.log(authenticator.generate('${secret}'));"`
  return execSync(cmd, { encoding: "utf-8" }).trim()
}

// Force-disable 2FA on the dev admin. We need the
// TOTP secret (or a recovery code) to disable — we
// read the secret from the DB and compute a code.
// This makes the test order-independent.
async function ensure2faOff() {
  const { execSync } = await import("child_process")
  const r = execSync(
    `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "SELECT \\"twoFactorSecret\\" FROM \\"User\\" WHERE id='${testTokens!.userId}';"`,
    { encoding: "utf-8" },
  ).trim()
  if (!r || r.length < 16) return // already off
  const code = await totpForSecret(r)
  const ctx = await playwrightRequest.newContext()
  await ctx.post("http://localhost:3001/api/v1/auth/2fa/disable", {
    headers: {
      "Content-Type": "application/json",
      "x-user-id": testTokens!.userId,
      "x-company-id": testTokens!.companyId,
    },
    data: { code },
  })
  await ctx.dispose()
}

test.describe("2FA / TOTP — /dashboard/security", () => {
  test.afterAll(async () => {
    // Don't leave the dev admin behind a code.
    await ensure2faOff()
  })

  test("renders '2FA ist nicht aktiv' on a fresh account", async ({ page }) => {
    await ensure2faOff()
    await injectAuth(page)
    await page.goto("/dashboard/security")
    await expect(
      page.getByTestId("two-factor-status-disabled"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("2FA ist nicht aktiv")).toBeVisible()
  })

  test("setup → enable → 10 recovery codes → status 'aktiv'", async ({
    page,
  }) => {
    await ensure2faOff()
    await injectAuth(page)
    await page.goto("/dashboard/security")
    await expect(
      page.getByTestId("two-factor-status-disabled"),
    ).toBeVisible({ timeout: 30_000 })

    // Click setup → QR appears.
    await page.getByTestId("two-factor-setup-start").click()
    await expect(page.getByTestId("two-factor-setup-card")).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId("two-factor-qr")).toBeVisible()

    // Pull the pending secret from the DOM (the
    // <details> block).
    const secret = (await page.getByTestId("two-factor-secret").textContent())?.trim() || ""
    expect(secret.length).toBeGreaterThanOrEqual(16)
    const code = await totpForSecret(secret)

    // Type the 6-digit code + verify.
    await page.getByTestId("two-factor-setup-code").fill(code)
    await page.getByTestId("two-factor-verify-enable").click()

    // Recovery codes card appears (10 of them).
    const codeItems = page
      .getByTestId("two-factor-recovery-codes-list")
      .locator("li")
    await expect(codeItems).toHaveCount(10, { timeout: 10_000 })

    // Click "Verstanden" → status flips to "2FA ist aktiv".
    await page.getByTestId("two-factor-recovery-continue").click()
    await expect(
      page.getByTestId("two-factor-status-enabled"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("2FA ist aktiv")).toBeVisible()
  })

  test("disable with valid TOTP code → 'nicht aktiv'", async ({ page }) => {
    // Previous test left 2FA enabled.
    const { execSync } = await import("child_process")
    const r = execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "SELECT \\"twoFactorSecret\\" FROM \\"User\\" WHERE id='${testTokens!.userId}';"`,
      { encoding: "utf-8" },
    ).trim()
    expect(r.length, "secret from DB (test 2 must have enabled 2FA)").toBeGreaterThanOrEqual(16)
    const code = await totpForSecret(r)

    await injectAuth(page)
    await page.goto("/dashboard/security")
    await expect(
      page.getByTestId("two-factor-status-enabled"),
    ).toBeVisible({ timeout: 30_000 })

    // Click "2FA deaktivieren" → disable form appears.
    await page.getByTestId("two-factor-disable-start").click()
    await expect(page.getByTestId("two-factor-disable-form")).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId("two-factor-disable-code").fill(code)
    await page.getByTestId("two-factor-disable-confirm").click()

    // Status flips back to "nicht aktiv".
    await expect(
      page.getByTestId("two-factor-status-disabled"),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("2FA ist nicht aktiv")).toBeVisible()
  })
})
