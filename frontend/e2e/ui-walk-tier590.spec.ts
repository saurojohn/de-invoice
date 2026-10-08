/**
 * Tier 590 — what a walk through every page turned up.
 *
 * - /dashboard/assets and /dashboard/berater were finished pages without a
 *   link anywhere in the application; the dashboard has a card for each now.
 * - The accounting page showed the raw key "common.invoices", the settings
 *   page five raw keys "settings.datevAccount_…" (the translations were
 *   missing in all three languages).
 * - The company form's placeholders were the first operator's own data.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext) {
  const tag = `t590-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier590-e2e", companyName: `${tag} GmbH` },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("the fixed-asset register and the adviser's documents can be reached from the dashboard", async ({ page, request }) => {
  await signIn(page, request)
  await page.goto("/dashboard")
  await expect(page.getByTestId("card-assets")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("card-assets")).toContainText("Anlagenverzeichnis")
  await page.getByTestId("card-assets").click()
  await expect(page).toHaveURL(/\/dashboard\/assets$/, { timeout: 60_000 })
  await page.goto("/dashboard")
  await expect(page.getByTestId("card-berater")).toContainText("Steuerberater", { timeout: 60_000 })
  await page.getByTestId("card-berater").click()
  await expect(page).toHaveURL(/\/dashboard\/berater$/, { timeout: 60_000 })
})

test("no raw translation key on the accounting and settings pages, in any language", async ({ page, request }) => {
  await signIn(page, request)
  for (const locale of ["de", "en", "zh"]) {
    await page.addInitScript((l: string) => localStorage.setItem("locale", l), locale)
    await page.goto("/dashboard/settings")
    await page.waitForLoadState("networkidle")
    const settings = await page.locator("body").innerText()
    expect(settings, `settings page (${locale})`).not.toMatch(/settings\.datevAccount_/)
    expect(settings, `settings page (${locale}): the five accounts have a name`).toContain("(8921)")
    await page.goto("/dashboard/accounting")
    await page.waitForLoadState("networkidle")
    const accounting = await page.locator("body").innerText()
    expect(accounting, `accounting page (${locale})`).not.toMatch(/\bcommon\.[a-zA-Z]+/)
  }
})

test("the company form's placeholders are nobody's real data", async ({ page, request }) => {
  await signIn(page, request)
  await page.goto("/dashboard/settings")
  await page.waitForLoadState("networkidle")
  const placeholders = await page.locator("input[placeholder], textarea[placeholder]").evaluateAll((els) => els.map((e) => e.getAttribute("placeholder") || ""))
  expect(placeholders.length).toBeGreaterThan(5)
  expect(placeholders.join(" | ")).not.toMatch(/shleder|Offenbach|6181/i)
})
