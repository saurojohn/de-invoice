/**
 * Tier 930 — the invoice form says when the Leistungsdatum is more than a
 * year from the invoice date: it decides the VAT period, a typo moved the tax.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
test("a Leistungsdatum two years back is pointed out, one of this month is not", async ({ page, request }) => {
  const tag = `t930-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier930-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
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
  await page.goto("/dashboard/invoices/create")
  const delivery = page.getByTestId("invoice-delivery-date")
  await expect(delivery).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("invoice-supply-far")).toHaveCount(0)
  const year = new Date().getFullYear() - 2
  // the form sets its defaults (Leistungsdatum today) once it has loaded — a
  // value typed before that is overwritten (CI, run 45055259681: flaky), so
  // the date is entered until it stays
  await expect(async () => {
    await delivery.fill(`${year}-06-15`)
    await expect(page.getByTestId("invoice-supply-far")).toContainText(`06/${year}`, { timeout: 1_000 })
  }).toPass({ timeout: 30_000 })
})
