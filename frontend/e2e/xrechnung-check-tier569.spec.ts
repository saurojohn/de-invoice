/**
 * Tier 569 — "XRechnung prüfen" on the invoice page.
 *
 * The official KoSIT validator could only be reached by calling the API by
 * hand (`…/xrechnung/validate?engine=kosit`), and its answer carried a single
 * finding cut off after 60 characters. The invoice page now has a button; the
 * result names the engine that was used and lists every finding with its rule.
 * Where the installation has no validator (no Java / no files) the built-in
 * check answers and the page says so — both are fine for this test.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("the invoice page checks an XRechnung and shows what is wrong with it", async ({ page, request }) => {
  const tag = `t569-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier569-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  // A seller without address, tax number or e-mail: not a valid XRechnung by
  // either engine (BR-06 / BR-09, BR-S-02 / BR-CO-26 …).
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: "Tier 569 Kunde", type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
  const invoice = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: today, items: [{ description: "Beratung", quantity: 1, unit: "Std", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect(invoice.id, `fixture invoice: ${JSON.stringify(invoice).slice(0, 200)}`).toBeTruthy()

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
  await page.goto(`/dashboard/invoices/${invoice.id}`)
  const button = page.getByTestId("invoice-check-xrechnung")
  await expect(button).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  await button.click()

  const result = page.getByTestId("xrechnung-check-result")
  await expect(result).toBeVisible({ timeout: 90_000 })
  await expect(result).toHaveAttribute("data-valid", "0")
  expect(["kosit", "kosit-unavailable", "basic"]).toContain(await result.getAttribute("data-engine"))
  const findings = page.getByTestId("xrechnung-check-errors").locator("li")
  expect(await findings.count(), "at least one finding is listed").toBeGreaterThan(0)
  await expect(findings.first()).toContainText(/BR-|PEPPOL|XSD/)
})
