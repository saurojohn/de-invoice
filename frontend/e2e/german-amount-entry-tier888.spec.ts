/**
 * Tier 888 — an amount typed as on a German screen: „1.500,00“.
 *
 * The text fields turned the first comma into a point and parsed the rest:
 * `parseFloat("1.500.00")` is 1.5 — a credit adjustment of 1 500 € was
 * booked as 1,50 €.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("customer credit: „1.500,00“ is 1 500 €", async ({ page, request }) => {
  const tag = `t888-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier888-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Guthaben ${tag} GmbH`, type: "business", address: { street: "Weg 1", postalCode: "50667", city: "Köln", country: "DE" } },
  })).json()

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-11-20T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto(`/dashboard/customers/${customer.id}/credit`)
  await page.getByTestId("credit-adjust-button").click({ timeout: 60_000 })
  await page.getByTestId("credit-adjust-amount").fill("1.500,00")
  await page.getByTestId("credit-adjust-description").fill("Anzahlung aus Altsystem")
  const saved = page.waitForResponse((r) => r.url().includes("/credit-adjust") && r.request().method() === "POST")
  await page.getByTestId("credit-adjust-form").locator("button[type=submit]").click()
  expect((await saved).status()).toBeLessThan(300)

  const balance = await (await request.get(`${API}/api/v1/customers/${customer.id}/credit-balance?${q}`, { headers: H })).json()
  expect(Number(balance.balance)).toBe(1500)
})
