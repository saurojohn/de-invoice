/**
 * Tier 615 — a quote is invoiced in parts.
 *
 * "In Rechnung umwandeln" asks how much of each line the invoice takes; the
 * quote remembers what is left. Editing the invoice draft keeps each line's
 * link to the quote — and to its product, which the edit form used to drop.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a quote is invoiced in two parts; the edited draft keeps its links", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t615-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier615-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const product = await (await request.post(`${API}/api/v1/products?${q}`, { headers: H, data: { name: `${tag} Lizenz`, basePrice: 100, vatRate: 0.19 } })).json()
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date())
  const quote = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: {
      customerId: customer.id, type: "QU", issueDate: today, dueDate: "2099-01-31",
      items: [
        { description: "Lizenz", quantity: 10, unit: "Stk", unitPrice: 100, vatRate: 0.19, productId: product.id },
        { description: "Schulung", quantity: 4, unit: "Std", unitPrice: 50, vatRate: 0.19 },
      ],
    },
  })).json()
  const open = async (to: string) => {
    const d = await (await request.get(`${API}/api/v1/invoices/${quote.id}?${q}`, { headers: H })).json()
    return d.items.map((i: { id: string; description: string }) => `${i.description}=${d.conversion[to][i.id]}`).join(" ")
  }
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  page.on("dialog", (d) => d.accept())
  const title = page.locator("h1").first()
  const dialog = page.getByTestId("convert-dialog")

  // the dialog offers everything; take 4 of the first line only
  await page.goto(`/dashboard/invoices/${quote.id}`)
  await page.getByTestId("convert-to-invoice").click({ timeout: 60_000 })
  await expect(dialog.getByTestId("convert-line")).toHaveCount(2)
  await expect(dialog.getByTestId("convert-line-open")).toHaveText(["10 Stk", "4 Std"])
  await expect(dialog.getByTestId("convert-line-now").first()).toHaveValue("10")
  await dialog.getByTestId("convert-line-now").first().fill("11")
  await expect(dialog.getByTestId("convert-submit")).toBeDisabled()
  await dialog.getByTestId("convert-line-now").first().fill("4")
  await dialog.getByTestId("convert-line-now").nth(1).fill("0")
  await dialog.getByTestId("convert-submit").click()
  await expect(title).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  const firstInvoiceId = page.url().split("/").pop() as string
  expect(await open("INV")).toBe("Lizenz=6 Schulung=4")

  // edit the draft: 3 instead of 4 — the line still belongs to the quote's line and to its product
  await page.getByRole("button", { name: "Bearbeiten" }).click()
  const qty = page.getByTestId("item-quantity").first()
  await expect(qty).toHaveValue("4", { timeout: 60_000 })
  await qty.fill("3")
  await page.locator('form button[type="submit"]').first().click()
  await expect(title).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  await expect
    .poll(async () => {
      const d = await (await request.get(`${API}/api/v1/invoices/${firstInvoiceId}?${q}`, { headers: H })).json()
      const it = d.items[0]
      return `${Number(it.quantity)} product:${it.productId === product.id} source:${Boolean(it.sourceItemId)}`
    })
    .toBe("3 product:true source:true")
  expect(await open("INV")).toBe("Lizenz=7 Schulung=4")

  // the rest: the dialog knows what is left
  await page.goto(`/dashboard/invoices/${quote.id}`)
  await page.getByTestId("convert-to-invoice").click({ timeout: 60_000 })
  await expect(dialog.getByTestId("convert-line-open")).toHaveText(["7 Stk", "4 Std"])
  await dialog.getByTestId("convert-line-now").first().fill("1")
  await dialog.getByTestId("convert-all").click()
  await expect(dialog.getByTestId("convert-line-now").first()).toHaveValue("7")
  await dialog.getByTestId("convert-submit").click()
  await expect(title).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  expect(page.url().split("/").pop()).not.toBe(firstInvoiceId)
  expect(await open("INV")).toBe("Lizenz=0 Schulung=0")

  // nothing is left to invoice; everything is still to be delivered
  await page.goto(`/dashboard/invoices/${quote.id}`)
  await page.getByTestId("convert-to-invoice").click({ timeout: 60_000 })
  await expect(dialog.getByTestId("convert-none-left")).toHaveText("Aus diesem Dokument ist bereits alles abgerechnet.")
  await expect(dialog.getByTestId("convert-submit")).toHaveCount(0)
  await dialog.getByTestId("convert-cancel").click()
  await page.getByTestId("convert-to-delivery-note").click()
  await expect(dialog.getByTestId("convert-line-open")).toHaveText(["10 Stk", "4 Std"])
  await dialog.getByTestId("convert-submit").click()
  await expect(title).toHaveText(/^LS-\d{4}-\d{6}$/, { timeout: 60_000 })
})
