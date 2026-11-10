import { test, expect, type APIRequestContext, type Page } from "@playwright/test"
import { acceptConfirms } from "./fixtures/confirm"

/**
 * Tier 818 — what the first-day drill met on the bank page and in the invoice
 * form (the production images on an empty database):
 *  - the statement list said „Open: € 5.000,00 · Close: … · 2 txns" and the
 *    import preview „5000 €", „476.00 €" in the German page;
 *  - a suggestion explained itself as „amount 60 + invoice# … in purpose +
 *    name match", and its due date was labelled „Datum";
 *  - the customer picker offered „+ Neuen Kunden „" anlegen" with nothing typed;
 *  - „Keine Produkte gefunden" stayed open over the next row after the
 *    description field was left.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function freshCompany(page: Page, request: APIRequestContext, tag: string) {
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier818-e2e", companyName: `${tag} GmbH` },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
    },
    { userId, companyId },
  )
  return { userId, companyId, H: { "x-user-id": userId, "x-company-id": companyId } }
}

test("the bank page speaks German: balances, counts, the suggestion's reason", async ({ page, request }) => {
  const tag = `t818c-${Date.now()}`
  const { companyId, H } = await freshCompany(page, request, tag)
  const q = `companyId=${companyId}`
  // what the settings page asks for before an invoice can be sent
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { taxId: "93815/08152", address: { street: "Königstraße 1", postalCode: "70173", city: "Stuttgart", country: "Deutschland" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Hauptstraße 5", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const d = new Date()
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  const invoice = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: iso, items: [{ description: "Aufarbeitung", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${invoice.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  const yymmdd = iso.slice(2).replace(/-/g, "")
  const mmdd = yymmdd.slice(2)
  const mt940 = [
    ":20:T818", ":25:DE89370400440532013000", ":28C:1/1", `:60F:C${yymmdd}EUR5000,00`,
    `:61:${yymmdd}${mmdd}C1190,00NTRFNONREF//${invoice.invoiceNumber}`, `:86:166?00GUTSCHRIFT?20${invoice.invoiceNumber}?32${tag} Kunde`,
    `:61:${yymmdd}${mmdd}D476,00NTRFNONREF//Miete`, ":86:177?00UEBERWEISUNG?20Miete?32Vermietung KG",
    `:62F:C${yymmdd}EUR5714,00`, "-", "",
  ].join("\r\n")

  await page.goto("/dashboard/bank-import")
  const input = page.locator('input[type="file"]')
  await expect(input).toBeAttached({ timeout: 90_000 })
  await input.setInputFiles({ name: "t818.sta", mimeType: "text/plain", buffer: Buffer.from(mt940) })
  await expect(page.getByRole("button", { name: "Import bestätigen" })).toBeVisible()
  const main = page.locator("main, body").first()
  await expect(main).toContainText("5.000,00 €")
  await expect(main).toContainText("476,00 €")
  await expect(main).not.toContainText("476.00 €")

  page.once("dialog", (dlg) => dlg.accept())
  await acceptConfirms(page) // Tier 827: the app's own dialog
  await page.getByRole("button", { name: "Import bestätigen" }).click()
  const statement = page.getByText("t818.sta")
  await expect(statement).toBeVisible()
  await expect(main).toContainText("2 Buchungen")
  await expect(main).toContainText("Anfangsbestand: 5.000,00 €")
  await expect(main).not.toContainText("Open:")
  await expect(main).not.toContainText("txns")

  await statement.click()
  await page.getByText(`${tag} Kunde`).first().click()
  const candidate = page.getByText("Betrag stimmt")
  await expect(candidate).toBeVisible()
  await expect(main).toContainText(`${invoice.invoiceNumber} im Verwendungszweck`)
  await expect(main).not.toContainText("in purpose")
  await expect(main).toContainText("Fällig:")
})

test("the invoice form: no empty quotes, no product list left open", async ({ page, request }) => {
  await freshCompany(page, request, `t818d-${Date.now()}`)
  await page.goto("/dashboard/invoices/create")
  const search = page.getByTestId("invoice-customer-search")
  await expect(search).toBeVisible({ timeout: 90_000 })
  await search.click()
  await expect(page.getByText("+ Neuen Kunden anlegen", { exact: true })).toBeVisible()
  await expect(page.getByText("„\" anlegen")).toHaveCount(0)
  await page.keyboard.press("Escape")

  const description = page.getByTestId("item-description").first()
  await description.fill("Etwas ganz Neues")
  await expect(page.getByText("Keine Produkte gefunden").first()).toBeVisible()
  await page.getByTestId("item-unit-price").first().click()
  await expect(page.getByText("Keine Produkte gefunden")).toHaveCount(0)
})

test("an invoice that does not exist leaves a way back", async ({ page, request }) => {
  await freshCompany(page, request, `t818e-${Date.now()}`)
  await page.goto("/dashboard/invoices/new")
  const box = page.getByTestId("invoice-not-found")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await box.getByRole("button", { name: "Rechnung erstellen" }).click()
  await expect(page).toHaveURL(/\/dashboard\/invoices\/create/)
})
