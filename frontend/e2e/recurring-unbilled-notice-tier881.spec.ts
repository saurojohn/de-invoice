/**
 * Tier 881 — a template saved with a start in the past says which time it
 * will not bill (Tier 535: no catch-up). It was saved without a word.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a start two months back: the form says what is not billed", async ({ page, request }) => {
  const tag = `t881-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier881-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Abo ${tag} GmbH`, type: "business", address: { street: "Weg 1", postalCode: "20095", city: "Hamburg", country: "DE" } },
  })).status()).toBe(201)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-11-20T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10)
  const [y, m, d] = start.split("-")

  await page.goto("/dashboard/recurring-invoices")
  await page.getByTestId("recurring-new-button").click({ timeout: 60_000 })
  await page.getByTestId("recurring-form-name").fill("Wartungsvertrag")
  // the customer list may load after the form opened (then nothing is
  // preselected) — pick it, as a user does (CI run 44716709919: flaky)
  const customerSelect = page.getByTestId("recurring-form-customer")
  await expect(customerSelect.locator("option", { hasText: `Abo ${tag} GmbH` })).toHaveCount(1, { timeout: 30_000 })
  await customerSelect.selectOption({ label: (await customerSelect.locator("option", { hasText: `Abo ${tag} GmbH` }).textContent())!.trim() })
  await page.getByTestId("recurring-form-day-of-month").fill("1")
  await page.getByTestId("recurring-form-start-date").fill(start)
  await page.getByTestId("recurring-item-description").first().fill("Wartung")
  await page.getByTestId("recurring-item-unit-price").first().fill("200")
  await page.getByTestId("recurring-form-save").click()

  await expect(page.getByTestId("recurring-card")).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByText(`Die Zeit vom ${d}.${m}.${y} bis`)).toBeVisible()
  await expect(page.getByText(/die erste Rechnung entsteht am \d\d\.\d\d\.\d{4}/)).toBeVisible()
})
