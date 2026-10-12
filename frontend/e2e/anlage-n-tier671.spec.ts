/**
 * Tier 671 — Anlage N: the Pauschbetrag instead of the expenses, not on top;
 * Sonderausgaben are not part of the income from employment.
 *
 * Before: 40 000 € of wages with 2 000 € of commuting showed 3 230 € of
 * Werbungskosten, and 3 000 € of Sonderausgaben were taken off the
 * „Einkünfte aus nichtselbständiger Arbeit“ as well (33 770 € instead of
 * 38 000 €). The hints named 0,30 EUR and „ab 1% Brutto“.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
// the form opens on last year
const Y = new Date().getFullYear() - 1

test("40 000 € of wages, 2 000 € of commuting, 3 000 € of Sonderausgaben: 38 000 € of income", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  test.setTimeout(240_000)
  const tag = `t671-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier671-e2e", companyName: `${tag} Einzelunternehmen` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const put = await request.put(`${API}/api/v1/accounting/anlage-n/settings?companyId=${companyId}`, {
    headers: { "x-user-id": userId, "x-company-id": companyId },
    data: { year: Y, bruttoArbeitslohn: 40000, lohnsteuer: 6000, werbungskosten: { "140": 2000 }, sonderausgaben: { "200": 3000 } },
  })
  expect(put.ok()).toBe(true)
  await page.context().clearCookies()
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
  await page.goto("/dashboard/accounting")
  const wk = page.getByTestId("anlage-n-werbungskosten-table")
  await expect(wk).toBeVisible({ timeout: 120_000 })

  // the Pauschbetrag gives way to the higher expenses
  await expect(page.getByTestId("anlage-n-130")).toContainText("0,00")
  await expect(page.getByTestId("anlage-n-130")).toContainText("statt der Werbungskosten")
  await expect(page.getByTestId("anlage-n-140")).toContainText("2.000,00")
  await expect(page.getByTestId("anlage-n-wk-hint")).toContainText("§ 9a EStG")
  // the income: wages less Werbungskosten — the Sonderausgaben below are for information
  await expect(page.getByTestId("anlage-n-einkuenfte")).toContainText("38.000,00")
  await expect(page.getByTestId("anlage-n-sonderausgaben-table")).toContainText("3.000,00")
  await expect(page.getByTestId("anlage-n-sa-hint")).toContainText("mindern nicht die Einkünfte aus nichtselbständiger Arbeit")
})
