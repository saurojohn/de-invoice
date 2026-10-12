/**
 * Tier 672 — Anlage Kind: Kindergeld by the month, the Freibeträge per parent
 * and month, and children by their age.
 *
 * Before: a child of nine and one born in August gave 500 € of Kindergeld for
 * the year (a month's 250 € each) and 15 864 € of „Kinderfreibetrag“, with a
 * „Net (FB - KG)“ under it; a 35-year-old in the list counted like them.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
// the form opens on last year
const Y = new Date().getFullYear() - 1

test("two children count — one for the months since its birth — and a grown-up does not", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  test.setTimeout(240_000)
  const tag = `t672-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier672-e2e", companyName: `${tag} Einzelunternehmen` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const put = await request.put(`${API}/api/v1/accounting/anlage-kind/settings?companyId=${companyId}`, {
    headers: H,
    data: {
      year: Y,
      kinder: [
        { name: "Anna", birthDate: `${Y - 9}-03-10`, kindergeldEligible: true },
        { name: "Ben", birthDate: `${Y}-08-20`, kindergeldEligible: true },
        { name: "Clara", birthDate: `${Y - 35}-01-05`, kindergeldEligible: true },
      ],
    },
  })
  expect(put.ok()).toBe(true)
  // what the form has to show, from the amounts of that year
  const api = await (await request.get(`${API}/api/v1/accounting/anlage-kind?companyId=${companyId}&year=${Y}`, { headers: H })).json()
  const monthly: number = api.saetze.kindergeld[0]
  expect(api.totals.kindermonate).toBe(17)
  expect(api.totals.kindergeldTotal).toBe(17 * monthly)
  const eur = (n: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n)

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
  const summary = page.getByTestId("anlage-kind-summary")
  await expect(summary).toBeVisible({ timeout: 120_000 })

  const children = page.getByTestId("anlage-kind-child")
  await expect(children).toHaveCount(3)
  await expect(children.nth(0)).toContainText("12 Monat(e)")
  await expect(children.nth(1)).toContainText("5 Monat(e)")
  await expect(children.nth(2)).toContainText("nicht berücksichtigt: das 25. Lebensjahr vollendet")
  await expect(page.getByTestId("anlage-kind-kinder-summary")).toContainText("berücksichtigt: 2")

  await expect(summary).toContainText("2 Kind(er) berücksichtigt")
  await expect(summary).toContainText(eur(17 * monthly))
  await expect(summary).not.toContainText("Net (FB - KG)")
  await expect(page.getByTestId("anlage-kind-guenstiger")).toContainText("nicht zusammen gewährt")

  // assessed together: the Freibeträge double, the Kindergeld stays
  const single: number = api.totals.freibetragTotal
  await expect(summary).toContainText(eur(single))
  const saved = page.waitForResponse((r) => r.url().includes("/accounting/zusammenveranlagung") && r.request().method() === "PUT" && r.ok())
  await page.getByTestId("anlage-kind-zusammen").check()
  await saved
  await expect(summary).toContainText(eur(single * 2))
  await expect(summary).toContainText(eur(17 * monthly))
  // the one choice holds for Anlage KAP as well
  await page.reload()
  await expect(page.getByTestId("anlage-kind-summary")).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId("anlage-kind-zusammen")).toBeChecked()
  await expect(page.getByTestId("anlage-kap-zusammen")).toBeChecked()
})
