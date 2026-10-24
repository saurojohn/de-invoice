/**
 * Tier 731 — printing from the pages: „Drucken“ on the invoice (there was only
 * „PDF herunterladen“) and „Sammeldruck“ for the chosen invoices in the list
 * (there was only a ZIP). The PDF's layout: backend spec 448.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function as(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-24T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  // the PDF opens in a new tab for the print dialog — recorded here
  await page.addInitScript(() => {
    const w = window as unknown as { open: (u?: string | URL) => null; __opened?: string[] }
    w.__opened = []
    w.open = (u) => { w.__opened!.push(String(u)); return null }
  })
}

test("print: the invoice, and the chosen invoices as one PDF", async ({ page, request }) => {
  const tag = `t731-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier731-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Druckkunde ${tag} GmbH`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const ids: string[] = []
  for (const price of [100, 200]) {
    const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H, data: { customerId: customer.id, issueDate: "2026-10-01", items: [{ description: "Ledertasche", quantity: 1, unit: "Stk", unitPrice: price, vatRate: 0.19 }] },
    })).json()
    ids.push(inv.id)
  }
  await as(page, userId, companyId)
  const opened = () => page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? [])

  // the invoice page: „Drucken“
  await page.goto(`/dashboard/invoices/${ids[0]}`)
  const [one] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/v1/invoices/${ids[0]}/pdf`) && r.url().includes("format=pdf"), { timeout: 60_000 }),
    page.getByTestId("invoice-print").click({ timeout: 60_000 }),
  ])
  expect(one.status()).toBe(200)
  expect(one.headers()["content-type"]).toContain("application/pdf")
  await expect.poll(opened).toHaveLength(1)
  expect((await opened())[0]).toMatch(/^blob:/)

  // the list: both chosen, „Sammeldruck“
  await page.goto("/dashboard/invoices")
  const boxes = page.getByRole("checkbox", { name: /^Rechnung .* auswählen$/ })
  await expect(boxes).toHaveCount(2, { timeout: 60_000 })
  await boxes.nth(0).check()
  await boxes.nth(1).check()
  await expect(page.getByTestId("bulk-print")).toContainText("Sammeldruck — 2")
  const [all] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/invoices/bulk-print") && r.request().method() === "POST", { timeout: 60_000 }),
    page.getByTestId("bulk-print").click(),
  ])
  expect(all.status()).toBe(200)
  expect(all.headers()["content-type"]).toContain("application/pdf")
  expect([...all.request().postDataJSON().invoiceIds].sort()).toEqual([...ids].sort())
  await expect.poll(opened).toHaveLength(1)
})
