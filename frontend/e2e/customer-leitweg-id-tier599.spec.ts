/**
 * Tier 599 — the customer form has a field for the Leitweg-ID.
 *
 * A public authority's Leitweg-ID is XRechnung's buyer reference. No form
 * could enter it, and — because the form sends the whole address — an edit
 * would have dropped one stored by other means.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the Leitweg-ID of a customer is shown, changed and kept", async ({ page, request }) => {
  const tag = `t599-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier599-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const created = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Bundesamt`, type: "business", address: { street: "Behördenstr. 1", postalCode: "53111", city: "Bonn", country: "DE", leitwegId: "991-12345-73" } },
  })).json()
  expect(created.id, "fixture: a customer with a Leitweg-ID").toBeTruthy()
  const stored = async () => (await (await request.get(`${API}/api/v1/customers/${created.id}?${q}`, { headers: H })).json()).address

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
  await page.goto("/dashboard/customers")
  await page.getByTestId("customer-edit-button").first().click({ timeout: 60_000 })
  const field = page.getByTestId("customer-leitweg-id")
  await expect(field).toHaveValue("991-12345-73")

  // saving without touching it keeps it (the form sends the whole address)
  await page.locator('form button[type="submit"]').click()
  await expect(field).toBeHidden({ timeout: 30_000 })
  expect((await stored()).leitwegId).toBe("991-12345-73")

  // a wrong one is refused with the reason, a right one is saved
  await page.getByTestId("customer-edit-button").first().click()
  await field.fill("Bundesamt Bonn")
  await page.locator('form button[type="submit"]').click()
  await expect(page.locator("body")).toContainText("Leitweg-ID: bitte im Format der Behörde", { timeout: 30_000 })
  expect((await stored()).leitwegId).toBe("991-12345-73")
  await field.fill("04011000-1234512345-06")
  await page.locator('form button[type="submit"]').click()
  await expect(field).toBeHidden({ timeout: 30_000 })
  expect((await stored()).leitwegId).toBe("04011000-1234512345-06")
})
