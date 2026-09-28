/**
 * Tier 457 — Ist-Versteuerung (§ 20 UStG).
 *
 * Measured before: there was no such setting; the UStVA declared output tax
 * by invoice date only. Now the settings page offers "Ist-Versteuerung", and
 * the UStVA says so and counts an invoice in the month it is paid.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("Ist-Versteuerung is chosen in the settings and moves the output tax to the payment month", async ({ page, request }) => {
  const tag = `t457-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier457-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const cust = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business" },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: {
      customerId: cust.id, issueDate: "2026-03-10",
      items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }],
    },
  })).json()
  await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })
  expect((await request.post(`${API}/api/v1/invoices/${inv.id}/payments?${q}`, {
    headers: H, data: { amount: 1190, paymentDate: "2026-04-05", paymentMethod: "bank_transfer" },
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

  await page.goto("/dashboard/settings")
  const select = page.getByTestId("settings-besteuerungsart")
  await expect(select).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  await expect(select).toHaveValue("soll")
  await select.selectOption("ist")
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/companies/${companyId}`) && r.request().method() === "PUT",
    { timeout: 60_000 },
  )
  await page.getByTestId("settings-save").click()
  expect((await saved).status()).toBe(200)

  const company = await (await request.get(`${API}/api/v1/companies/${companyId}?${q}`, { headers: H })).json()
  expect(company.besteuerungsart).toBe("ist")

  await page.goto("/dashboard/accounting/ustva?year=2026&month=4")
  await expect(page.getByTestId("ustva-ist")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("ustva-ist")).toContainText("§ 20 UStG")
  const april = await (await request.get(`${API}/api/v1/ustva/compute?${q}&year=2026&month=4`, { headers: H })).json()
  expect(april.salesByRate.find((r: any) => Math.abs(r.rate - 0.19) < 1e-6)?.vat).toBe(190)
})
