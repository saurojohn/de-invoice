/**
 * Tier 653 — an invoice in a foreign currency is shown in that currency.
 *
 * Before: the invoice list, the invoice page, the reminders page and the
 * customer's statement wrote "€" next to every amount — 2 380 USD overdue
 * stood there as "2.380,00 €", and the statement added dollars to euros.
 *
 * CI and the local test backend run with fixed rates (1 EUR = 1.0850 USD).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("USD on the invoice page, in the list, on the reminders page and in the statement", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t653-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier653-e2e", companyName: `${tag} GmbH` },
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

  // the invoice page
  await page.goto(`/dashboard/invoices/${usd.id}`)
  await expect(page.getByTestId("invoice-rate-note")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText("2380.00 USD").first()).toBeVisible()
  await expect(page.getByText("€2380.00")).toHaveCount(0)
  await expect(page.getByText("€2000.00")).toHaveCount(0)

  // the list
  await page.goto("/dashboard/invoices")
  await expect(page.getByText("2380.00 USD")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText("€1190.00")).toBeVisible()
  await expect(page.getByText("€2380.00")).toHaveCount(0)

  // the reminders page: each invoice in its own currency, the sum in euros
  await page.goto("/dashboard/reminders")
  await expect(page.getByTestId("reminder-amount").filter({ hasText: "2.380,00 USD" })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("reminder-amount").filter({ hasText: "1.190,00 €" })).toBeVisible()
  await expect(page.getByText("3.383,55 €", { exact: true })).toBeVisible()
  await expect(page.getByText("2.380,00 €")).toHaveCount(0)

  // the statement: EUR first, USD by choice
  await page.goto(`/dashboard/customers/${customer.id}/statement`)
  await page.getByTestId("statement-from-input").fill(day(90))
  await page.getByTestId("statement-generate-button").click()
  const pick = page.getByTestId("statement-currency")
  await expect(pick).toBeVisible({ timeout: 90_000 })
  await expect(pick).toHaveValue("EUR")
  await expect(page.locator("body")).toContainText("1.190,00 €")
  await expect(page.locator("body")).not.toContainText("3.570,00")
  await pick.selectOption("USD")
  await expect(page.locator("body")).toContainText("2.380,00 USD", { timeout: 30_000 })
  await expect(page.locator("body")).not.toContainText("1.190,00 €")
})
