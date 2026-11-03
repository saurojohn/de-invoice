/**
 * Tier 789 — a viewer is not offered the GoBD archive.
 *
 * The archive ZIP and the Verfahrensdokumentation contain the audit log, with
 * users and IP addresses; since Tier 779 both need `audit.read`, which a
 * viewer does not have. The accounting page still showed the viewer both
 * links, and the click ended in a 403. A viewer now reads why instead; every
 * other role keeps the links.
 *
 * The role comes from GET /auth/me and is answered by the test, as in
 * member-roles-tier629 (a real viewer needs an invitation whose token only
 * travels by e-mail). The backend's refusal is spec 484.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext, locale = "de") {
  const tag = `t789-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier789-e2e", companyName: `${tag} GmbH` },
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

test("the administrator is offered the archive and the Verfahrensdokumentation", async ({ page, request }) => {
  test.setTimeout(120_000)
  await signIn(page, request)
  await page.goto("/dashboard/accounting")
  const section = page.getByTestId("gobd-archive-section")
  await expect(section.getByTestId("gobd-invoice-count")).toBeVisible({ timeout: 60_000 })
  await expect(section.getByTestId("gobd-zip-link")).toBeVisible()
  await expect(section.getByTestId("gobd-verfahrensdoku-link")).toBeVisible()
  await expect(section.getByTestId("gobd-viewer-note")).toHaveCount(0)
})

for (const [locale, start] of [
  ["de", "Das Archiv und die Verfahrensdokumentation enthalten das Änderungsprotokoll"],
  ["en", "The archive and the procedure documentation contain the change log"],
  ["zh", "归档包和程序说明文档包含修改记录"],
] as const) {
  test(`a viewer reads why, and gets no link (${locale})`, async ({ page, request }) => {
    test.setTimeout(120_000)
    await signIn(page, request, locale)
    await asRole(page, "viewer")
    await page.goto("/dashboard/accounting")
    const section = page.getByTestId("gobd-archive-section")
    await expect(section.getByTestId("gobd-invoice-count")).toBeVisible({ timeout: 60_000 })
    await expect(section.getByTestId("gobd-viewer-note")).toContainText(start)
    await expect(section.getByTestId("gobd-zip-link")).toHaveCount(0)
    await expect(section.getByTestId("gobd-verfahrensdoku-link")).toHaveCount(0)
  })
}

test("an accountant keeps the links", async ({ page, request }) => {
  test.setTimeout(120_000)
  await signIn(page, request)
  await asRole(page, "accountant")
  await page.goto("/dashboard/accounting")
  const section = page.getByTestId("gobd-archive-section")
  await expect(section.getByTestId("gobd-invoice-count")).toBeVisible({ timeout: 60_000 })
  await expect(section.getByTestId("gobd-zip-link")).toBeVisible()
  await expect(section.getByTestId("gobd-viewer-note")).toHaveCount(0)
})
