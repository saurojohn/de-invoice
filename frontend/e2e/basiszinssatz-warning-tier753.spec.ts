/**
 * Tier 753 — the Basiszinssatz of a new half year is not in the table yet.
 *
 * The reminder dialog and the system health page say so. (What is „yet" is the
 * backend's, spec 471; here its answers are handed to the pages.)
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const WARNING = "Der Basiszinssatz ab 01.01.2027 ist noch nicht hinterlegt. Verzugszinsen werden mit dem letzten bekannten Satz (1,52 %) berechnet."

async function as(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-29T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("the reminder dialog and the system health page name a missing rate", async ({ page, request }) => {
  const tag = `t753-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier753-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  // the invoice has to be able to go out
  expect((await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H, data: { taxId: "12/345/67890", address: { street: "Teststr. 1", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).ok()).toBeTruthy()
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" }, contact: { email: `${tag}-k@example.test` } },
  })).json()
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const invoice = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: day(60), dueDate: day(30), items: [{ description: "Ware", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${invoice.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).ok()).toBeTruthy()
  await as(page, userId, companyId)

  await page.route("**/mahnungen/fees-preview**", async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), basiszinssatzWarning: WARNING } })
  })
  await page.goto(`/dashboard/invoices/${invoice.id}`)
  await page.getByTestId("send-mahnung-button").click({ timeout: 90_000 })
  await expect(page.getByTestId("send-mahnung-rate-warning")).toHaveText(WARNING, { timeout: 30_000 })

  await page.route("**/admin/cron-health/warnings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([WARNING]) }),
  )
  await page.route("**/admin/cron-health", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )
  await page.goto("/dashboard/system-health")
  await expect(page.getByTestId("system-health-warning")).toHaveText(WARNING, { timeout: 90_000 })
})
