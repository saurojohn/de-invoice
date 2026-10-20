/**
 * Tier 713 — the invoice page: a credit note's settlement has no „Löschen“
 * (the API refuses it, backend spec 433), and the Ratenplan hint names what
 * is open — the amount the plan divides (it said „Diese Rechnung über
 * 1.190,00 €“ with 1.071,00 € open).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a credit note's settlement is kept; the plan hint names the open amount", async ({ page, request }) => {
  const tag = `t713-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier713-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  expect((await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: "2026-10-01", dueDate: "2026-11-30", items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  expect((await request.post(`${API}/api/v1/invoices/${inv.id}/credit-note?companyId=${companyId}`, { headers: H, data: { amount: 119, reason: "Preisnachlass" } })).status()).toBe(201)
  expect((await request.post(`${API}/api/v1/invoices/${inv.id}/payments?companyId=${companyId}`, {
    headers: H, data: { amount: 100, paymentDate: "2026-10-10", paymentMethod: "bank_transfer" },
  })).status()).toBe(201)

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
  await page.goto(`/dashboard/invoices/${inv.id}`)
  const rows = page.getByTestId("payment-row")
  await expect(rows).toHaveCount(2, { timeout: 60_000 })
  const settlement = rows.filter({ hasText: "CN " })
  await expect(settlement.getByTestId("payment-kept")).toHaveCount(1)
  await expect(settlement.getByTestId("payment-delete")).toHaveCount(0)
  await expect(rows.filter({ hasNotText: "CN " }).getByTestId("payment-delete")).toHaveCount(1)

  // 1 190 − 119 − 100 = 971 € open
  await expect(page.getByTestId("ratensplan-suggest-banner")).toContainText("Offen sind 971,00 €", { timeout: 30_000 })
})
