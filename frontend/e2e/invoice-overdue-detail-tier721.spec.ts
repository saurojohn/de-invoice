/**
 * Tier 721 — the invoice page: „N Tage überfällig“ under the due date while
 * money is open; „Mahnung senden“ from the day after the due date.
 *
 * The button compared the due date (midnight UTC) with the clock: on the due
 * day itself it showed, and the send was refused („noch nicht überfällig“).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("past due: the days and the Mahnung button; due today: neither", async ({ page, request }) => {
  const tag = `t721-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier721-e2e", companyName: `${tag} GmbH` },
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
  const berlin = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d)
  const today = berlin(new Date())
  const daysAgo = (n: number) => berlin(new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000))
  const issue = async (issueDate: string, dueDate: string) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H, data: { customerId: customer.id, issueDate, dueDate, items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
    })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
    return inv.id as string
  }
  const late = await issue(daysAgo(40), daysAgo(10))
  expect((await request.post(`${API}/api/v1/invoices/${late}/payments?${q}`, {
    headers: H, data: { amount: 19, paymentDate: daysAgo(5), paymentMethod: "bank_transfer" },
  })).status()).toBe(201)
  const dueToday = await issue(daysAgo(30), today)

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
  await page.goto(`/dashboard/invoices/${late}`)
  await expect(page.getByTestId("invoice-overdue-days")).toHaveText("10 Tage überfällig", { timeout: 60_000 })
  await expect(page.getByTestId("send-mahnung-button")).toBeVisible()

  await page.goto(`/dashboard/invoices/${dueToday}`)
  await expect(page.getByTestId("invoice-due-date")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("invoice-overdue-days")).toHaveCount(0)
  await expect(page.getByTestId("send-mahnung-button")).toHaveCount(0) // (it showed on the due day)
})
