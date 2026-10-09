/**
 * Tier 611 — time tracking (Zeiterfassung).
 *
 * Hours are written down on /dashboard/time, with a customer and a rate; the
 * page sums what is open and bills a customer's open hours into an invoice
 * draft. A billed entry names its invoice and can no longer be changed.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("hours are logged, summed and billed into an invoice draft", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t611-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier611-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const customerName = `${tag} Kunde`
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: customerName, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
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

  // the dashboard leads there
  await page.goto("/dashboard")
  await page.getByTestId("card-time").click({ timeout: 60_000 })
  await expect(page).toHaveURL(/\/dashboard\/time$/)
  await expect(page.getByTestId("time-empty")).toBeVisible({ timeout: 60_000 })
  const save = page.getByTestId("time-save")
  await expect(save).toBeDisabled()

  // a duration that is none
  await page.getByTestId("time-duration").fill("abc")
  await page.getByTestId("time-description").fill("Beratung")
  await expect(page.getByTestId("time-duration-hint")).toHaveText("Bitte als 1:30 oder 1,5 angeben — höchstens 24 Stunden.")
  await expect(save).toBeDisabled()

  // 1:30 h at 100 €
  await expect(page.getByTestId("time-customer").locator("option")).toHaveCount(2)
  await page.getByTestId("time-customer").selectOption(customer.id)
  await page.getByTestId("time-duration").fill("1:30")
  await page.getByTestId("time-rate").fill("100")
  await save.click()
  await expect(page.getByTestId("time-row")).toHaveCount(1)
  // the next one keeps day, customer and rate: 50 minutes, written as decimal hours
  await expect(page.getByTestId("time-rate")).toHaveValue("100")
  await page.getByTestId("time-duration").fill("50m")
  await page.getByTestId("time-description").fill("Telefonat")
  await page.getByTestId("time-rate").fill("90")
  await save.click()
  await expect(page.getByTestId("time-row")).toHaveCount(2)
  await expect(page.getByTestId("time-sum-hours")).toHaveText("2:20")
  await expect(page.getByTestId("time-sum-open")).toHaveText("2:20")
  await expect(page.getByTestId("time-sum-amount")).toHaveText(/224,70\s€/)

  // change the second: 60 minutes
  await page.getByTestId("time-row").filter({ hasText: "Telefonat" }).getByTestId("time-row-edit").click()
  await expect(page.getByTestId("time-duration")).toHaveValue("0:50")
  await page.getByTestId("time-duration").fill("1")
  await save.click()
  await expect(page.getByTestId("time-sum-amount")).toHaveText(/240,00\s€/)

  // bill the customer's open hours
  await expect(page.getByTestId("time-bill")).toHaveCount(0)
  await page.getByTestId("time-filter-customer").selectOption(customer.id)
  await expect(page.getByTestId("time-bill")).toHaveText(/2 offene Einträge abrechnen \(240,00\s€\)/)
  await page.getByTestId("time-bill").click()
  await expect(page.locator("h1").first()).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  await expect(page.getByText("Beratung").first()).toBeVisible()
  await expect(page.getByText("Telefonat").first()).toBeVisible()
  const invoiceNumber = (await page.locator("h1").first().textContent()) || ""

  // back: nothing open, both billed and naming the invoice, no edit
  await page.goto("/dashboard/time")
  await expect(page.getByTestId("time-empty")).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("time-state-billed").click()
  await expect(page.getByTestId("time-row")).toHaveCount(2)
  await expect(page.getByTestId("time-row-state").first()).toHaveText(invoiceNumber)
  await expect(page.getByTestId("time-row-edit")).toHaveCount(0)
  await expect(page.getByTestId("time-sum-amount")).toHaveText(/0,00\s€/)

  // in English
  await page.addInitScript(() => localStorage.setItem("locale", "en"))
  await page.reload()
  await expect(page.locator("h1").first()).toHaveText("Time tracking", { timeout: 60_000 })
  await expect(page.getByTestId("time-state-billed")).toHaveText("Billed")
})
