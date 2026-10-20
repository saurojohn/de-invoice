/**
 * Tier 717 — the new-invoice form finds the 201st customer and article.
 *
 * The form loaded the first 200 customers (by name) and products and
 * filtered them in the browser. With more, „Zimmermann“ typed found nothing —
 * and the form offered to create the customer anew. Beyond the first page a
 * search now asks the server and adds what it finds.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("more than 200 customers and articles: the pickers find the last ones", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t717-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier717-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const address = { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" }
  const many = async (n: number, make: (i: number) => Promise<unknown>) => {
    for (let i = 0; i < n; i += 25) await Promise.all(Array.from({ length: Math.min(25, n - i) }, (_, k) => make(i + k)))
  }
  const num = (i: number) => String(i).padStart(3, "0")
  await many(201, async (i) => expect((await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H, data: { name: `Aachen Kunde ${num(i)}`, type: "business", address },
  })).status()).toBe(201))
  expect((await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H, data: { name: `Zimmermann ${tag}`, type: "business", address },
  })).status()).toBe(201)
  await many(201, async (i) => expect((await request.post(`${API}/api/v1/products?companyId=${companyId}`, {
    headers: H, data: { sku: `A-${num(i)}`, name: `Artikel ${num(i)}`, unit: "Stk", basePrice: 10, vatRate: 19 },
  })).status()).toBe(201))
  expect((await request.post(`${API}/api/v1/products?companyId=${companyId}`, {
    headers: H, data: { sku: "ZZ-717", name: "Zubehör", unit: "Stk", basePrice: 5, vatRate: 19 },
  })).status()).toBe(201)

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
  await page.goto("/dashboard/invoices/create")
  const search = page.getByTestId("invoice-customer-search")
  await expect(search).toBeVisible({ timeout: 60_000 })
  await search.focus()
  await page.keyboard.type("Zimmermann")
  // the 202nd customer by name: found (it was „Keine Kunden gefunden“ and „+ anlegen“)
  const options = page.getByTestId("invoice-customer-option")
  await expect(options).toHaveCount(1, { timeout: 30_000 })
  await expect(options.first()).toContainText(`Zimmermann ${tag}`)

  // the 202nd article, by its number
  const sku = page.getByTestId("item-product-number").first()
  await sku.focus()
  await page.keyboard.type("ZZ-7")
  await expect(page.locator("#product-number-options-0 [role=option]")).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator("#product-number-options-0 [role=option]").first()).toContainText("Zubehör")
})
