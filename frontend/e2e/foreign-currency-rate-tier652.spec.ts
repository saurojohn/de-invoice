/**
 * Tier 652 — a foreign-currency invoice says at which rate it was converted,
 * and the form takes a rate by hand.
 *
 * Before: the form offered seven currencies and no rate; the invoice page
 * showed "USD" and nothing about the euros it stands for in the books.
 *
 * CI and the local test backend run with fixed rates (USD 1.0850 for every
 * day, none for SEK).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the rate on the invoice page, and a rate by hand in the form", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t652-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier652-e2e", companyName: `${tag} GmbH` },
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
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
  const make = async (currency: string, extra: Record<string, unknown> = {}) =>
    request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H,
      data: { customerId: customer.id, issueDate: today, dueDate: "2099-12-31", currency, items: [{ description: "Lederwaren", quantity: 1, unit: "Stk", unitPrice: 10000, vatRate: 0.19 }], ...extra },
    })
  const usd = await (await make("USD")).json()
  expect((await make("SEK")).status()).toBe(400)
  const sek = await (await make("SEK", { exchangeRate: 11.1675 })).json()

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

  // the ECB's rate of the invoice's day
  await page.goto(`/dashboard/invoices/${usd.id}`)
  const note = page.getByTestId("invoice-rate-note")
  await expect(note).toBeVisible({ timeout: 90_000 })
  await expect(note).toContainText("1 EUR = 1,0850 USD")
  await expect(note).toContainText("EZB-Referenzkurs vom")
  await expect(note).toContainText("In Euro: 10.967,74 €")

  // a rate entered by hand
  await page.goto(`/dashboard/invoices/${sek.id}`)
  await expect(page.getByTestId("invoice-rate-note")).toContainText("1 EUR = 11,1675 SEK", { timeout: 90_000 })
  await expect(page.getByTestId("invoice-rate-note")).toContainText("von Hand eingetragen")
  await expect(page.getByTestId("invoice-rate-note")).toContainText("In Euro: 1.065,59 €")

  // the form: the draft's rate is there; emptied, the invoice goes back to
  // the ECB's — which has none for SEK, and the form says so
  await page.goto(`/dashboard/invoices/create?id=${sek.id}`)
  const rate = page.getByTestId("invoice-exchange-rate")
  await expect(rate).toHaveValue("11.1675", { timeout: 90_000 })
  await expect(page.getByLabel(/Umrechnungskurs \(1 EUR = … SEK\)/)).toBeVisible()
  await expect(page.getByText("Monatsdurchschnittskurs des BMF")).toBeVisible()
  await expect(page.getByTestId("invoice-currency")).toHaveValue("SEK")

  // a new invoice in EUR has no rate field; in USD it has
  await page.goto("/dashboard/invoices/create")
  await expect(page.getByTestId("invoice-currency")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("invoice-exchange-rate")).toHaveCount(0)
  await page.getByTestId("invoice-currency").selectOption("USD")
  await expect(page.getByTestId("invoice-exchange-rate")).toBeVisible()
  await expect(page.getByTestId("invoice-exchange-rate")).toHaveValue("")
})
