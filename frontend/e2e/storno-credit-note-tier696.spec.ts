/**
 * Tier 694 / 696 — "Storniert" on an issued invoice makes the Storno credit
 * note, and both documents say so.
 *
 * Tier 694: the status "cancelled" is refused for an issued invoice; the
 * invoice page's "Storniert" creates the credit note over the full amount and
 * opens it. Tier 696: the invoice it cancels is settled by it — its status is
 * "paid", and the list and the page said "Bezahlt". They say "Storniert
 * (Gutschrift)" now; the credit note links its invoice and the invoice its
 * credit notes (neither page named the other). Tier 698: the customer's page
 * lists it so too.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("Storniert: the credit note is made, opened and linked; the invoice is shown as cancelled", async ({ page, request }) => {
  const tag = `t696-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier696-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const issuer = await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })
  expect(issuer.status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const invoice = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: "2026-06-01", items: [{ description: "Beratung", quantity: 10, unit: "Std", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${invoice.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-19T00:00:00.000Z" }))
    },
    { userId, companyId },
  )

  // "Storniert" on the issued invoice: asked about the Storno credit note, then made and opened
  await page.goto(`/dashboard/invoices/${invoice.id}`)
  const select = page.getByTestId("invoice-status-select")
  await expect(select).toBeVisible({ timeout: 60_000 })
  const asked: string[] = []
  page.once("dialog", (d) => { asked.push(d.message()); void d.accept() })
  await select.selectOption("cancelled")
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(1)
  expect(asked[0]).toContain("Stornorechnung")
  expect(asked[0]).toContain(invoice.invoiceNumber)
  await expect(page).not.toHaveURL(new RegExp(`/dashboard/invoices/${invoice.id}`), { timeout: 30_000 })
  const forLink = page.getByTestId("credit-note-for")
  await expect(forLink).toBeVisible({ timeout: 30_000 })
  await expect(forLink).toContainText(invoice.invoiceNumber)
  const cnId = page.url().match(/\/dashboard\/invoices\/([0-9a-f-]{36})/)?.[1]
  const cn = await (await request.get(`${API}/api/v1/invoices/${cnId}?companyId=${companyId}`, { headers: H })).json()
  expect(cn.type).toBe("CN")
  expect(Number(cn.total)).toBe(-1190)

  // the invoice: cancelled by its credit note, which it names (was: "Bezahlt", no link)
  await forLink.click()
  await expect(page.getByTestId("invoice-credited-fully")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("invoice-status-select")).toHaveCount(0)
  await expect(page.getByTestId("credit-note-of")).toHaveText(new RegExp(cn.invoiceNumber))

  // the list says the same
  await page.goto("/dashboard/invoices")
  const row = page.locator(`[data-testid="invoice-row"][data-invoice-number="${invoice.invoiceNumber}"]`)
  await expect(row.getByTestId("row-credited")).toBeVisible({ timeout: 60_000 })

  // Tier 698: and the customer's page
  await page.goto(`/dashboard/customers/${customer.id}`)
  await page.getByTestId("tab-invoices").click({ timeout: 60_000 })
  const customerRow = page.getByTestId("tab-invoices-row").filter({ hasText: invoice.invoiceNumber })
  await expect(customerRow.getByTestId("tab-invoices-credited")).toBeVisible({ timeout: 30_000 })
})
