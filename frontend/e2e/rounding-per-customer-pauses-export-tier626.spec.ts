/**
 * Tiers 626–628 — a customer's and a project's own rounding rule; the pauses
 * of a timer on the entry; the hours report as a CSV.
 */
import { readFileSync } from "fs"
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("whose rounding rule, pauses on the entry, the report as a file", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t626-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier626-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const stored = async () => {
    const c = await (await request.get(`${API}/api/v1/customers/${customer.id}?${q}`, { headers: H })).json()
    return `${c.timeRoundingMinutes}/${c.timeRoundingMode}`
  }
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

  // 626: the customer's own rule — 15 minutes, up
  await page.goto("/dashboard/customers")
  await page.getByTestId("customer-edit-button").first().click({ timeout: 60_000 })
  const rule = page.getByTestId("customer-time-rounding")
  await expect(rule).toHaveValue("")
  await expect(page.getByTestId("customer-time-rounding-mode")).toHaveCount(0)
  await rule.selectOption("15")
  await expect(page.getByTestId("customer-time-rounding-mode")).toHaveValue("up")
  await page.locator('form button[type="submit"]').click()
  await expect(rule).toBeHidden({ timeout: 30_000 })
  expect(await stored()).toBe("15/up")

  // the company rounds nothing; the customer's 0:37 becomes 0:45
  await page.goto("/dashboard/time")
  await expect(page.getByTestId("time-customer").locator("option")).toHaveCount(2, { timeout: 60_000 })
  await expect(page.getByTestId("time-rounding-minutes")).toHaveValue("0")
  await page.getByTestId("time-customer").selectOption(customer.id)
  await page.getByTestId("time-duration").fill("0:37")
  await page.getByTestId("time-description").fill("Nach Kundenregel")
  await page.getByTestId("time-save").click()
  const rows = page.getByTestId("time-row")
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("0:45")

  // a project with a rule of its own: 30 minutes, to the nearest — 0:37 becomes 0:30
  await page.getByTestId("time-projects-toggle").click()
  await page.getByTestId("time-project-name").fill("Halbe Stunden")
  await page.getByTestId("time-project-customer").selectOption(customer.id)
  await page.getByTestId("time-project-rounding").selectOption("30")
  await page.getByTestId("time-project-rounding-mode").selectOption("nearest")
  await page.getByTestId("time-project-add").click()
  await expect(page.getByTestId("time-project-rounding-own")).toHaveText("Rundung: 30 Min., kaufmännisch")
  await page.getByTestId("time-project").selectOption({ label: "Halbe Stunden" })
  await page.getByTestId("time-duration").fill("0:37")
  await page.getByTestId("time-description").fill("Nach Projektregel")
  await page.getByTestId("time-save").click()
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: "Nach Projektregel" })).toContainText("0:30")

  // 627: a timer with a pause leaves it on the entry
  await page.getByTestId("time-description").fill("Mit einer Pause")
  await page.getByTestId("time-timer-start").click()
  await expect(page.getByTestId("time-timer")).toHaveAttribute("data-running", "true")
  await page.getByTestId("time-timer-pause").click()
  await expect(page.getByTestId("time-timer-paused")).toBeVisible()
  await page.getByTestId("time-timer-pause").click()
  await expect(page.getByTestId("time-timer-paused")).toHaveCount(0)
  await page.getByTestId("time-timer-stop").click()
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: "Mit einer Pause" }).getByTestId("time-row-pauses")).toHaveText("1 Pause(n) · 0:00")
  await expect(rows.filter({ hasText: "Nach Kundenregel" }).getByTestId("time-row-pauses")).toHaveCount(0)

  // 628: the report as a CSV
  await page.getByTestId("time-report-toggle").click()
  await expect(page.getByTestId("time-report-row")).toHaveCount(1)
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("time-report-csv").click()])
  expect(file.suggestedFilename()).toMatch(/^Zeitauswertung_user_\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.csv$/)
  const path = await file.path()
  const text = readFileSync(path, "utf8")
  expect(text.split("\n")[0].replace(/^\uFEFF/, "")).toBe("Mitarbeiter;Einträge;Stunden;davon abrechenbar;davon abgerechnet;davon offen;abgerechnet EUR;offen EUR")
  expect(text).toContain(`${tag}@example.test;3;`)
  expect(text.trimEnd().split("\n").pop()).toMatch(/^Summe;3;/)
})
