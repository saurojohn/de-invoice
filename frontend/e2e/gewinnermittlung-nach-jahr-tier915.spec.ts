/**
 * Tier 915 — a change of the Gewinnermittlung applies from a year on.
 *
 * Measured before: `gewinnermittlung` was one value for every year — setting
 * "Bilanzierung" turned last year's Anlage G (an EÜR) over. Now the settings
 * page asks from which year the change applies (this one or the next, § 141
 * Abs. 2 AO), and the years before keep their method.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
test("a change to Bilanzierung is saved from the year chosen; this year stays an EÜR", async ({ page, request }) => {
  const tag = `t915-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier915-e2e", companyName: `${tag}` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const year = new Date().getFullYear()
  await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H,
    data: {
      rechtsform: "Einzelunternehmen", gewinnermittlung: "euer",
      address: { street: "Teststr. 1", postalCode: "10115", city: "Berlin", country: "DE" }, taxId: "12/345/67890",
    },
  })
  // something booked before next year — else the setting changes as a whole
  const cust = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Teststr. 9", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: cust.id, issueDate: `${year}-01-10`, items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }] },
  })).json()
  await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })

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

  await page.goto("/dashboard/settings")
  const select = page.getByTestId("settings-gewinnermittlung")
  await expect(select).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  await expect(select).toHaveValue("euer")
  await expect(page.getByTestId("settings-gewinnermittlung-ab")).toHaveCount(0)
  await select.selectOption("bilanz")
  const ab = page.getByTestId("settings-gewinnermittlung-ab")
  await expect(ab).toHaveValue(String(year))
  await ab.selectOption(String(year + 1))
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/companies/${companyId}`) && r.request().method() === "PUT",
    { timeout: 60_000 },
  )
  await page.getByTestId("settings-save").click()
  const res = await saved
  expect(res.status()).toBe(200)
  expect(res.request().postDataJSON().gewinnermittlungAb).toBe(year + 1)

  const company = await (await request.get(`${API}/api/v1/companies/${companyId}?${q}`, { headers: H })).json()
  expect(company.gewinnermittlung).toBe("bilanz")
  expect(company.settings.gewinnermittlungWechsel).toEqual([{ ab: year + 1, art: "bilanz", vorher: "euer" }])
  const g = await (await request.get(`${API}/api/v1/accounting/anlage-g?${q}&year=${year}`, { headers: H })).json()
  expect(g.gewinnermittlung).toBe("euer")
})
