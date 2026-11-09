import { test, expect } from "@playwright/test"
import { getTestEnv } from "./fixtures/test-env"

/**
 * Tier 821 — the operator invites someone to register a company of their own
 * while the registration is closed: the card shows the link, the link opens
 * the registration with the address filled in and fixed, and the new owner
 * lands in a company of their own. Reopened after the test, as the other
 * specs register companies.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"
const { userId, companyId } = getTestEnv()
const H = { "x-user-id": userId, "x-company-id": companyId }

test.afterAll(async ({ request }) => {
  await request.put(`${API}/api/v1/auth/registration`, { headers: H, data: { open: true } })
})

test("an invited company registers through the link, with the registration closed", async ({ page, browser, request }) => {
  expect((await request.put(`${API}/api/v1/auth/registration`, { headers: H, data: { open: false } })).status()).toBe(200)
  const email = `t821-${Date.now()}@example.test`

  // the operator invites on the user page
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId })
  // the card is the operator's: wait for /auth/me, so that a failure says what it answered
  const me = page.waitForResponse((r) => r.url().includes("/api/v1/auth/me") && r.request().method() === "GET", { timeout: 90_000 })
  await page.goto("/dashboard/settings/users")
  const meBody = await (await me).json()
  expect(meBody.operator, `GET /auth/me as the seed admin: ${JSON.stringify({ role: meBody.role, operator: meBody.operator, companyId: meBody.companyId })}`).toBe(true)
  await expect(page.getByTestId("registration-card")).toBeVisible({ timeout: 90_000 })
  await page.getByTestId("company-invite-email").fill(email)
  await page.getByTestId("company-invite-send").click()
  const link = page.getByTestId("company-invite-link")
  await expect(link).toBeVisible()
  const href = (await link.textContent()) || ""
  expect(href).toContain("/register?company-invite=")
  await expect(page.getByTestId("company-invite-list")).toContainText(email)

  // the invited person, in a browser of their own
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await p2.addInitScript(() => {
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  })
  await p2.goto(`/register?company-invite=${href.split("company-invite=")[1]}`)
  await expect(p2.getByTestId("company-invite-note")).toBeVisible({ timeout: 90_000 })
  const emailField = p2.locator("#email")
  await expect(emailField).toHaveValue(email)
  await expect(emailField).toHaveAttribute("readonly", "")
  await p2.getByLabel("Firmenname").fill("T821 Eigene Firma GmbH")
  await p2.locator("#password").fill("Tier821-e2e")
  await p2.getByRole("button", { name: "Konto erstellen" }).click()
  await expect(p2).toHaveURL(/\/dashboard/, { timeout: 30_000 })
  const own = await p2.evaluate(() => localStorage.getItem("companyId"))
  expect(own).toBeTruthy()
  expect(own).not.toBe(companyId)
  await other.close()

  // the card says the invitation was used
  await page.reload()
  await expect(page.getByTestId("company-invite-list")).toContainText("Firma angelegt", { timeout: 90_000 })
})
