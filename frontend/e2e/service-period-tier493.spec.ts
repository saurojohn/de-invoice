/**
 * Tier 493 — the Leistungszeitraum.
 *
 * An invoice with a period shows it on its detail page instead of a
 * Leistungsdatum; a recurring template chooses which period its invoices
 * state (current / previous interval, or none).
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test"

const API = "http://localhost:3001"

async function setup(page: Page, request: APIRequestContext) {
  const tag = `t493-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier493-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business" },
  })).json()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
  return { tag, H, q, customerId: customer.id as string }
}

const items = [{ description: "Wartung", quantity: 1, unit: "Monat", unitPrice: 500, vatRate: 0.19 }]

test("an invoice's Leistungszeitraum is shown on its detail page", async ({ page, request }) => {
  const { H, q, customerId } = await setup(page, request)
  const res = await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId, issueDate: "2026-09-02", servicePeriodStart: "2026-08-01", servicePeriodEnd: "2026-08-31", items },
  })
  expect(res.status(), "invoice").toBe(201)
  const inv = await res.json()
  await page.goto(`/dashboard/invoices/${inv.id}`)
  const period = page.getByTestId("leistungszeitraum")
  await expect(period).toBeVisible({ timeout: 90_000 })
  await expect(period).toContainText("01.08.2026")
  await expect(period).toContainText("31.08.2026")
  await expect(page.getByTestId("leistungsdatum")).toHaveCount(0)
})

test("a recurring template's service period is chosen in its form", async ({ page, request }) => {
  const { tag, H, q, customerId } = await setup(page, request)
  const res = await request.post(`${API}/api/v1/recurring-invoices?${q}`, {
    headers: H,
    data: { customerId, name: `${tag} Support`, interval: "monthly", dayOfMonth: 1, startDate: "2026-09-01", servicePeriod: "none", items },
  })
  expect(res.status(), "template").toBe(201)
  const tpl = await res.json()

  await page.goto("/dashboard/recurring-invoices")
  const card = page.locator(`[data-testid="recurring-card"][data-recurring-name="${tag} Support"]`)
  await expect(card).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await card.getByTestId("recurring-edit").click()
  const select = page.getByTestId("recurring-form-service-period")
  await expect(select).toHaveValue("none")
  await select.selectOption("previous")
  await page.getByTestId("recurring-form-save").click()

  await expect.poll(async () => {
    const list = await (await request.get(`${API}/api/v1/recurring-invoices?${q}`, { headers: H })).json()
    const rows = Array.isArray(list) ? list : list.items ?? list.data ?? []
    return rows.find((r: any) => r.id === tpl.id)?.servicePeriod
  }, { timeout: 30_000 }).toBe("previous")
})
