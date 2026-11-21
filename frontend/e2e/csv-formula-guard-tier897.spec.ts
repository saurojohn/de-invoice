/**
 * Tier 897 — the CSV files the browser builds never carry a formula.
 *
 * Tier 857 guarded the files the server writes; the customer and product
 * lists, the aging report, the statistics and the cost-centre report are
 * built in the browser and wrote a customer called „=HYPERLINK(…)“ as it is
 * — Excel runs it as a formula. The cell now begins with an apostrophe, as
 * on the server. The UStVA CSV wrote „1234.56“ — a German Excel reads that
 * as text or a date; it writes „1234,56“ now (Tier 648).
 */
import { test, expect, type APIRequestContext, type Page, type Download } from "@playwright/test"
import { readFile } from "node:fs/promises"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const EVIL = '=HYPERLINK("https://example.invalid";"Klick")'

async function setup(page: Page, request: APIRequestContext, tag: string) {
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier897-e2e", companyName: `${tag} GmbH` },
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

test("customer list, aging report and UStVA CSV: no formula, decimal commas", async ({ page, request }) => {
  const { H, q } = await setup(page, request, `t897a-${Date.now()}`)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: EVIL, type: "business", address: { street: "Hafenstr. 3", postalCode: "28195", city: "Bremen", country: "DE" } },
  })).json()
  expect(customer.name).toBe(EVIL)
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: day(0), dueDate: day(14), items: [{ description: "Beratung", quantity: 1, unit: "Stk", unitPrice: 1234.56, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  // the cell as it must stand in the file: apostrophe, quoted for its „;“, quotes doubled
  const guarded = `"'${EVIL.replace(/"/g, '""')}"`

  // the customer list
  await page.goto("/dashboard/customers")
  const exportBtn = page.getByRole("button", { name: /CSV/ }).first()
  await expect(page.getByText(EVIL).first()).toBeVisible({ timeout: 60_000 })
  let download = page.waitForEvent("download", { timeout: 30_000 })
  await exportBtn.click()
  const customersCsv = await text(await download)
  const customerRow = customersCsv.split("\n").find((l) => l.includes("HYPERLINK"))!
  expect(customerRow.startsWith(guarded), customerRow).toBe(true)

  // the aging report
  await page.goto("/dashboard/reports/aging")
  await expect(page.getByText(EVIL).first()).toBeVisible({ timeout: 60_000 })
  download = page.waitForEvent("download", { timeout: 30_000 })
  await page.getByRole("button", { name: /CSV/ }).first().click()
  const agingCsv = await text(await download)
  const agingRow = agingCsv.split("\n").find((l) => l.includes("HYPERLINK"))!
  expect(agingRow.startsWith(guarded), agingRow).toBe(true)
  expect(agingRow).toContain("1469,13") // 1 234,56 + 19 % — a number stays a number

  // the UStVA CSV for the year: amounts with a decimal comma
  await page.goto(`/dashboard/accounting/ustva?year=${day(0).slice(0, 4)}&period=year`)
  const csvBtn = page.getByTestId("ustva-export-csv")
  await expect(csvBtn).toBeEnabled({ timeout: 60_000 })
  download = page.waitForEvent("download", { timeout: 30_000 })
  await csvBtn.click()
  const ustvaCsv = await text(await download)
  expect(ustvaCsv).toContain(";1234,56;234,57")
  expect(ustvaCsv).toContain(";Summe Umsatzsteuer;234,57;")
  expect(ustvaCsv).not.toMatch(/;-?\d+\.\d{2}(;|$)/m)
})

test("product list: a product name that begins like a formula", async ({ page, request }) => {
  const { H, q } = await setup(page, request, `t897b-${Date.now()}`)
  const res = await request.post(`${API}/api/v1/products?${q}`, {
    headers: H, data: { name: "@SUM(1+1)", type: "service", unit: "Std", basePrice: 49.9, vatRate: 0.19 },
  })
  expect(res.status(), await res.text()).toBeLessThan(300)
  await page.goto("/dashboard/products")
  await expect(page.getByText("@SUM(1+1)").first()).toBeVisible({ timeout: 60_000 })
  const download = page.waitForEvent("download", { timeout: 30_000 })
  await page.getByRole("button", { name: /CSV/ }).first().click()
  const csv = await text(await download)
  const row = csv.split("\n").find((l) => l.includes("SUM("))!
  expect(row.split(";")[1]).toBe("'@SUM(1+1)")
  expect(row.split(";")[5]).toBe("49,9") // a number stays a number
})
