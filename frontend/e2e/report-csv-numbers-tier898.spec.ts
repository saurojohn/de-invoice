/**
 * Tier 898 — the VAT report and the customer report (Berichte) write numbers
 * a spreadsheet can add up. They wrote „1.234,56 €“ (with a non-breaking
 * space) and „19.0%“: text in a German Excel — and since Tier 897 a negative
 * amount „-50,00 €“ would have begun with an apostrophe. Now „1234,56“,
 * „19,0“ as Tier 648 has it for every CSV file.
 */
import { test, expect, type APIRequestContext, type Page, type Download } from "@playwright/test"
import { readFile } from "node:fs/promises"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function setup(page: Page, request: APIRequestContext, tag: string) {
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier898-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-11-20T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  return { H, q }
}

const text = async (d: Download) => (await readFile((await d.path())!, "utf8")).replace(/^\uFEFF/, "")

test("VAT report and customer report CSV: plain numbers with a decimal comma", async ({ page, request }) => {
  const { H, q } = await setup(page, request, `t898-${Date.now()}`)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: "Zahlenkunde 898 GmbH", type: "business", address: { street: "Hafenstr. 3", postalCode: "28195", city: "Bremen", country: "DE" } },
  })).json()
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: day(0), dueDate: day(14), items: [{ description: "Beratung", quantity: 1, unit: "Stk", unitPrice: 1234.56, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

  await page.goto("/dashboard/reports?tab=vat")
  let download = page.waitForEvent("download", { timeout: 30_000 })
  await page.getByRole("button", { name: "CSV Export" }).first().click({ timeout: 60_000 })
  const vatCsv = await text(await download)
  expect(vatCsv.split("\n")[0]).toBe("MwSt-Satz (%);Nettobetrag;MwSt-Betrag;Bruttobetrag;Anzahl Rechnungen")
  expect(vatCsv).toContain("19,0;1234,56;234,57;1469,13;1")
  expect(vatCsv).not.toContain("€")

  await page.goto("/dashboard/reports?tab=customers")
  download = page.waitForEvent("download", { timeout: 30_000 })
  await page.getByRole("button", { name: "CSV Export" }).first().click({ timeout: 60_000 })
  const customerCsv = await text(await download)
  const row = customerCsv.split("\n").find((l) => l.startsWith("Zahlenkunde 898 GmbH"))!
  expect(row, customerCsv).toMatch(/^Zahlenkunde 898 GmbH;1;1469,13;0,00;1469,13;0,00$/)
})
