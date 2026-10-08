/**
 * Tier 595 — two things the page walk showed.
 *
 * - /dashboard/reminders wrote amounts as "€2110.50" and the overdue line as
 *   „Fällig seit: Überfällig seit“ (a label without its number).
 * - The UStVA page's Σ row under „Steuerpflichtige Umsätze“ added the two
 *   bases but showed the whole output VAT (including § 13b) as their tax.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the reminders page and the UStVA sum row", async ({ page, request }) => {
  const tag = `t595-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier595-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const issuer = await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { legalName: `${tag} GmbH`, vatId: "DE811907980", address: { street: "Hauptstr. 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })
  expect(issuer.ok(), "fixture: the issuer's details").toBeTruthy()
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  // an invoice of 2 000,00 + 380,00, issued 40 days ago with 14 days to pay → overdue
  const d = new Date(Date.now() - 40 * 86_400_000)
  const issue = d.toISOString().slice(0, 10)
  const due = new Date(d.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: issue, dueDate: due, items: [{ description: "Beratung", quantity: 1, unit: "Std", unitPrice: 2000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).ok()).toBeTruthy()
  // a § 13b expense in the same month: output VAT that is not in the sales table
  const exp = await (await request.post(`${API}/api/v1/ustva/expenses?${q}`, {
    headers: H, data: { description: "Software (13b)", invoiceDate: issue, netAmount: 1000, vatRate: 0.19, vatAmount: 0, grossAmount: 1000, isReverseCharge: true },
  }))
  expect(exp.ok(), "fixture: a § 13b expense").toBeTruthy()

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )

  await page.goto("/dashboard/reminders")
  await expect(page.getByTestId("reminder-amount").first()).toHaveText("2.380,00 €", { timeout: 60_000 })
  await expect(page.getByTestId("reminder-overdue-days").first()).toHaveText(/Überfällig seit: \d+ Tage/)
  await expect(page.locator("body")).not.toContainText("€2380")
  await expect(page.locator("body")).not.toContainText("Fällig seit: Überfällig seit")

  const [y, m] = [d.getFullYear(), d.getMonth() + 1]
  const kz = await (await request.get(`${API}/api/v1/ustva/compute?${q}&year=${y}&month=${m}`, { headers: H })).json()
  expect(kz.umsatzsteuer, "fixture: the month's output VAT is 380 + 190 (§ 13b)").toBe(570)
  await page.goto("/dashboard/accounting/ustva")
  await page.waitForLoadState("networkidle")
  // the page opens on the current period; choose the year so the invoice's month is included
  const sum = page.getByTestId("ustva-sales-vat-sum")
  await expect(sum).toBeVisible({ timeout: 60_000 })
  const shown = (await sum.innerText()).replace(/[^\d,]/g, "")
  const rows = await page.locator("table").first().locator("tbody tr td:last-child").allInnerTexts()
  const added = rows.map((t) => Number(t.replace(/[^\d,]/g, "").replace(",", "."))).reduce((a, b) => a + b, 0)
  expect(added, "the table shows the invoice's VAT (the page opens on the year)").toBeCloseTo(380, 2)
  expect(Number(shown.replace(",", ".")), "the Σ row is the sum of the rows above it").toBeCloseTo(added, 2)
  expect(Number(shown.replace(",", ".")), "…and not the whole output VAT of 570,00").not.toBeCloseTo(570, 2)
})
