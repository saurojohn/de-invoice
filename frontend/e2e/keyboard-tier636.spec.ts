/**
 * Tier 636 — what a click opens, a key opens too.
 *
 * Measured before: the dashboard's 35 cards were <div onClick> — Tab passed
 * them, Enter did nothing. The invoice form's customer field listed its
 * matches for the mouse only: the arrow keys did nothing, Enter sent the form
 * without a customer, Tab closed the list. So an invoice could not be written
 * without a mouse. The same for the article fields, the reference invoice,
 * the inventory page's product search, and the table rows that open on a
 * click (a customer's invoices and e-mails, the vouchers, a product's name).
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function company(page: Page, request: APIRequestContext, tag: string) {
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier636-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
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
  return { companyId, H }
}

test("the dashboard's cards are links: in the tab order, opened by Enter", async ({ page, request }) => {
  test.setTimeout(180_000)
  await company(page, request, `t636a-${Date.now()}`)
  await page.goto("/dashboard")
  const card = page.getByTestId("card-time")
  await expect(card).toBeVisible({ timeout: 60_000 })
  // every card that opens a page on a click
  const cards = await page.locator("div.cursor-pointer.rounded-lg.border").evaluateAll((els) =>
    els.map((el) => ({ role: el.getAttribute("role"), tab: (el as HTMLElement).tabIndex })),
  )
  expect(cards.length).toBeGreaterThan(20)
  expect(cards.filter((c) => c.role !== "link" || c.tab !== 0)).toEqual([])
  // the tab key gets there
  await page.getByTestId("card-delivery-notes").focus()
  await page.keyboard.press("Tab")
  await expect(card).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/dashboard\/time$/, { timeout: 60_000 })
})

test("an invoice is written without a mouse: customer and article are chosen with the arrow keys", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t636b-${Date.now()}`
  const { companyId, H } = await company(page, request, tag)
  const address = { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" }
  const ids: Record<string, string> = {}
  for (const name of ["Anton", "Berta", "Cäsar"]) {
    const c = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, { headers: H, data: { name: `${tag} ${name}`, type: "business", address } })).json()
    ids[name] = c.id
  }
  for (const [sku, name, price] of [["KB-1", "Tastatur", 40], ["KB-2", "Tastenkappe", 5]] as const) {
    const p = await (await request.post(`${API}/api/v1/products?companyId=${companyId}`, { headers: H, data: { sku, name, unit: "Stk", basePrice: price, vatRate: 19 } })).json()
    ids[sku] = p.id
  }

  await page.goto("/dashboard/invoices/create")
  const search = page.getByTestId("invoice-customer-search")
  await expect(search).toBeVisible({ timeout: 60_000 })
  await search.focus()
  await page.keyboard.type(tag)
  const options = page.getByTestId("invoice-customer-option")
  await expect(options).toHaveCount(3, { timeout: 30_000 })
  await expect(search).toHaveAttribute("role", "combobox")
  await expect(search).toHaveAttribute("aria-expanded", "true")
  // ↓ ↓ marks the second, ↑ at the top goes round to the last
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true")
  await expect(search).toHaveAttribute("aria-activedescendant", "customer-options-1")
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("ArrowUp")
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true")
  const picked = (await options.nth(1).locator("div").first().textContent()) || ""
  // Enter takes it — and does not send the form
  await page.keyboard.press("Enter")
  await expect(search).toHaveValue(picked)
  await expect(options).toHaveCount(0)
  await expect(page).toHaveURL(/\/dashboard\/invoices\/create$/)

  // the article number's field: Escape closes the list, the arrow keys choose
  const sku = page.getByTestId("item-product-number").first()
  await sku.focus()
  await page.keyboard.type("KB-")
  const skuOptions = page.locator("#product-number-options-0 [role=option]")
  await expect(skuOptions).toHaveCount(2)
  await page.keyboard.press("Escape")
  await expect(skuOptions).toHaveCount(0)
  await page.keyboard.type("2")
  await expect(skuOptions).toHaveCount(1)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(sku).toHaveValue("KB-2")
  await expect(page.getByTestId("item-description").first()).toHaveValue("Tastenkappe")
  await expect(page).toHaveURL(/\/dashboard\/invoices\/create$/)

  // the description's field of the same line: another article
  const description = page.getByTestId("item-description").first()
  await description.focus()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("Tastat")
  await expect(page.locator("#product-options-0 [role=option]")).toHaveCount(1)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(sku).toHaveValue("KB-1")

  // and the form is sent from the keyboard
  await page.locator('form button[type="submit"]').first().focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/dashboard\/invoices$/, { timeout: 60_000 })
  const list = await (await request.get(`${API}/api/v1/invoices?companyId=${companyId}`, { headers: H })).json()
  const rows = list.data ?? list.invoices ?? list
  expect(rows).toHaveLength(1)
  const invoice = await (await request.get(`${API}/api/v1/invoices/${rows[0].id}?companyId=${companyId}`, { headers: H })).json()
  expect(invoice.customer.name).toBe(picked)
  expect(invoice.items.map((i: { productId: string; description: string }) => [i.productId, i.description])).toEqual([[ids["KB-1"], "Tastatur"]])
})

test("a row that opens on a click has a link or a button in it", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t636c-${Date.now()}`
  const { companyId, H } = await company(page, request, tag)
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date())
  const invoice = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H, data: { customerId: customer.id, issueDate: today, dueDate: "2099-01-31", items: [{ description: "Ware", quantity: 1, unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  await request.post(`${API}/api/v1/products?companyId=${companyId}`, { headers: H, data: { sku: "KB-9", name: "Tastatur", unit: "Stk", basePrice: 40, vatRate: 19 } })

  // a product's name opens its form
  await page.goto("/dashboard/products")
  const name = page.getByTestId("product-row").first().getByRole("button", { name: "Tastatur" })
  await expect(name).toBeVisible({ timeout: 60_000 })
  await name.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator('input[value="KB-9"]')).toBeVisible({ timeout: 30_000 })

  // a customer's invoice: the number is the link
  await page.goto(`/dashboard/customers/${customer.id}`)
  await page.getByTestId("tab-invoices").click({ timeout: 60_000 })
  const link = page.getByTestId("tab-invoices-link").first()
  await expect(link).toHaveText(invoice.invoiceNumber, { timeout: 60_000 })
  await link.focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/dashboard/invoices/${invoice.id}`), { timeout: 60_000 })
})
