/**
 * Tier 731 — printing from the pages: „Drucken“ on the invoice (there was only
 * „PDF herunterladen“) and „Sammeldruck“ for the chosen invoices in the list
 * (there was only a ZIP). The PDF's layout: backend spec 448.
 * Tier 731c — the browser's print dialog with the computer's printers, from a
 * frame on the page (no new tab); the company's printer named as a reminder.
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
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" }, settings: { defaultPrinter: "Brother HL-L2350DW" } },
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
  // the PDF goes into a frame on the page, printed from there
  const frames = () => page.locator('iframe[data-testid="print-frame"]').evaluateAll((els) => els.map((e) => (e as HTMLIFrameElement).src))

  // the invoice page: „Drucken“
  await page.goto(`/dashboard/invoices/${ids[0]}`)
  const [one] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/invoices/bulk-print") && r.request().method() === "POST", { timeout: 60_000 }),
    page.getByTestId("invoice-print").click({ timeout: 60_000 }),
  ])
  expect(one.status()).toBe(200)
  expect(one.headers()["content-type"]).toContain("application/pdf")
  expect(one.request().postDataJSON().invoiceIds).toEqual([ids[0]])
  await expect.poll(frames).toHaveLength(1)
  expect((await frames())[0]).toMatch(/^blob:/)
  // the printer the company named, as a reminder (the dialog cannot be told it)
  await expect(page.getByText(/Brother HL-L2350DW/)).toBeVisible()

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
  await expect.poll(frames).toHaveLength(1)
})
