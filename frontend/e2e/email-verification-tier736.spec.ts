/**
 * Tier 736 — the account's e-mail address, confirmed by the mailed link.
 *
 * A fresh account sees the notice on the dashboard (until then the
 * installation's mail server sends nothing for the company), can have the
 * link sent again, and the link's page confirms the address; afterwards the
 * notice is gone. Outside production the backend logs the link (as the reset
 * link) — CI and the local harness both write it to /tmp/backend.log.
 * (The rules: backend spec 456.)
 */
import { test, expect, type Page } from "@playwright/test"
import * as fs from "fs"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const LOG = "/tmp/backend.log"

function lastVerifyToken(): string {
  const all = fs.readFileSync(LOG, "utf8").match(/verify-email\?token=[0-9a-f]{64}/g) || []
  return (all[all.length - 1] || "").split("=")[1] || ""
}

async function as(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-29T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("the dashboard asks to confirm the address; the mailed link confirms it", async ({ page, request }) => {
  test.skip(!fs.existsSync(LOG), `no backend log at ${LOG}`)
  const tag = `t736-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier736-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  expect(reg.user.emailVerified).toBe(false)
  const first = lastVerifyToken()
  expect(first).toHaveLength(64)

  await as(page, userId, companyId)
  await page.goto("/dashboard")
  const notice = page.getByTestId("email-verification-notice")
  await expect(notice).toBeVisible({ timeout: 90_000 })
  await expect(notice).toContainText(`${tag}@example.test`)
  await expect(notice).toContainText("keine E-Mails für Ihre Firma")

  // send it again: a new link, the old one replaced
  await page.waitForFunction(() => document.readyState === "complete")
  await page.getByTestId("email-verification-resend").click()
  await expect(page.getByTestId("email-verification-result")).toContainText("Ein neuer Bestätigungslink", { timeout: 30_000 })
  const second = lastVerifyToken()
  expect(second).toHaveLength(64)
  expect(second).not.toBe(first)

  await page.goto(`/verify-email?token=${first}`)
  await expect(page.getByTestId("verify-email-result")).toContainText("ungültig oder abgelaufen", { timeout: 60_000 })

  await page.goto(`/verify-email?token=${second}`)
  await expect(page.getByTestId("verify-email-result")).toContainText(`Die E-Mail-Adresse ${tag}@example.test ist bestätigt`, { timeout: 60_000 })

  await page.goto("/dashboard")
  await expect(page.getByTestId("dashboard-revenue-ytd").or(page.getByRole("heading", { level: 1 })).first()).toBeVisible({ timeout: 90_000 })
  await page.waitForLoadState("networkidle")
  await expect(page.getByTestId("email-verification-notice")).toHaveCount(0)
})
