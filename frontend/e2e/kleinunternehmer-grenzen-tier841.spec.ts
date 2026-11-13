/**
 * Tier 841 — a Kleinunternehmer over the § 19 limits is told so.
 *
 * Measured before: 30 000 € received last year (the limit is 25 000 €) and the
 * invoice form still wrote invoices without USt; no page said a word. Now the
 * dashboard and the invoice form show the notice (backend spec 535).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
test("a Kleinunternehmer over last year's 25 000 € sees it on the dashboard and the invoice form", async ({ page, request }) => {
  const tag = `t841-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier841-e2e", companyName: `${tag} KU` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H,
    data: {
      defaultVatMode: "kleinunternehmer", rechtsform: "Einzelunternehmen", besteuerungsart: "ist",
      // the issuer's details an invoice needs before it is sent (§ 14 Abs. 4 UStG)
      taxId: "12/345/67890", address: { street: "Teststr. 1", postalCode: "10115", city: "Berlin", country: "DE" },
    },
  })).status()).toBe(200)
  const cust = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: "Kunde", type: "business", address: { street: "Teststr. 9", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).json()
  const lastYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date())) - 1
  const day = `${lastYear}-06-02`
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: cust.id, issueDate: day, items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 30000, vatRate: 0 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  expect((await request.post(`${API}/api/v1/invoices/${inv.id}/payments?${q}`, {
    headers: H, data: { amount: 30000, paymentDate: day, paymentMethod: "bank_transfer" },
  })).status()).toBe(201)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
  await page.goto("/dashboard")
  const notice = page.getByTestId("kleinunternehmer-notice")
  await expect(notice).toBeVisible({ timeout: 90_000 })
  await expect(notice).toHaveAttribute("data-ended", "true")
  await expect(page.getByTestId("kleinunternehmer-vorjahrUeberschritten")).toContainText(`Gesamtumsatz ${lastYear}: 30.000,00 €, mehr als 25.000,00 €`)
  await expect(page.getByTestId("kleinunternehmer-vorjahrUeberschritten")).toContainText(`gilt ${lastYear + 1} nicht`)

  await page.goto("/dashboard/invoices/create")
  await expect(page.getByTestId("kleinunternehmer-notice")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("kleinunternehmer-vorjahrUeberschritten")).toBeVisible()
})
