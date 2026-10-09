/**
 * Tier 614 — the order confirmation (Auftragsbestätigung).
 *
 * The quote's page makes an order confirmation; it has its own list, its own
 * statuses, and becomes the invoice. Each document links to the one before.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a quote becomes an order confirmation, and that the invoice", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t614-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier614-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date())
  const quote = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, type: "QU", issueDate: today, dueDate: "2099-01-31", items: [{ description: "Beratung", quantity: 2, unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${quote.id}/status?companyId=${companyId}`, { headers: H, data: { status: "offered" } })).status()).toBe(200)
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

  // the dashboard has the list, still empty
  await page.goto("/dashboard")
  await page.getByTestId("card-order-confirmations").click({ timeout: 60_000 })
  await expect(page).toHaveURL(/\/dashboard\/invoices\?type=OC/, { timeout: 60_000 })
  await expect(page.getByTestId("invoices-title")).toHaveText("Auftragsbestätigungen", { timeout: 60_000 })
  await expect(page.getByTestId("invoices-new-button")).toHaveText("Neue Auftragsbestätigung")
  await expect(page.getByText("Noch keine Auftragsbestätigungen.")).toBeVisible()
  await expect(page.getByTestId("status-chip-confirmed")).toBeVisible()

  // the quote's page makes one
  await page.goto(`/dashboard/invoices/${quote.id}`)
  const title = page.locator("h1").first()
  await expect(title).toHaveText(quote.invoiceNumber, { timeout: 60_000 })
  await page.getByTestId("convert-to-order-confirmation").click()
  await expect(title).toHaveText(/^AB-\d{4}-\d{6}$/, { timeout: 60_000 })
  const number = (await title.textContent()) || ""
  await expect(page.getByTestId("document-type-badge")).toHaveText("Auftragsbestätigung")
  await expect(page.getByTestId("source-document-link")).toContainText(quote.invoiceNumber)
  const status = page.getByTestId("invoice-status-select")
  await expect(status.locator("option")).toHaveText(["Entwurf", "Bestätigt", "Storniert"])
  for (const id of ["invoice-download-xrechnung", "invoice-download-zugferd", "invoice-download-girocode", "invoice-portal-link-button", "convert-to-order-confirmation"]) {
    await expect(page.getByTestId(id), id).toHaveCount(0)
  }
  await expect(page.getByText("+ Zahlung erfassen")).toHaveCount(0)

  // confirm it; it becomes the invoice
  await status.selectOption("confirmed")
  await expect(status).toHaveValue("confirmed")
  await page.getByTestId("convert-to-invoice").click()
  await page.getByTestId("convert-submit").click() // Tier 615: the dialog offers all that is open
  await expect(title).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  await expect(page.getByTestId("source-document-link")).toContainText(number)

  // the quote is accepted and names the confirmation; the list has it
  await page.goto(`/dashboard/invoices/${quote.id}`)
  await expect(page.getByTestId("invoice-status-select")).toHaveValue("accepted", { timeout: 60_000 })
  await expect(page.getByTestId("derived-document-OC")).toHaveText(number)
  // The page asks for the list twice when it opens with ?type= — first without
  // the type (it reads the URL in an effect), then with it. An answer to the
  // first that comes late must not replace the list of the type asked for
  // (it did: the confirmations' list showed the invoices).
  await page.route(/\/api\/v1\/invoices\?/, async (route) => {
    if (!route.request().url().includes("type=")) await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  const late = page.waitForResponse((r) => /\/api\/v1\/invoices\?/.test(r.url()) && !r.url().includes("type="))
  await page.goto("/dashboard/invoices?type=OC")
  await expect(page.getByText(number).first()).toBeVisible({ timeout: 60_000 })
  await late
  await expect(page.getByText("Bestätigt").first()).toBeVisible()
  await expect(page.getByText(number).first()).toBeVisible()
  await expect(page.getByText(/^INV-\d{4}-\d{6}$/)).toHaveCount(0)
})
