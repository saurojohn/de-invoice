/**
 * Tier 723 — the invoice list states how many documents match, their sum and
 * what of it is open, in euros (a USD invoice at its booked rate), for the
 * whole filtered list — not only the page.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the list's line: 3 Dokumente · Summe 3.978,55 € · davon offen 3.383,55 €", async ({ page, request }) => {
  const tag = `t723-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier723-e2e", companyName: `${tag} GmbH` },
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
  const make = async (currency: string, unitPrice: number, paid = 0) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H,
      data: { customerId: customer.id, issueDate: day(60), dueDate: day(46), currency, items: [{ description: "Ware", quantity: 1, unit: "Stk", unitPrice, vatRate: 0.19 }] },
    })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).ok()).toBeTruthy()
    if (paid) {
      expect((await request.post(`${API}/api/v1/invoices/${inv.id}/payments?${q}`, {
        headers: H, data: { amount: paid, paymentDate: day(50), paymentMethod: "bank_transfer" },
      })).status()).toBe(201)
    }
  }
  await make("EUR", 1000)      // 1 190 € open
  await make("EUR", 500, 595)  // 595 €, paid
  await make("USD", 2000)      // 2 380 USD = 2 193,55 € (fixed test rate 1.0850), open

  const sums = (await (await request.get(`${API}/api/v1/invoices?${q}&pageSize=1`, { headers: H })).json()).sums
  expect(sums).toEqual({ totalEur: 3978.55, openEur: 3383.55 }) // of all three, with a page of one

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-21T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/invoices")
  await expect(page.getByTestId("invoices-sums")).toHaveText(/^3 Dokumente · Summe 3\.978,55\s€ · davon offen 3\.383,55\s€$/, { timeout: 60_000 })
})
