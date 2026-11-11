import { test, expect } from "@playwright/test"
import { getTestEnv } from "./fixtures/test-env"

/**
 * Tier 831 — „Kurzanleitung": the daily work step by step, each section with
 * the page it is about, in the page's language; the operator's section for
 * the operator only. And the UStVA's button says what it does: it records
 * the return as submitted („Als übermittelt erfassen") — „An Finanzamt
 * übermitteln" promised a transmission nothing in the product makes.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: import("@playwright/test").Page, userId: string, companyId: string, locale = "de") {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId, locale }: { userId: string; companyId: string; locale: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("locale", locale)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId, locale })
}

test("the guide: from the dashboard, seven sections with their pages; the operator's for the operator", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t831-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier831-e2e", companyName: `${tag} GmbH` },
  })).json()
  await signIn(page, reg.user.id, reg.user.companyId || reg.company.id)
  await page.goto("/dashboard")
  await page.getByTestId("dashboard-card-help").click({ timeout: 90_000 })
  await expect(page).toHaveURL(/\/dashboard\/help$/, { timeout: 60_000 })
  await expect(page.getByRole("heading", { name: "Kurzanleitung" })).toBeVisible({ timeout: 60_000 })
  for (const [id, href] of [
    ["start", "/dashboard/settings"], ["invoice", "/dashboard/invoices/create"], ["expense", "/dashboard/expenses"],
    ["bank", "/dashboard/bank-import"], ["dunning", "/dashboard/invoices?status=overdue"],
    ["month", "/dashboard/accounting/ustva"], ["adviser", "/dashboard/reports"],
  ]) {
    await expect(page.getByTestId(`help-link-${id}`)).toHaveAttribute("href", href)
    expect(await page.getByTestId(`help-${id}`).locator("li").count(), `steps of ${id}`).toBeGreaterThan(0)
  }
  await expect(page.locator("body")).not.toContainText("help.sections")
  await expect(page.getByTestId("help-month")).toContainText("Als übermittelt erfassen")
  // not the operator: no operator section
  await page.waitForLoadState("networkidle")
  await expect(page.getByTestId("help-operator")).toHaveCount(0)
})

test("the guide in Chinese, the operator's section for the operator; the UStVA button records, it does not transmit", async ({ page }) => {
  test.setTimeout(180_000)
  const { userId, companyId } = getTestEnv()
  await signIn(page, userId, companyId, "zh")
  await page.goto("/dashboard/help")
  await expect(page.getByTestId("help-operator")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("help-start")).toContainText("设置公司")
  await expect(page.getByTestId("help-bank")).toContainText("生成自动建议")
  // (the page stays in Chinese: „记录为已提交" — record as submitted)
  await page.goto("/dashboard/accounting/ustva")
  await expect(page.getByTestId("ustva-submit")).toHaveText("记录为已提交", { timeout: 90_000 })
})
