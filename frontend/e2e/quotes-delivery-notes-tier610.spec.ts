/**
 * Tier 610 — quotes (Angebote) and delivery notes (Lieferscheine).
 *
 * The dashboard has a card for each; the list shows them under their own
 * type, with their own statuses. A quote is written on the invoice form,
 * offered, and turned into an invoice and a delivery note — each new document
 * links back to the quote. Neither a quote nor a delivery note shows what
 * belongs to an invoice (payments, e-invoice, GiroCode, payment link).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a quote is written, offered and becomes an invoice and a delivery note", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t610-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier610-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const customerName = `${tag} Kunde`
  const created = await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: customerName, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })
  expect(created.status()).toBe(201)
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
  page.on("dialog", (d) => d.accept())

  // the dashboard leads to the quotes
  await page.goto("/dashboard")
  await page.getByTestId("card-quotes").click({ timeout: 60_000 })
  await expect(page).toHaveURL(/\/dashboard\/invoices\?type=QU/)
  await expect(page.getByTestId("invoices-title")).toHaveText("Angebote", { timeout: 60_000 })
  await expect(page.getByTestId("status-chip-offered")).toBeVisible()
  await expect(page.getByTestId("status-chip-paid")).toHaveCount(0)
  await expect(page.getByTestId("invoices-new-button")).toHaveText("Neues Angebot")

  // write one
  await page.getByTestId("invoices-new-button").click()
  await expect(page).toHaveURL(/\/dashboard\/invoices\/create\?type=QU/)
  await expect(page.getByText("Gültig für")).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("invoice-customer-search").fill(tag)
  await page.getByTestId("invoice-customer-option").filter({ hasText: customerName }).click()
  await page.getByTestId("item-description").first().fill("Beratung")
  await page.getByTestId("item-quantity").first().fill("2")
  await page.getByTestId("item-unit-price").first().fill("100")
  await page.locator('form button[type="submit"]').first().click()

  // its page: a quote, and nothing of an invoice
  const title = page.locator("h1").first()
  await expect(title).toHaveText(/^AN-\d{4}-\d{6}$/, { timeout: 60_000 })
  const quoteNumber = (await title.textContent()) || ""
  const quoteUrl = page.url()
  await expect(page.getByTestId("document-type-badge")).toHaveText("Angebot")
  await expect(page.getByTestId("invoice-download-pdf")).toBeVisible()
  for (const id of ["invoice-download-xrechnung", "invoice-check-xrechnung", "invoice-download-zugferd", "invoice-download-girocode", "invoice-portal-link-button", "installment-plan-card", "credit-note-button"]) {
    await expect(page.getByTestId(id), id).toHaveCount(0)
  }
  await expect(page.getByText("+ Zahlung erfassen")).toHaveCount(0)
  await expect(page.getByText("Gültig bis")).toBeVisible()
  await expect(page.getByText("PDF-Signatur")).toHaveCount(0)
  const status = page.getByTestId("invoice-status-select")
  await expect(status.locator("option")).toHaveText(["Entwurf", "Angeboten", "Angenommen", "Abgelehnt", "Storniert"])

  // editing keeps the type (Tier 613): the other types cannot be picked
  await page.getByRole("button", { name: "Bearbeiten" }).click()
  await expect(page.getByTestId("invoice-type-QU")).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 })
  await expect(page.getByTestId("invoice-type-INV")).toBeDisabled()
  await expect(page.getByTestId("invoice-type-DN")).toBeDisabled()
  await page.goto(quoteUrl)
  await expect(title).toHaveText(quoteNumber, { timeout: 60_000 })

  // offer it, then: the invoice
  await status.selectOption("offered")
  await expect(status).toHaveValue("offered")
  await page.getByTestId("convert-to-invoice").click()
  await expect(title).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  await expect(page.getByTestId("source-document-link")).toContainText(quoteNumber)
  await expect(page.getByTestId("document-type-badge")).toHaveCount(0)
  await expect(page.getByTestId("invoice-download-xrechnung")).toBeVisible()
  await expect(page.getByTestId("convert-to-invoice")).toHaveCount(0)

  // back on the quote: accepted, and it lists the invoice
  await page.getByTestId("source-document-link").click()
  await expect(title).toHaveText(quoteNumber, { timeout: 60_000 })
  await expect(page.getByTestId("invoice-status-select")).toHaveValue("accepted")
  await expect(page.getByTestId("derived-document-INV")).toHaveText(/^INV-/)

  // …and the delivery note
  await page.getByTestId("convert-to-delivery-note").click()
  await expect(title).toHaveText(/^LS-\d{4}-\d{6}$/, { timeout: 60_000 })
  await expect(page.getByTestId("document-type-badge")).toHaveText("Lieferschein")
  await expect(page.getByTestId("invoice-status-select").locator("option")).toHaveText(["Entwurf", "Geliefert", "Storniert"])
  await expect(page.getByTestId("source-document-link")).toContainText(quoteNumber)
  await expect(page.getByTestId("convert-to-delivery-note")).toHaveCount(0)

  // the list of invoices has the invoice only; the other two under their type
  await page.goto("/dashboard/invoices")
  await expect(page.getByText(/^INV-\d{4}-\d{6}$/).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(quoteNumber)).toHaveCount(0)
  await expect(page.getByText(/^LS-\d{4}-\d{6}$/)).toHaveCount(0)
  await page.getByTestId("type-chip-DN").click()
  await expect(page.getByTestId("invoices-title")).toHaveText("Lieferscheine")
  await expect(page.getByText(/^LS-\d{4}-\d{6}$/).first()).toBeVisible()
  await expect(page.getByTestId("status-chip-delivered")).toBeVisible()
  await page.getByTestId("type-chip-QU").click()
  // the counter states its numbers (it read "Zeige {shown} von {total} 1 / 1")
  await expect(page.getByTestId("invoices-showing")).toHaveText("Zeige 1 von 1")
  await expect(page.getByText(quoteNumber).first()).toBeVisible()
  await expect(page.getByText("Angenommen").first()).toBeVisible()

  // in Chinese
  await page.addInitScript(() => localStorage.setItem("locale", "zh"))
  await page.goto(quoteUrl)
  await expect(page.getByTestId("document-type-badge")).toHaveText("报价单", { timeout: 60_000 })
  await expect(page.getByTestId("convert-to-invoice")).toHaveText("转为发票")
  await expect(page.getByTestId("invoice-status-select").locator("option")).toContainText(["已接受"])
})
