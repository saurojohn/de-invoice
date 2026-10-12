/**
 * Tier 676 — Anlage AUS: a treaty does not mean exemption; § 8b KStG follows
 * the holding.
 *
 * Before: a GmbH's dividend from a treaty country was 95 % free whatever the
 * holding, its interest "exempt with Progressionsvorbehalt"; nothing in the
 * editor said which method an entry got.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
// the form opens on last year
const Y = new Date().getFullYear() - 1

test("a GmbH: interest is credited, a dividend is § 8b only with the holding ticked", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  test.setTimeout(240_000)
  const tag = `t676-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier676-e2e", companyName: `${tag} Handel GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const entry = (incomeType: string, grossAmount: number, foreignTaxPaid: number) =>
    ({ country: "US", countryName: "USA", hasDba: true, incomeType, grossAmount, foreignTaxPaid, description: incomeType })
  const put = await request.put(`${API}/api/v1/accounting/anlage-aus/settings?companyId=${companyId}`, {
    headers: { "x-user-id": userId, "x-company-id": companyId },
    data: { year: Y, entries: [entry("dividend", 10000, 1500), entry("interest", 400, 0)] },
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
  const editor = page.getByTestId("anlage-aus-entries-editor")
  await expect(editor.locator("tbody tr")).toHaveCount(2, { timeout: 120_000 })
  const applied = editor.getByTestId("anlage-aus-applied")
  // both taxable with credit: no holding of 10 % entered, and interest is never exempted by the usual treaty
  await expect(applied.nth(0)).toHaveAttribute("data-methode", "anrechnung")
  await expect(applied.nth(1)).toHaveAttribute("data-methode", "anrechnung")
  await expect(page.getByTestId("anlage-aus-summary-taxable")).toContainText("10.400,00")
  await expect(page.getByTestId("anlage-aus-summary-progression")).toContainText("0,00")
  await expect(page.getByTestId("anlage-aus-20")).toContainText("mindestens 10 % zu Beginn des Kalenderjahres")

  // the holding is 10 % or more: § 8b — 5 % taxable, and the interest as before
  const holding = editor.getByTestId("anlage-aus-beteiligung")
  await expect(holding).toHaveCount(1)
  await holding.check()
  const saved = page.waitForResponse((r) => r.url().includes("/accounting/anlage-aus/settings") && r.request().method() === "PUT" && r.ok())
  await page.getByTestId("anlage-aus-save").click()
  await saved
  await expect(applied.nth(0)).toHaveAttribute("data-methode", "paragraph8b")
  await expect(applied.nth(0)).toContainText("§ 8b KStG")
  await expect(page.getByTestId("anlage-aus-summary-taxable")).toContainText("900,00")
  await expect(page.getByTestId("anlage-aus-20")).toContainText("500,00")
})
