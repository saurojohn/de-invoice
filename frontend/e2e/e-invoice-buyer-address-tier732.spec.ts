/**
 * Tier 732 — XRechnung 3.0 requires the buyer's electronic address (BT-49).
 * A customer without e-mail, VAT id or Leitweg-ID got an XRechnung that KoSIT
 * rejects (PEPPOL-EN16931-R010). The pages say so before: the customer form
 * at the e-mail for invoices, the invoice page at „XRechnung herunterladen“ —
 * and the download says what to enter instead of handing out an invalid file.
 * (The validators: backend spec 450.)
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a customer without an electronic address: told on the customer and on the invoice", async ({ page, request }) => {
  const tag = `t732-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier732-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", phone: "+49 30 1", email: "info@t732.example.test", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Ohne Adresse ${tag} GmbH`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: "2026-10-01", items: [{ description: "Beratung", quantity: 1, unit: "Std", unitPrice: 100, vatRate: 0.19 }] },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-28T00:00:00.000Z" }))
    },
    { userId, companyId },
  )

  // the invoice page: the hint at the button, the download says what to enter
  await page.goto(`/dashboard/invoices/${inv.id}`)
  await expect(page.getByTestId("xrechnung-needs-address")).toBeVisible({ timeout: 60_000 })
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/v1/invoices/${inv.id}/xrechnung?`)),
    page.getByTestId("invoice-download-xrechnung").click(),
  ])
  expect(res.status()).toBe(400)
  await expect(page.getByText(/E-Mail-Adresse für Rechnungen/).first()).toBeVisible()

  // the customer form: the hint at the e-mail for invoices, gone once there is one
  await page.goto("/dashboard/customers")
  await page.getByTestId("customer-edit-button").first().click({ timeout: 60_000 })
  const hint = page.getByTestId("customer-xrechnung-needs-address")
  await expect(hint).toBeVisible()
  await page.getByTestId("customer-invoice-email").fill("buchhaltung@ohne.example.test")
  await expect(hint).toHaveCount(0)
})
