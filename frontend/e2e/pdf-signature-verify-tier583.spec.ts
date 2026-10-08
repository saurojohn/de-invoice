/**
 * Tier 583 — "Signatur prüfen" on the invoice page says what was checked.
 *
 * The check behind the button is a real one now (hash, signature, nothing
 * appended), and the result tells an intact signature made with this
 * company's certificate from one made with somebody else's.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the invoice's own signature verifies and is named as the company's", async ({ page, request }) => {
  const tag = `t583-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier583-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H,
    data: { vatId: "DE123456789", email: "info@t583.example", address: { street: "Hauptstr. 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: "Tier 583 Kunde", type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const invoice = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: "2026-09-01", items: [{ description: "Beratung", quantity: 1, unit: "Std", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect(invoice.id, `fixture invoice: ${JSON.stringify(invoice).slice(0, 200)}`).toBeTruthy()

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
  await page.goto(`/dashboard/invoices/${invoice.id}`)
  const button = page.getByTestId("pdf-signature-verify")
  await expect(button).toBeVisible({ timeout: 90_000 })
  await page.waitForLoadState("networkidle")
  await button.click()
  const result = page.getByTestId("pdf-signature-verify-result")
  await expect(result).toBeVisible({ timeout: 90_000 })
  await expect(result).toHaveAttribute("data-valid", "1")
  await expect(result).toHaveAttribute("data-trusted", "1")
  await expect(result).toContainText("unverändert")
  await expect(page.getByTestId("pdf-signature-signer")).toContainText("Zertifikat dieser Firma")
})
