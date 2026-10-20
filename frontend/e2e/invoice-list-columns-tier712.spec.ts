/**
 * Tier 712 — the invoice list: when an invoice is due, what is still open,
 * sorted by a column.
 *
 * The list showed number, customer, total, date and status, in the order the
 * invoices were created — not when each is due, not what is still to be paid
 * (a part-paid one said „Versendet“ and its full total). And the date filter
 * „bis“ dropped the invoices of its last day: the page filtered again, the
 * date „2026-08-01T00:00:00.000Z“ compared as text with „2026-08-01“.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the invoice list: due date, open amount, sorting, the last day of the range", async ({ page, request }) => {
  const tag = `t712-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier712-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  expect((await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = async (name: string) => (await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${name} ${tag}`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()).id as string
  const anton = await customer("Anton AG")
  const zeppelin = await customer("Zeppelin GmbH")
  const issue = async (customerId: string, issueDate: string, dueDate: string, unitPrice: number, paid: number) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
      headers: H,
      data: { customerId, issueDate, dueDate, items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice, vatRate: 0.19 }] },
    })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
    if (paid) {
      expect((await request.post(`${API}/api/v1/invoices/${inv.id}/payments?companyId=${companyId}`, {
        headers: H, data: { amount: paid, paymentDate: issueDate, paymentMethod: "bank_transfer" },
      })).status()).toBe(201)
    }
    return inv.invoiceNumber as string
  }
  const A = await issue(zeppelin, "2026-08-01", "2026-08-15", 1000, 190) // 1 190 €, 190 € paid, overdue
  const B = await issue(anton, "2026-09-01", "2030-01-31", 500, 595) // 595 €, paid
  const C = await issue(anton, "2026-07-01", "2026-07-31", 100, 0) // 119 €, overdue

  // the API: a column to sort by, nothing else
  expect((await request.get(`${API}/api/v1/invoices?companyId=${companyId}&sort=bogus`, { headers: H })).status()).toBe(400)

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
  await page.goto("/dashboard/invoices")
  const rows = page.getByTestId("invoice-row")
  await expect(rows).toHaveCount(3, { timeout: 60_000 })
  const order = async () => rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-invoice-number")))
  const row = (n: string) => page.locator(`[data-testid="invoice-row"][data-invoice-number="${n}"]`)

  // when it is due, how long past; what is open
  await expect(row(A).getByTestId("invoice-due")).toContainText("15.08.2026")
  await expect(row(A).getByTestId("invoice-overdue-days")).toHaveText(/^\d+ Tage überfällig$/)
  await expect(row(A).getByTestId("invoice-open")).toHaveText(/^1\.000,00\s€$/)
  await expect(row(B).getByTestId("invoice-open")).toHaveText(/^0,00\s€$/)
  await expect(row(B).getByTestId("invoice-overdue-days")).toHaveCount(0)
  await expect(row(C).getByTestId("invoice-open")).toHaveText(/^119,00\s€$/)

  // sorted: by the due date, the earliest first; again, the latest first
  await page.getByTestId("invoice-sort-dueDate").click()
  await expect.poll(order).toEqual([C, A, B])
  await page.getByTestId("invoice-sort-dueDate").click()
  await expect.poll(order).toEqual([B, A, C])
  // by the total, the largest first
  await page.getByTestId("invoice-sort-total").click()
  await expect.poll(order).toEqual([A, B, C])
  // by the customer, A to Z (the newest invoice of a customer first)
  await page.getByTestId("invoice-sort-customer").click()
  await expect.poll(order).toEqual([B, C, A])

  // „bis 01.08.2026“: the invoice of 01.08. is in the range (it was dropped)
  await page.getByTestId("invoice-date-to").fill("2026-08-01")
  await expect.poll(order).toEqual([C, A])
})
