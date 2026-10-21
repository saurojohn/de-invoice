/**
 * Tier 725 — the new-invoice form names the invoice's currency in the price
 * column and the discount amount (they said „(€)“ on a USD invoice; the
 * summary below was already in USD).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("USD chosen: „Einzelpreis (USD)“, „Rabattbetrag (USD)“", async ({ page, request }) => {
  const tag = `t725-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier725-e2e", companyName: `${tag} GmbH` },
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
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-21T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/invoices/create")
  await expect(page.getByTestId("items-unit-price-label")).toHaveText("Einzelpreis (€)", { timeout: 60_000 })
  await page.getByTestId("invoice-currency").selectOption("USD")
  await expect(page.getByTestId("items-unit-price-label")).toHaveText("Einzelpreis (USD)")
  await expect(page.getByTestId("discount-amount-label")).toHaveText("Rabattbetrag (USD)")
})
