/**
 * Tier 722 — the aging report writes euros as a German page does
 * („1.190,00 €“, it wrote „€ 1.190,00“) and is titled in German.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the aging report: 1.190,00 € in the 90+ column, a German title", async ({ page, request }) => {
  const tag = `t722-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier722-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10)
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: day(130), dueDate: day(110), items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

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
  await page.goto("/dashboard/reports/aging")
  await expect(page.locator("h1")).toHaveText("Altersstruktur der offenen Posten", { timeout: 60_000 })
  const body = page.locator("main, body").first()
  await expect(body).toContainText(/1\.190,00\s€/)
  await expect(body).not.toContainText(/€\s1\.190,00/)
  await expect(body).not.toContainText("Aging Report")
})
