/**
 * Tiers 621–625 — a quote says how far it is invoiced; the timer pauses;
 * durations are rounded by the company's rule; a report by employee,
 * customer and project; the invoice e-mail offers the time sheet.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("progress badge, rounding, pause, report and the e-mail's time sheet", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t621-${Date.now()}`
  const email = `${tag}@example.test`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email, password: "Tier621-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const customerName = `${tag} Kunde`
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: customerName, type: "business", defaultHourlyRate: 80, address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date())
  const quote = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, type: "QU", issueDate: today, dueDate: "2099-01-31", items: [{ description: "Lizenz", quantity: 10, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  const itemId: string = quote.items[0].id
  const convert = (data: object) => request.post(`${API}/api/v1/invoices/${quote.id}/convert?${q}`, { headers: H, data })
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

  // 621: nothing invoiced → no badge; 4 of 10 → partly; the rest → invoiced
  await page.goto(`/dashboard/invoices/${quote.id}`)
  await expect(page.locator("h1").first()).toHaveText(quote.invoiceNumber, { timeout: 60_000 })
  await expect(page.getByTestId("conversion-progress-INV")).toHaveCount(0)
  expect((await convert({ to: "INV", items: [{ itemId, quantity: 4 }] })).status()).toBe(201)
  await page.reload()
  await expect(page.getByTestId("conversion-progress-INV")).toHaveText("teilweise abgerechnet", { timeout: 60_000 })
  await page.goto("/dashboard/invoices?type=QU")
  await expect(page.getByTestId("row-progress")).toHaveText("teilweise abgerechnet", { timeout: 60_000 })
  expect((await convert({ to: "INV" })).status()).toBe(201)
  await page.reload()
  await expect(page.getByTestId("row-progress")).toHaveText("abgerechnet", { timeout: 60_000 })

  // 624: round to 15 minutes — 0:37 is written as 0:45
  await page.goto("/dashboard/time")
  await expect(page.getByTestId("time-customer").locator("option")).toHaveCount(2, { timeout: 60_000 })
  await expect(page.getByTestId("time-rounding-mode")).toHaveCount(0)
  await page.getByTestId("time-rounding-minutes").selectOption("15")
  await expect(page.getByTestId("time-rounding-mode")).toHaveValue("up")
  await page.getByTestId("time-customer").selectOption(customer.id)
  await page.getByTestId("time-duration").fill("0:37")
  await page.getByTestId("time-description").fill("Gerundet")
  await page.getByTestId("time-save").click()
  const rows = page.getByTestId("time-row")
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("0:45")
  await page.reload()
  await expect(page.getByTestId("time-rounding-minutes")).toHaveValue("15", { timeout: 60_000 })

  // 623: a paused clock stands still
  await page.getByTestId("time-description").fill("Mit Pause")
  await page.getByTestId("time-timer-start").click()
  await expect(page.getByTestId("time-timer")).toHaveAttribute("data-running", "true")
  await page.getByTestId("time-timer-pause").click()
  await expect(page.getByTestId("time-timer-paused")).toHaveText("angehalten")
  await expect(page.getByTestId("time-timer-pause")).toHaveText("Fortsetzen")
  const clock = page.getByTestId("time-timer-clock")
  const frozen = await clock.textContent()
  await page.waitForTimeout(2500) // a running clock would have moved on
  expect(await clock.textContent()).toBe(frozen)
  await page.getByTestId("time-timer-pause").click()
  await expect(page.getByTestId("time-timer-paused")).toHaveCount(0)
  await expect(page.getByTestId("time-timer-pause")).toHaveText("Pause")
  await page.getByTestId("time-timer-stop").click()
  await expect(page.getByTestId("time-timer")).toHaveAttribute("data-running", "false")
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: "Mit Pause" })).toContainText("0:15") // a minute, rounded up to the rule's 15

  // 625: by employee, then by customer
  await page.getByTestId("time-report-toggle").click()
  const reportRows = page.getByTestId("time-report-row")
  await expect(reportRows).toHaveCount(1)
  await expect(reportRows.first()).toContainText(email)
  await expect(reportRows.first()).toContainText("1:00")
  await page.getByTestId("time-report-by-customer").click()
  await expect(reportRows).toHaveCount(2)
  await expect(reportRows.first()).toContainText(customerName)
  await expect(reportRows.first()).toContainText("0:45")
  await expect(page.getByTestId("time-report-total")).toContainText("1:00")
  // 0:45 for the customer at 80 € — the timer's quarter hour has no customer and no rate
  await expect(page.getByTestId("time-report-total")).toContainText(/60,00\s€/)

  // 622: the e-mail of the invoice over these hours offers the time sheet
  await page.getByTestId("time-filter-customer").selectOption(customer.id)
  await page.getByTestId("time-bill").click()
  const title = page.locator("h1").first()
  await expect(title).toHaveText(/^INV-\d{4}-\d{6}$/, { timeout: 60_000 })
  const number = (await title.textContent()) || ""
  await page.getByRole("button", { name: "Per E-Mail senden" }).click()
  const attach = page.getByTestId("email-attach-timesheet")
  await expect(attach).toBeChecked()
  await expect(page.getByText(`Stundennachweis_${number}.pdf`)).toBeVisible()
})
