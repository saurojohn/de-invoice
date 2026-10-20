/**
 * Tier 709 — Berichte → Rechnungsstatistik: per month and per year, the
 * amounts invoiced, how many, and the quantities sold.
 * (The figures themselves: backend spec 430.)
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the invoice statistics: twelve months, the year, a month's quantities", async ({ page, request }) => {
  const tag = `t709-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier709-e2e", companyName: `${tag} GmbH` },
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
  const issue = async (issueDate: string, items: unknown[]) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, { headers: H, data: { customerId: customer.id, issueDate, items } })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  }
  await issue("2026-02-10", [{ description: "Beratung", quantity: 4, unit: "Std", unitPrice: 100, vatRate: 0.19 }])
  await issue("2026-05-20", [{ description: "Beratung", quantity: 6, unit: "Std", unitPrice: 100, vatRate: 0.19 }, { description: "Montage", quantity: 1, unit: "Pausch", unitPrice: 250, vatRate: 0.19 }])

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
  await page.goto("/dashboard/reports")
  await page.getByTestId("tab-invoice-stats").click({ timeout: 60_000 })
  await page.getByTestId("invoice-stats-year").fill("2026")

  // twelve months, the empty ones too; the year's total
  const months = page.getByTestId("invoice-stats-month")
  await expect(months).toHaveCount(12, { timeout: 60_000 })
  await expect(months.nth(1)).toContainText("400,00 €")
  await expect(months.nth(3)).toContainText("0,00 €")
  await expect(page.getByTestId("invoice-stats-months-total")).toContainText("1.250,00 €")
  await expect(page.getByTestId("invoice-stats-months-total")).toContainText("1.487,50 €")
  await expect(page.getByTestId("invoice-stats-year-row").filter({ hasText: "2026" })).toContainText("1.250,00 €")

  // the year's quantities: 10 Std Beratung
  const products = page.getByTestId("invoice-stats-product")
  await expect(products.filter({ hasText: "Beratung" })).toContainText("10")
  await expect(products.filter({ hasText: "Beratung" })).toContainText("1.000,00 €")

  // a month picked: its quantities only
  await page.locator('[data-testid="invoice-stats-month"][data-month="5"]').click()
  await expect(page.locator("body")).toContainText("Verkaufte Mengen Mai 2026")
  await expect(products.filter({ hasText: "Beratung" })).toContainText("600,00 €")
  await expect(products.filter({ hasText: "Montage" })).toContainText("250,00 €")
  await page.getByTestId("invoice-stats-whole-year").click()
  await expect(page.locator("body")).toContainText("Verkaufte Mengen 2026")

  // a phone: the tables scroll in their boxes, the page does not
  await page.setViewportSize({ width: 375, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(376)
})
