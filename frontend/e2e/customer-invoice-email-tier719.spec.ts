/**
 * Tier 719 — the customer form has „E-Mail für Rechnungen“; the invoice's
 * „Per E-Mail senden“ starts with that address (backend spec 436: where the
 * letters go).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the address for invoices: entered on the customer, used to send", async ({ page, request }) => {
  const tag = `t719-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier719-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H,
    data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const created = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" }, contact: { email: "info@kunde.example.test" } },
  })).json()
  const contact = async () => (await (await request.get(`${API}/api/v1/customers/${created.id}?${q}`, { headers: H })).json()).contact
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: created.id, issueDate: "2026-10-01", items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-20T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/customers")
  await page.getByTestId("customer-edit-button").first().click({ timeout: 60_000 })
  const field = page.getByTestId("customer-invoice-email")
  await expect(field).toHaveValue("")
  await expect(page.getByLabel("E-Mail für Rechnungen")).toBeVisible()
  await field.fill("buchhaltung@kunde.example.test")
  await page.locator('form button[type="submit"]').click()
  await expect(field).toBeHidden({ timeout: 30_000 })
  const stored = await contact()
  expect(stored.invoiceEmail).toBe("buchhaltung@kunde.example.test")
  expect(stored.email).toBe("info@kunde.example.test")

  // the invoice's send dialog starts with it
  await page.goto(`/dashboard/invoices/${inv.id}`)
  await page.getByRole("button", { name: "Per E-Mail senden" }).click({ timeout: 60_000 })
  await expect(page.getByTestId("invoice-email-to")).toHaveValue("buchhaltung@kunde.example.test")
})
