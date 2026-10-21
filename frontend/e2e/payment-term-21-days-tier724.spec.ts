/**
 * Tier 724 — a payment term outside 0 / 7 / 14 / 30 / 60 days is shown as
 * what it is; a German business without a USt-IdNr. is „Inland“.
 *
 * A customer with 21 days: the new invoice was due in 21 days, and its
 * „Zahlungsbedingungen“ showed „Sofort fällig“ (the list had no 21); the
 * customer form the same. The tax hint called the customer „Kunde in EU (DE)
 * ohne USt-ID — Standard-Versteuerung (B2C)“.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("21 days: shown on the invoice form and the customer form; the hint says Inland", async ({ page, request }) => {
  const tag = `t724-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier724-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  expect((await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Einundzwanzig ${tag} GmbH`, type: "business", paymentTerms: 21, address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-21T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/invoices/create")
  const search = page.getByTestId("invoice-customer-search")
  await expect(search).toBeVisible({ timeout: 60_000 })
  await search.fill("Einundzwanzig")
  await page.getByTestId("invoice-customer-option").first().click()
  const terms = page.getByTestId("invoice-payment-terms")
  await expect(terms).toHaveValue("21")
  expect(await terms.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex].text)).toBe("21 Tage")
  await expect(page.getByTestId("invoice-tax-treatment")).toContainText("Inland (DE) — Standard-Versteuerung", { timeout: 30_000 })
  await expect(page.getByTestId("invoice-tax-treatment")).not.toContainText("B2C")

  await page.goto("/dashboard/customers")
  await page.getByTestId("customer-edit-button").first().click({ timeout: 60_000 })
  const customerTerms = page.getByTestId("customer-payment-terms")
  await expect(customerTerms).toHaveValue("21")
  expect(await customerTerms.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex].text)).toBe("21 Tage")
})
