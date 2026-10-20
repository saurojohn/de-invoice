/**
 * Tier 710 — the dashboard chart's axis labels can be read.
 *
 * They were SVG text inside a viewBox stretched with
 * preserveAspectRatio="none": squashed into a grey line, on the dark page as
 * good as invisible. They are HTML over the chart now.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test.use({ colorScheme: "dark" })

test("the revenue chart's labels: text of a readable size, light on the dark page", async ({ page, request }) => {
  const tag = `t710-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier710-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: new Date().toISOString().slice(0, 10), items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 4000, vatRate: 0.19 }] },
  })).json()
  await request.put(`${API}/api/v1/invoices/${inv.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })

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
  await page.goto("/dashboard")
  const ticks = page.getByTestId("revenue-chart-tick")
  await expect(ticks).toHaveCount(5, { timeout: 60_000 })
  await expect(ticks.first()).toHaveText("0 €")
  await expect(ticks.last()).toHaveText(/^4\.?760\s€$/)
  const look = await ticks.last().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { fontSize: parseFloat(getComputedStyle(el).fontSize), width: r.width, height: r.height, color: getComputedStyle(el).color }
  })
  expect(look.fontSize).toBeGreaterThanOrEqual(10)
  expect(look.height).toBeGreaterThan(8) // (was squashed into a line)
  expect(look.width).toBeGreaterThan(20)
  expect(look.color).not.toBe("rgb(107, 114, 128)") // gray-500 on the dark page: the dark variant applies
})
