/**
 * Tier 861 — a company can require its administrators to sign in with 2FA.
 *
 * With the rule on, an administrator without 2FA is sent from any page to the
 * security page, which says why; the switch is there for administrators, and
 * cannot be turned off before the administrator has 2FA.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext) {
  const tag = `t861-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier861-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  return { userId, companyId }
}

test("with the rule on, an administrator without 2FA lands on the security page, which says why", async ({ page, request }) => {
  test.setTimeout(120_000)
  const { userId, companyId } = await signIn(page, request)
  const headers = { "x-user-id": userId, "x-company-id": companyId }

  // off (the default outside production): the switch is shown, unticked
  await page.goto("/dashboard/security")
  await expect(page.getByTestId("admin-2fa-policy-card")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("admin-2fa-policy-toggle")).not.toBeChecked()
  await expect(page.getByTestId("two-factor-required-banner")).toHaveCount(0)

  // the administrator turns it on
  // a controlled checkbox: it turns when the server has saved it
  await page.getByTestId("admin-2fa-policy-toggle").click()
  await expect(page.getByTestId("admin-2fa-policy-toggle")).toBeChecked()
  const policy = await (await request.get(`${API}/api/v1/auth/2fa/policy`, { headers })).json()
  expect(policy).toEqual({ requireAdmin2fa: true, source: "setting" })

  // any other page sends them back here
  await page.goto("/dashboard/invoices")
  await page.waitForURL(/\/dashboard\/security\?required=1/, { timeout: 60_000 })
  await expect(page.getByTestId("two-factor-required-banner")).toBeVisible()
  // …and the rule cannot be turned off before they have 2FA
  await expect(page.getByTestId("admin-2fa-policy-toggle")).toBeChecked()
  await expect(page.getByTestId("admin-2fa-policy-toggle")).toBeDisabled()

  // leave the company as it was for nothing else (its own company)
  expect((await request.get(`${API}/api/v1/customers?companyId=${companyId}`, { headers })).status()).toBe(403)
})
