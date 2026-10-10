/**
 * Tier 638 — the reminders page shows what is open.
 *
 * An overdue invoice over 2 380 € of which 380 € were paid stood in the list
 * with 2 380 €, and in the page's sum with 2 380 €. The template editor
 * offered no token for the open amount or the invoice's date.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("an overdue invoice with a part payment: the open amount, and the total next to it", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t638-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier638-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { taxId: "12/345/67890", address: { street: "Teststr. 1", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).ok()).toBeTruthy()
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10)
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: day(54), dueDate: day(40), items: [{ description: "Beratung", quantity: 1, unit: "Std", unitPrice: 2000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).ok()).toBeTruthy()
  expect((await request.post(`${API}/api/v1/invoices/${inv.id}/payments?${q}`, { headers: H, data: { amount: 380, paymentDate: day(30), paymentMethod: "bank_transfer" } })).ok()).toBeTruthy()

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )

  await page.goto("/dashboard/reminders")
  await expect(page.getByTestId("reminder-amount").first()).toHaveText("2.000,00 €", { timeout: 60_000 })
  await expect(page.getByTestId("reminder-invoice-total").first()).toHaveText("von 2.380,00 € Rechnungsbetrag")
  // the page's sum of what is overdue is the second place that says it
  await expect(page.getByText("2.000,00 €", { exact: true })).toHaveCount(2)
  await expect(page.getByText("2.380,00 €", { exact: true })).toHaveCount(0)

  // Tier 647: the three levels by the names the e-mail and the letter use
  for (const name of ["Zahlungserinnerung", "1. Mahnung", "Letzte Mahnung"]) {
    await expect(page.getByRole("option", { name, exact: true }).first(), name).toBeAttached()
  }
  await expect(page.locator("body")).not.toContainText("2. Mahnung")
  await expect(page.locator("body")).not.toContainText("1. Erinnerung")

  // the editor offers the tokens the default texts use
  await page.goto("/dashboard/mahnungen/templates")
  for (const key of ["openAmount", "invoiceTotal", "issueDateFormatted", "dueDateFormatted", "totalAmount"]) {
    await expect(page.getByTestId(`mahnung-templates-placeholder-${key}`), key).toBeVisible({ timeout: 60_000 })
  }
  await expect(page.getByTestId("mahnung-templates-body")).toHaveValue(/noch \{\{openAmount\}\} EUR offen sind/)
})
