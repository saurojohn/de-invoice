/**
 * Tier 714 — the status of an issued invoice offers „Entwurf“ only on its
 * issue day while nothing is booked on it (the API refuses it otherwise,
 * backend spec 434).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("an issued invoice of an earlier day offers no „Entwurf“; today's untouched one does", async ({ page, request }) => {
  const tag = `t714-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier714-e2e", companyName: `${tag} GmbH` },
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
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
  const issue = async (issueDate: string) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
      headers: H,
      data: { customerId: customer.id, issueDate, dueDate: "2026-12-31", items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
    })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
    return inv.id as string
  }
  const august = await issue("2026-08-01")
  const fresh = await issue(today)

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
  const options = async () =>
    page.getByTestId("invoice-status-select").locator("option").evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))

  await page.goto(`/dashboard/invoices/${august}`)
  await expect(page.getByTestId("invoice-status-select")).toBeVisible({ timeout: 60_000 })
  expect(await options()).not.toContain("draft")
  expect(await options()).toContain("sent")

  await page.goto(`/dashboard/invoices/${fresh}`)
  await expect(page.getByTestId("invoice-status-select")).toBeVisible({ timeout: 60_000 })
  expect(await options()).toContain("draft")
})
