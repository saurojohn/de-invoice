/**
 * Tier 659 — the German texts that were written into the pages themselves
 * follow the language of the interface.
 *
 * Before: "Unbezahlte Rechnungen" on the dashboard, "Top 5 Kunden YTD" and
 * "Letzte Aktivität" on /dashboard/v2, "Mär 26" under every chart and
 * "Schließen" on every dialog stayed German in English and in Chinese.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: APIRequestContext, locale: string) {
  const tag = `t659-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier659-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().clearCookies()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId, locale }: { userId: string; companyId: string; locale: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", locale)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId, locale },
  )
}

test("Chinese: the dashboards, the reminder tokens and the months", async ({ page, request }) => {
  test.setTimeout(240_000)
  await signIn(page, request, "zh")
  await page.goto("/dashboard")
  await expect(page.getByText("未付发票").first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText("Unbezahlte Rechnungen")).toHaveCount(0)
  await expect(page.getByText("营业额与支出走势（最近 12 个月）")).toBeVisible()
  // the months under the chart
  await expect(page.getByText(/^Mär \d\d$/)).toHaveCount(0)

  await page.goto("/dashboard/v2")
  await expect(page.getByText("本年度前 5 名客户")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText("最近动态")).toBeVisible()
  for (const german of ["Top 5 Kunden YTD", "Letzte Aktivität", "Netto-Summe", "nicht bezahlt"]) {
    await expect(page.getByText(german, { exact: true }), german).toHaveCount(0)
  }

  // the tokens of a reminder text: named in Chinese, and the new ones are there
  await page.goto("/dashboard/mahnungen/templates")
  await expect(page.getByText("未付金额", { exact: true }).first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText("发票币种")).toBeVisible()
  await expect(page.getByText("Kundenname", { exact: true })).toHaveCount(0)
})

test("English is English, German is as it was", async ({ page, request }) => {
  test.setTimeout(240_000)
  await signIn(page, request, "en")
  await page.goto("/dashboard")
  await expect(page.getByText("Unpaid invoices").first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText("Revenue and expenses (last 12 months)")).toBeVisible()

  await signIn(page, request, "de")
  await page.goto("/dashboard")
  await expect(page.getByText("Unbezahlte Rechnungen").first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText("Umsatz- und Aufwandsentwicklung (letzte 12 Monate)")).toBeVisible()
})
