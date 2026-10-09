/**
 * Tier 640 — "today" is the German calendar day, in whatever time zone the
 * browser is.
 *
 * The invoice page offered Edit and Delete when the invoice's issue date and
 * the present moment fell on the same day *in the browser's time zone*. The
 * backend allows both on the German calendar day. In a browser in China it is
 * tomorrow from 18:00 German time on: the buttons were gone from a draft
 * written that afternoon. (Found by the CI run of 10.10.2026, whose browser is
 * in UTC: at 00:41 German time it was still yesterday there.)
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a draft of today can be edited from a browser in Shanghai, late in the German evening", async ({ browser, request }) => {
  test.setTimeout(180_000)
  const tag = `t640b-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier640-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date())
  const invoice = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H, data: { customerId: customer.id, issueDate: today, dueDate: "2099-01-31", items: [{ description: "Ware", quantity: 1, unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect(invoice.status).toBe("draft")

  const context = await browser.newContext({ timezoneId: "Asia/Shanghai", locale: "zh-CN" })
  await context.addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await context.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  const page = await context.newPage()
  // 21:30 UTC of the German day: half past ten or eleven in the evening in
  // Germany, half past five the next morning in Shanghai.
  await page.clock.setFixedTime(new Date(`${today}T21:30:00Z`))
  await page.goto(`/dashboard/invoices/${invoice.id}`)
  await expect(page.locator("h1").first()).toHaveText(/ENTWURF|Entwurf|INV-|DRAFT/i, { timeout: 60_000 })
  expect(await page.evaluate(() => new Date().getDate())).not.toBe(Number(today.slice(8, 10)))
  await expect(page.getByRole("button", { name: "Bearbeiten" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: "Löschen" }).first()).toBeVisible()

  // and the edit form opens — the backend agrees that it is today
  await page.getByRole("button", { name: "Bearbeiten" }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/invoices/create\\?id=${invoice.id}`), { timeout: 60_000 })
  await expect(page.getByTestId("item-quantity").first()).toHaveValue("1", { timeout: 60_000 })
  await context.close()
})
