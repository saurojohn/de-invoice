/**
 * Tier 729 — the invoice form's „Zahlungsart“ is kept: chosen on the form,
 * shown on the invoice's page, opened again in the editor.
 * It was dropped by the service; every invoice was a transfer.
 * Tier 729b — „Ihre Bestellnummer“ and „Ihre Referenz“: there were no fields.
 * (The PDF and the e-invoices: backend specs 444, 445.)
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("payment method and the customer references: entered, kept, shown", async ({ page, request }) => {
  const tag = `t729-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier729-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  expect((await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Barkunde ${tag} GmbH`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-23T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/invoices/create")
  const search = page.getByTestId("invoice-customer-search")
  await expect(search).toBeVisible({ timeout: 60_000 })
  await search.fill("Barkunde")
  await page.getByTestId("invoice-customer-option").first().click()
  await page.getByTestId("item-description").first().fill("Ledertasche")
  await page.getByTestId("item-quantity").first().fill("1")
  await page.getByTestId("item-unit-price").first().fill("100")
  await page.getByTestId("invoice-payment-method").selectOption("cash")
  await page.getByTestId("invoice-order-reference").fill("4500012345")
  await page.getByTestId("invoice-buyer-reference").fill("Projekt Nord")
  await page.getByRole("button", { name: "Rechnung erstellen", exact: true }).click()
  await page.waitForURL(/\/dashboard\/invoices(\?|$)/, { timeout: 30_000 })

  // kept — and shown on the invoice's page
  const list = await (await request.get(`${API}/api/v1/invoices?${q}`, { headers: H })).json()
  const rows = Array.isArray(list) ? list : list.data
  expect(rows.length).toBe(1)
  const id: string = rows[0].id
  const saved = await (await request.get(`${API}/api/v1/invoices/${id}?${q}`, { headers: H })).json()
  expect(saved.paymentMethod).toBe("cash")
  expect([saved.orderReference, saved.buyerReference]).toEqual(["4500012345", "Projekt Nord"])
  await page.goto(`/dashboard/invoices/${id}`)
  await expect(page.getByTestId("invoice-payment-method")).toContainText("Barzahlung", { timeout: 60_000 })
  await expect(page.getByTestId("invoice-order-reference")).toContainText("4500012345")
  await expect(page.getByTestId("invoice-buyer-reference")).toContainText("Projekt Nord")

  // the editor opens with it
  await page.goto(`/dashboard/invoices/create?id=${id}`)
  await expect(page.getByTestId("invoice-payment-method")).toHaveValue("cash", { timeout: 60_000 })
  await expect(page.getByTestId("invoice-order-reference")).toHaveValue("4500012345")
})
