/**
 * Tier 845 — invoices issued without USt on a day the Kleinunternehmer-
 * regelung no longer covers are shown (backend spec 539).
 *
 * Measured before: the end of the regulation set back over § 19 invoices
 * already issued — they stood in the UStVA and the EÜR as tax-free, and no
 * page said a word. Now the settings show them as soon as the period is
 * saved, and the dashboard until each one is corrected.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("setting the end of the Kleinunternehmerregelung back lists the invoices issued without USt since", async ({ page, request }) => {
  const tag = `t845-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier845-e2e", companyName: `${tag} KU` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H,
    data: {
      defaultVatMode: "kleinunternehmer", rechtsform: "Einzelunternehmen", besteuerungsart: "soll",
      taxId: "21/815/08150", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" },
    },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const lastYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date())) - 1
  const issue = async (issueDate: string, unitPrice: number) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H,
      data: { customerId: customer.id, issueDate, items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice, vatRate: 0.19 }] },
    })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
    return inv as { id: string; invoiceNumber: string }
  }
  const march = await issue(`${lastYear}-03-02`, 1000)
  const august = await issue(`${lastYear}-08-04`, 2000)

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
  await page.goto("/dashboard/settings")
  const mode = page.getByTestId("settings-default-vat-mode")
  await expect(mode).toHaveValue("kleinunternehmer", { timeout: 90_000 })
  // a Kleinunternehmer since always: nothing to show
  await expect(page.getByTestId("kleinunternehmer-ohneUmsatzsteuer")).toHaveCount(0)

  await mode.selectOption("standard")
  await page.getByTestId("settings-ku-date").fill(`${lastYear}-07-01`)
  const saved = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/companies/${companyId}`) && r.request().method() === "PUT",
    { timeout: 30_000 },
  )
  await page.getByTestId("settings-save").click()
  expect((await saved).status()).toBe(200)

  // the settings say it at once: the invoice of August, not the one of March
  const ohne = page.getByTestId("kleinunternehmer-ohneUmsatzsteuer")
  await expect(ohne).toBeVisible({ timeout: 30_000 })
  await expect(ohne).toContainText("1 Rechnung(en) über zusammen 2.000,00 €")
  await expect(ohne).toContainText("steuerpflichtig")
  await expect(ohne).toContainText(august.invoiceNumber)
  await expect(ohne).not.toContainText(march.invoiceNumber)
  await expect(page.getByTestId("kleinunternehmer-notice")).toHaveAttribute("data-ended", "true")

  // the dashboard too, with a link to the invoice
  await page.goto("/dashboard")
  const link = page.getByTestId("kleinunternehmer-ohne-link")
  await expect(link).toHaveText(august.invoiceNumber, { timeout: 90_000 })
  await expect(link).toHaveAttribute("href", `/dashboard/invoices/${august.id}`)
})
