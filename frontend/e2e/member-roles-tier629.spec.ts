/**
 * Tier 629 — what a member sees who is not the company's administrator.
 *
 * The dashboard hides the cards of pages the member's role cannot open, and
 * a page that is refused says so in words — „erforderlich ist die Rolle
 * Administrator“ — instead of the action's internal name („Unzureichende
 * Berechtigung: company.update“).
 *
 * The role comes from GET /auth/me and the refusal from the API; both are
 * answered here by the test (a real viewer needs an invitation whose token
 * only travels by e-mail). The backend's side is spec 374.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext, locale = "de") {
  const tag = `t629-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier629-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
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
const asRole = (page: Page, role: string) =>
  page.route(/\/api\/v1\/auth\/me(\?|$)/, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), role } })
  })
const ADMIN_ONLY = ["dashboard-card-system-errors", "dashboard-card-invoice-templates", "dashboard-card-settings"]
const ACCOUNTANT_UP = ["dashboard-card-audit", "dashboard-card-activity", "dashboard-card-import"]

test("the administrator's dashboard has every card", async ({ page, request }) => {
  await signIn(page, request)
  await page.goto("/dashboard")
  await expect(page.getByTestId("card-quotes")).toBeVisible({ timeout: 60_000 })
  for (const id of [...ADMIN_ONLY, ...ACCOUNTANT_UP]) await expect(page.getByTestId(id), id).toBeVisible()
})

test("an accountant's dashboard lacks the administrator's cards, a viewer's the accountant's too", async ({ page, request }) => {
  await signIn(page, request)
  await asRole(page, "accountant")
  await page.goto("/dashboard")
  await expect(page.getByTestId("card-quotes")).toBeVisible({ timeout: 60_000 })
  for (const id of ADMIN_ONLY) await expect(page.getByTestId(id), id).toHaveCount(0)
  for (const id of ACCOUNTANT_UP) await expect(page.getByTestId(id), id).toBeVisible()

  await page.unroute(/\/api\/v1\/auth\/me(\?|$)/)
  await asRole(page, "viewer")
  await page.reload()
  await expect(page.getByTestId("card-quotes")).toBeVisible({ timeout: 60_000 })
  for (const id of [...ADMIN_ONLY, ...ACCOUNTANT_UP]) await expect(page.getByTestId(id), id).toHaveCount(0)
  await expect(page.getByTestId("card-time")).toBeVisible()
})

for (const [locale, sentence] of [
  ["de", "Dafür reicht Ihre Rolle in dieser Firma nicht aus — erforderlich ist die Rolle „Administrator“."],
  ["en", 'Your role in this company does not allow this — it takes the role "administrator".'],
  ["zh", '您在该公司的角色无权执行此操作——需要"管理员"角色。'],
] as const) {
  test(`a refused page says which role it takes (${locale})`, async ({ page, request }) => {
    await signIn(page, request, locale)
    await page.route(/\/api\/v1\/invoice-templates(\?|$)/, (route) =>
      route.fulfill({
        status: 403,
        json: { statusCode: 403, error: "Forbidden", message: "Unzureichende Berechtigung: company.update", action: "company.update", requiredRole: "admin", role: "viewer" },
      }),
    )
    await page.goto("/dashboard/invoice-templates")
    await expect(page.getByText(sentence)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/company\.update/)).toHaveCount(0)
  })
}
