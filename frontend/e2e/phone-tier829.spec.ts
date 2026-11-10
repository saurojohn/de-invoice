import { test, expect, type Page } from "@playwright/test"

/**
 * Tier 829 — the daily pages at the width of a phone (375 px), walked on the
 * production build:
 *
 *  - the invoice list and the bills received showed a table cut at the
 *    screen's edge: number and customer, the amount, the due date and the
 *    status beyond it. One card per document now;
 *  - the invoice page stacked eleven buttons above the invoice: „Per E-Mail
 *    senden" and „PDF herunterladen" stay, the rest is behind „Weitere
 *    Aktionen";
 *  - a customer's name was cut to „Lederwar…" by the icons beside it;
 *  - a line item of the invoice form had no labels (the column heads are
 *    hidden below 1024 px): „1 · Stück · 0".
 * On a desktop all of it is as before.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function fixture(page: Page, request: import("@playwright/test").APIRequestContext) {
  const tag = `t829-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier829-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: "Lederwaren Schmidt & Söhne GmbH", type: "business", address: { street: "Hauptstraße 117", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: "2026-06-01", items: [{ description: "Aktentasche", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  const number: string = (await (await request.get(`${API}/api/v1/invoices/${inv.id}?${q}`, { headers: H })).json()).invoiceNumber
  expect((await request.post(`${API}/api/v1/expenses?${q}`, {
    headers: H, data: { description: "Leder Lieferung", invoiceNumber: "L-829", invoiceDate: "2026-06-05", netAmount: 840, vatRate: 0.19, vatAmount: 159.6, grossAmount: 999.6, category: "Wareneinkauf" },
  })).status()).toBe(201)
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId })
  return { invoiceId: inv.id as string, customerId: customer.id as string, number }
}

test("on a phone: cards for invoices and bills, the invoice's actions folded, names whole, line items labelled", async ({ page, request }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 375, height: 812 })
  const { invoiceId, customerId, number } = await fixture(page, request)

  // the invoice list: a card with what the table hid
  await page.goto("/dashboard/invoices")
  const card = page.getByTestId("invoice-card").filter({ hasText: number })
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(card).toContainText("Lederwaren Schmidt & Söhne GmbH")
  await expect(card).toContainText("1.190,00 €")
  await expect(card).toContainText("fällig")
  await expect(page.getByTestId("invoice-row").first()).toBeHidden()
  const cardBox = await card.boundingBox()
  expect((cardBox?.x ?? 0) + (cardBox?.width ?? 999), "the card fits the screen").toBeLessThanOrEqual(375)

  // the bills received
  await page.goto("/dashboard/expenses")
  const bill = page.getByTestId("expense-card").first()
  await expect(bill).toBeVisible({ timeout: 90_000 })
  await expect(bill).toContainText("999,60 €")
  await expect(bill).toContainText("L-829")

  // the invoice page: two actions and „Weitere Aktionen"
  await page.goto(`/dashboard/invoices/${invoiceId}`)
  const more = page.getByTestId("invoice-more-toggle")
  await expect(more).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole("button", { name: "PDF herunterladen" })).toBeVisible()
  const xr = page.getByRole("button", { name: "XRechnung herunterladen" })
  await expect(xr).toBeHidden()
  await more.click()
  await expect(xr).toBeVisible()
  await expect(more).toHaveAttribute("aria-expanded", "true")

  // the customer's name, whole
  await page.goto("/dashboard/customers")
  const name = page.getByTestId("customer-card-name").first()
  await expect(name).toHaveText("Lederwaren Schmidt & Söhne GmbH", { timeout: 90_000 })
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "not cut off").toBe(true)
  await page.goto(`/dashboard/customers/${customerId}`)
  await expect(page.getByTestId("tab-invoices-table")).toBeVisible({ timeout: 90_000 })

  // a line item: its fields say what they are
  await page.goto("/dashboard/invoices/create")
  const row = page.getByTestId("item-row").first()
  await expect(row).toBeVisible({ timeout: 90_000 })
  for (const label of ["Menge / Einheit", "Einzelpreis", "MwSt"]) await expect(row).toContainText(label)
  await expect(row.getByRole("button", { name: "Position hinzufügen" })).toBeVisible()
})

test("on a desktop: the tables and every action as before", async ({ page, request }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const { invoiceId, number } = await fixture(page, request)
  await page.goto("/dashboard/invoices")
  await expect(page.locator(`[data-testid="invoice-row"][data-invoice-number="${number}"]`)).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("invoice-card").first()).toBeHidden()
  await page.goto(`/dashboard/invoices/${invoiceId}`)
  await expect(page.getByRole("button", { name: "XRechnung herunterladen" })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("invoice-more-toggle")).toBeHidden()
})
