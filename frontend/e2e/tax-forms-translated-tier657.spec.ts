/**
 * Tier 657 — the tax previews in the language of the interface.
 *
 * The backend writes the forms in German. With the interface in Chinese the
 * accounting page carried 1 228 German words, 1 163 of them the previews'
 * labels, notes and closing texts. A label keeps its official German
 * designation and gets its meaning underneath; notes, closing texts and
 * column headings are shown in the language of the interface.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function open(page: Page, request: APIRequestContext, locale: string) {
  const tag = `t657-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier657-e2e", companyName: "Tier657 Handel GmbH" },
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
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("gewst-hebesatz")).toBeVisible({ timeout: 120_000 })
}

test("Chinese: the German designation with its meaning, the notes in Chinese", async ({ page, request }) => {
  test.setTimeout(240_000)
  await open(page, request, "zh")
  // a line of the balance sheet: the German label stays, its meaning is underneath
  const line = page.locator("td", { hasText: "Forderungen aus Lieferungen und Leistungen" }).first()
  await expect(line).toBeVisible({ timeout: 60_000 })
  await expect(line.locator("[data-form-gloss]")).toHaveText("应收账款")
  // the closing text of the trade tax preview, and a column heading
  await expect(page.getByText("本预览根据 Anlage G 的计算", { exact: false }).first()).toBeVisible()
  await expect(page.getByText("Diese Vorschau wurde automatisch aus der Anlage-G-Berechnung", { exact: false })).toHaveCount(0)
  await expect(page.getByRole("columnheader", { name: "名称" }).first()).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Bezeichnung" })).toHaveCount(0)
  // many labels have their meaning
  expect(await page.locator("[data-form-gloss]").count()).toBeGreaterThan(80)
})

test("English: the same in English; German: nothing added", async ({ page, request }) => {
  test.setTimeout(240_000)
  await open(page, request, "en")
  const line = page.locator("td", { hasText: "Forderungen aus Lieferungen und Leistungen" }).first()
  await expect(line.locator("[data-form-gloss]")).toHaveText("Trade receivables", { timeout: 60_000 })
  await expect(page.getByText("This preview was generated automatically from the Anlage G computation", { exact: false }).first()).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Description" }).first()).toBeVisible()

  await open(page, request, "de")
  await expect(page.locator("td", { hasText: "Forderungen aus Lieferungen und Leistungen" }).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator("[data-form-gloss]")).toHaveCount(0)
  await expect(page.getByRole("columnheader", { name: "Bezeichnung" }).first()).toBeVisible()
})
