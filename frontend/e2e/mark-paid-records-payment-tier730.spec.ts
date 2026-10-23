/**
 * Tier 730 — „Bezahlt“ on an invoice with money open opens the payment form
 * (the open amount, today, the invoice's payment method) instead of setting
 * the status alone: that booked no payment — the EÜR and the
 * Ist-Versteuerung counted the income on the issue date, the cash book and
 * the bank match knew nothing of it.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("„Bezahlt“ with money open: the payment is recorded", async ({ page, request }) => {
  const tag = `t730-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier730-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Barkunde ${tag} GmbH`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: "2026-10-01", paymentMethod: "cash", items: [{ description: "Ledertasche", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-23T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto(`/dashboard/invoices/${inv.id}`)
  const status = page.getByTestId("invoice-status-select")
  await expect(status).toBeVisible({ timeout: 60_000 })
  await status.selectOption("paid")

  // the payment form, filled in — the status not yet changed
  await expect(page.getByTestId("payment-form")).toBeVisible()
  await expect(page.getByTestId("payment-amount")).toHaveValue("119.00")
  await expect(page.getByTestId("payment-method")).toHaveValue("cash")
  await expect(status).toHaveValue("sent")
  const before = await (await request.get(`${API}/api/v1/invoices/${inv.id}?${q}`, { headers: H })).json()
  expect(before.status).toBe("sent")

  await page.getByTestId("payment-save").click()
  await expect(page.getByTestId("payment-row")).toHaveCount(1, { timeout: 30_000 })
  const after = await (await request.get(`${API}/api/v1/invoices/${inv.id}?${q}`, { headers: H })).json()
  expect(after.status).toBe("paid")
  expect((after.payments ?? []).map((p: { amount: string | number }) => Number(p.amount))).toEqual([119])
})

// Tier 730b — the invoice page writes countries and the document type as the PDF does
test("invoice page: countries per DIN 5008, the type by its name", async ({ page, request }) => {
  const tag = `t730b-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier730b-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const invoiceFor = async (name: string, country: string, vatId?: string) => {
    const c = await (await request.post(`${API}/api/v1/customers?${q}`, {
      headers: H, data: { name, type: "business", vatId, address: { street: "Ring 2", postalCode: "1010", city: "Wien", country } },
    })).json()
    return (await (await request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H, data: { customerId: c.id, issueDate: "2026-10-01", items: [{ description: "x", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
    })).json()).id as string
  }
  const domestic = await invoiceFor(`Inland ${tag}`, "DE")
  const abroad = await invoiceFor(`Wien ${tag}`, "AT", "ATU12345678")

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-23T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto(`/dashboard/invoices/${domestic}`)
  await expect(page.getByTestId("invoice-type-label")).toHaveText("Ausgangsrechnung", { timeout: 60_000 })
  await expect(page.locator("main")).not.toContainText("10115 Berlin · DE")
  await expect(page.getByTestId("invoice-customer-country")).toHaveCount(0)

  await page.goto(`/dashboard/invoices/${abroad}`)
  await expect(page.getByTestId("invoice-customer-country")).toHaveText("ÖSTERREICH", { timeout: 60_000 })
  await expect(page.locator("main")).toContainText("10115 Berlin · DEUTSCHLAND")
})

// Tier 730c — the line items: header over its fields, one row per line, the line's total
test("invoice form: the line items' columns line up, each line shows its total", async ({ page, request }) => {
  const tag = `t730c-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier730c-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-23T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto("/dashboard/invoices/create")
  const price = page.getByTestId("item-unit-price").first()
  await expect(price).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("item-quantity").first().fill("2")
  await price.fill("50")
  await expect(page.getByTestId("item-line-total").first()).toHaveText("100,00 €")

  // the price's heading stands over the price field (it was a column to the left, half as wide)
  const label = (await page.getByTestId("items-unit-price-label").boundingBox())!
  const field = (await price.boundingBox())!
  expect(Math.abs(label.x - field.x)).toBeLessThan(3)
  // the row is one line: its „+“ beside the price, not below it (13 of 12 columns)
  const row = page.getByTestId("item-row").first()
  const add = (await row.getByTitle("Position hinzufügen").boundingBox())!
  expect(Math.abs(add.y + add.height / 2 - (field.y + field.height / 2))).toBeLessThan(12)
})
