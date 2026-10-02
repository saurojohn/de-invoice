/**
 * Tier 502 — a company car is recorded in the settings, and its private use
 * shows up (1 % of the list price per month, VAT on 80 % of it).
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("a company car is added in the settings and its private use is summed", async ({ page, request }) => {
  const tag = `t502-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier502-e2e", companyName: `${tag} Handel` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H, data: { rechtsform: "Einzelunternehmen" },
  })

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
  const card = page.getByTestId("company-cars-card")
  await expect(card).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")

  const year = new Date().getFullYear()
  await card.getByTestId("company-car-name").fill("M-AB 123")
  await card.getByTestId("company-car-price").fill("45.678,00")
  await card.getByTestId("company-car-from").fill(`${year}-01-01`)
  await card.getByTestId("company-car-add").click()

  await expect(card.getByTestId("company-car-row")).toHaveCount(1, { timeout: 30_000 })
  await expect(card.getByTestId("company-car-row")).toContainText("M-AB 123")
  // January to the current month: 1 % of 45 600 € = 456 €, VAT 69,31 € each
  const months = new Date().getMonth() + 1
  const fmt = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  await expect(card.getByTestId("company-cars-summary")).toContainText(fmt(456 * months))
  await expect(card.getByTestId("company-cars-summary")).toContainText(fmt(Math.round(69.31 * months * 100) / 100))

  const cars = await (await request.get(`${API}/api/v1/company-cars?companyId=${companyId}`, { headers: H })).json()
  expect(cars.length).toBe(1)
  expect(Number(cars[0].listPrice)).toBe(45678)
})
