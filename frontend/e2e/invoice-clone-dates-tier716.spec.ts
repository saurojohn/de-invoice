/**
 * Tier 716 — „Als Entwurf kopieren“: the copy is a new supply, dated today.
 *
 * The form took over the source's Leistungsdatum and Leistungszeitraum: a
 * March invoice copied in October stated March (§ 14 Abs. 4 Nr. 6 UStG asks
 * for the date of this supply). Now the copy starts as a new invoice does —
 * Leistungsdatum today, no Leistungszeitraum — with the source's lines.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a copied invoice is dated today: issue date, Leistungsdatum, no old service period", async ({ page, request }) => {
  const tag = `t716-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier716-e2e", companyName: `${tag} GmbH` },
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
  const source = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: {
      customerId: customer.id, issueDate: "2026-03-31", deliveryDate: "2026-03-31",
      servicePeriodStart: "2026-03-01", servicePeriodEnd: "2026-03-31",
      items: [{ description: "Wartung März", quantity: 1, unit: "Pausch", unitPrice: 250, vatRate: 0.19 }],
    },
  })).json()
  expect(source.id).toBeTruthy()

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
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
  await page.goto(`/dashboard/invoices/create?cloneFrom=${source.id}`)
  // the source's lines are taken over…
  await expect(page.locator('input[value="Wartung März"]').first()).toBeVisible({ timeout: 60_000 })
  // …its dates are not
  await expect(page.getByTestId("invoice-issue-date")).toHaveValue(today)
  await expect(page.getByTestId("invoice-delivery-date")).toHaveValue(today)
  await expect(page.getByTestId("service-period-start")).toHaveValue("")
  await expect(page.getByTestId("service-period-end")).toHaveValue("")
})
