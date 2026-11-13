/**
 * Tier 843 — an invoice is not issued under § 19 past the Kleinunternehmer's
 * limits (backend spec 537).
 *
 * Measured before: with 30 000 € received last year, setting a draft of this
 * year to „Gesendet“ issued it without USt and with the § 19 note. Now the
 * status change is refused and the page says why and what to do.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a Kleinunternehmer over last year's 25 000 € cannot issue an invoice without USt", async ({ page, request }) => {
  const tag = `t843-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier843-e2e", companyName: `${tag} KU` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H,
    data: {
      defaultVatMode: "kleinunternehmer", rechtsform: "Einzelunternehmen", besteuerungsart: "ist",
      taxId: "21/815/08150", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" },
    },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
  const year = Number(today.slice(0, 4))
  const draft = async (issueDate: string, unitPrice: number) => (await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, issueDate, items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice, vatRate: 0.19 }] },
  })).json()).id as string
  // last year: 30 000 € issued and received
  const last = await draft(`${year - 1}-06-02`, 30000)
  expect((await request.put(`${API}/api/v1/invoices/${last}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  expect((await request.post(`${API}/api/v1/invoices/${last}/payments?${q}`, {
    headers: H, data: { amount: 30000, paymentDate: `${year - 1}-06-02`, paymentMethod: "bank_transfer" },
  })).status()).toBe(201)
  const fresh = await draft(today, 100)

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
  await page.goto(`/dashboard/invoices/${fresh}`)
  const status = page.getByTestId("invoice-status-select")
  await expect(status).toHaveValue("draft", { timeout: 60_000 })
  await status.selectOption("sent")
  await page.getByTestId("confirm-dialog-ok").click()
  await expect(page.getByText(`Die Kleinunternehmerregelung gilt ${year} nicht`).first()).toBeVisible({ timeout: 30_000 })
  await expect(status).toHaveValue("draft")
  const inv = await (await request.get(`${API}/api/v1/invoices/${fresh}?${q}`, { headers: H })).json()
  expect(inv.status).toBe("draft")
})
