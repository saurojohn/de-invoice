/**
 * Tier 720 — the customer page with an invoice in USD: the open balance in
 * euros, the invoice tab in the invoice's currency, with what is open.
 *
 * The balance added 2 380 USD as 2 380 € (3.570,00 € with a 1 190 € invoice —
 * 3.383,55 € at the booked rate); the tab wrote „2.380,00 €“. The CI run and
 * the local test backend use fixed rates (1 EUR = 1.0850 USD).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a customer's USD invoice: the balance in euros, the tab in dollars", async ({ page, request }) => {
  const tag = `t720-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier720-e2e", companyName: `${tag} GmbH` },
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
  const make = async (currency: string, unitPrice: number) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H,
      data: { customerId: customer.id, issueDate: day(60), dueDate: day(46), currency, items: [{ description: "Lederwaren", quantity: 1, unit: "Stk", unitPrice, vatRate: 0.19 }] },
    })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).ok()).toBeTruthy()
    return inv
  }
  const usd = await make("USD", 2000) // 2 380 USD = 2 193,55 €
  await make("EUR", 1000)             // 1 190 €
  // the balance from the API: in euros
  const summary = await (await request.get(`${API}/api/v1/customers/${customer.id}/summary?${q}`, { headers: H })).json()
  expect(summary.stats.openBalance).toBeCloseTo(3383.55, 2) // was 3570

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
  await page.goto(`/dashboard/customers/${customer.id}`)
  await expect(page.getByTestId("kpi-open-balance")).toHaveText(/3\.383,55\s€/, { timeout: 60_000 })
  const usdRow = page.locator("tr").filter({ hasText: usd.invoiceNumber })
  await expect(usdRow.getByTestId("customer-invoice-total")).toHaveText(/^2\.380,00\sUSD$/)
  await expect(usdRow.getByTestId("customer-invoice-open")).toHaveText(/^2\.380,00\sUSD$/)
})
