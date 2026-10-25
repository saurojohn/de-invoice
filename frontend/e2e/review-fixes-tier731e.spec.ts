/**
 * Tier 731e — the findings of the review of Tiers 566–731 in the pages:
 *   - the product list under a line's description was clipped by the scroll
 *     box around the lines (Tier 730c);
 *   - „Als Entwurf kopieren“ took the old invoice's order number along;
 *   - every print left a frame with its PDF for ten minutes.
 * (The backend's: spec 449.)
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function setup(page: Page, request: import("@playwright/test").APIRequestContext, tag: string) {
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier731e-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-25T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  return { H, q }
}

test("the product list under a line is not clipped", async ({ page, request }) => {
  const { H, q } = await setup(page, request, `t731e-a-${Date.now()}`)
  expect((await request.post(`${API}/api/v1/products?${q}`, {
    headers: H, data: { name: "Ledertasche Modell Berlin", sku: "LT-01", unit: "Stk", basePrice: 89 },
  })).status()).toBe(201)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/dashboard/invoices/create")
  const desc = page.getByTestId("item-description").first()
  await expect(desc).toBeVisible({ timeout: 60_000 })
  await desc.fill("Leder")
  const option = page.locator("#product-options-0").getByText("Ledertasche Modell Berlin")
  await expect(option).toBeVisible()
  // no box around it cuts it off: every ancestor that clips (overflow other than
  // visible) contains the whole option — the lines' scroll box did not
  const clippedBy = await option.evaluate((el) => {
    const r = el.getBoundingClientRect()
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue
      if (a === document.body || a === document.documentElement) continue
      const b = a.getBoundingClientRect()
      if (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1) return `${a.tagName}.${a.className}`
    }
    return ""
  })
  expect(clippedBy).toBe("")
  await option.click()
  await expect(page.getByTestId("item-unit-price").first()).toHaveValue("89")
})

test("a copy does not take the order number along; one print frame at a time", async ({ page, request }) => {
  const { H, q } = await setup(page, request, `t731e-b-${Date.now()}`)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Kopierkunde GmbH`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: "2026-10-01", orderReference: "PO-ALT-1", buyerReference: "Projekt Nord", items: [{ description: "Ledertasche", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
  })).json()

  await page.goto(`/dashboard/invoices/create?cloneFrom=${inv.id}`)
  await expect(page.getByTestId("invoice-buyer-reference")).toHaveValue("Projekt Nord", { timeout: 60_000 })
  await expect(page.getByTestId("invoice-order-reference")).toHaveValue("")

  // two prints: the first one's frame is gone when the second comes
  await page.goto(`/dashboard/invoices/${inv.id}`)
  const frames = page.locator('iframe[data-testid="print-frame"]')
  for (let i = 0; i < 2; i++) {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/v1/invoices/${inv.id}/print`), { timeout: 60_000 }),
      page.getByTestId("invoice-print").click({ timeout: 60_000 }),
    ])
    await expect(frames).toHaveCount(1)
  }
})
