/**
 * Tiers 616–618 — time tracking: default rates, projects, the timer, the
 * time sheet.
 *
 * The customer form has a default hourly rate; the time page prefills it,
 * a project's own rate goes before it, a typed rate stays. Projects are
 * managed on the page and show what is logged against their budget. The
 * timer survives a reload, and stopping it writes the entry. The time sheet
 * comes as a PDF — from the page, and from the invoice the hours were
 * billed with.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("default rate, project, timer and time sheet", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t616-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier616-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const stored = async () => (await (await request.get(`${API}/api/v1/customers/${customer.id}?${q}`, { headers: H })).json()).defaultHourlyRate
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

  // the customer form: a default rate of 80
  await page.goto("/dashboard/customers")
  await page.getByTestId("customer-edit-button").first().click({ timeout: 60_000 })
  const rateField = page.getByTestId("customer-default-hourly-rate")
  await expect(rateField).toHaveValue("")
  await rateField.fill("80")
  await page.locator('form button[type="submit"]').click()
  await expect(rateField).toBeHidden({ timeout: 30_000 })
  expect(Number(await stored())).toBe(80)

  // the time page prefills it
  await page.goto("/dashboard/time")
  await expect(page.getByTestId("time-customer").locator("option")).toHaveCount(2, { timeout: 60_000 })
  await page.getByTestId("time-customer").selectOption(customer.id)
  const rate = page.getByTestId("time-rate")
  await expect(rate).toHaveValue("80")

  // a project with its own rate and a budget of one hour
  await page.getByTestId("time-projects-toggle").click()
  await page.getByTestId("time-project-name").fill("Wartung")
  await page.getByTestId("time-project-customer").selectOption(customer.id)
  await page.getByTestId("time-project-rate").fill("120")
  await page.getByTestId("time-project-budget").fill("1")
  await page.getByTestId("time-project-add").click()
  const projectRow = page.getByTestId("time-project-row")
  await expect(projectRow).toHaveCount(1)
  await expect(projectRow.getByTestId("time-project-logged")).toHaveText("0:00 / 1:00")
  await expect(projectRow.getByTestId("time-project-delete")).toBeVisible()

  // choosing it brings its rate; a typed rate stays when the project goes
  await page.getByTestId("time-project").selectOption({ label: "Wartung" })
  await expect(rate).toHaveValue("120")
  await rate.fill("95")
  await page.getByTestId("time-project").selectOption("")
  await expect(rate).toHaveValue("95")
  await page.getByTestId("time-project").selectOption({ label: "Wartung" })
  await expect(rate).toHaveValue("95")

  // 1:30 on the project at 95 €: over the budget
  await page.getByTestId("time-duration").fill("1:30")
  await page.getByTestId("time-description").fill("Beratung")
  await page.getByTestId("time-save").click()
  const rows = page.getByTestId("time-row")
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByTestId("time-row-project")).toHaveText("Wartung")
  await expect(rows.first().getByTestId("time-row-amount")).toHaveText(/142,50\s€/)
  await expect(projectRow.getByTestId("time-project-logged")).toHaveText("1:30 / 1:00")
  await expect(projectRow.getByTestId("time-project-logged")).toHaveClass(/text-red-600/)
  await expect(projectRow.getByTestId("time-project-delete")).toHaveCount(0)

  // the timer: started, still running after a reload, stopped into an entry
  const timer = page.getByTestId("time-timer")
  await expect(timer).toHaveAttribute("data-running", "false")
  await page.getByTestId("time-description").fill("Timerlauf")
  await page.getByTestId("time-timer-start").click()
  await expect(timer).toHaveAttribute("data-running", "true")
  await expect(page.getByTestId("time-timer-clock")).toHaveText(/^0:00:0\d$/)
  await page.reload()
  await expect(page.getByTestId("time-timer")).toHaveAttribute("data-running", "true", { timeout: 60_000 })
  await expect(page.getByTestId("time-description")).toHaveValue("Timerlauf")
  await expect(page.getByTestId("time-project")).toHaveValue(/.+/)
  // …and with the project the rate an hour on it costs
  await expect(page.getByTestId("time-rate")).toHaveValue("120")
  await page.getByTestId("time-timer-stop").click()
  await expect(page.getByTestId("time-timer")).toHaveAttribute("data-running", "false")
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: "Timerlauf" })).toContainText("0:01")

  // the time sheet of the list
  const [sheet] = await Promise.all([page.waitForEvent("download"), page.getByTestId("time-timesheet").click()])
  expect(sheet.suggestedFilename()).toBe("Stundennachweis.pdf")

  // billed: the invoice offers the time sheet of its hours
  await page.getByTestId("time-filter-customer").selectOption(customer.id)
  await expect(page.getByTestId("time-bill")).toHaveText(/2 offene Einträge abrechnen/)
  await page.getByTestId("time-bill").click()
  const title = page.locator("h1").first()
  await expect(title).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  const number = (await title.textContent()) || ""
  await expect(page.getByText("Wartung: Beratung").first()).toBeVisible()
  const [ofInvoice] = await Promise.all([page.waitForEvent("download"), page.getByTestId("invoice-download-timesheet").click()])
  expect(ofInvoice.suggestedFilename()).toBe(`Stundennachweis_${number}.pdf`)
})
