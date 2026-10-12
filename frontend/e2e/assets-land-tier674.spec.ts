/**
 * Tier 674 — land is not depreciated.
 *
 * Before: the form would not save a „Grundstück“ without a useful life, and
 * the list showed AfA on it — 2 000 € a year on a plot of 100 000 €.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a plot of land: no useful life to enter, no AfA, the book value stays the cost", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  test.setTimeout(240_000)
  const tag = `t674-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier674-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
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
  await page.goto("/dashboard/assets")
  await page.getByTestId("assets-new").click()
  const life = page.getByTestId("assets-draft-nd")
  await expect(life).toBeEnabled()
  await page.getByTestId("assets-draft-type").selectOption("Grundstueck")
  await expect(life).toBeDisabled()
  await expect(page.getByTestId("assets-draft-land-hint")).toContainText("wird nicht abgeschrieben")
  await page.getByTestId("assets-draft-bez").fill("Bauplatz Hafenweg")
  await page.getByTestId("assets-draft-datum").fill("2024-01-15")
  await page.getByTestId("assets-draft-ak").fill("100000")
  const created = page.waitForResponse((r) => r.url().includes("/api/v1/assets") && r.request().method() === "POST")
  await page.getByTestId("assets-draft-save").click()
  expect((await created).status()).toBe(201)

  const row = page.getByTestId("assets-table").locator("tbody tr").first()
  await expect(row).toContainText("Bauplatz Hafenweg")
  await expect(row).toContainText("—")
  // nothing is written off: the total book value is the cost, the year's AfA nothing
  await expect(page.getByTestId("assets-total-ahk")).toContainText("100.000,00")
  await expect(page.getByTestId("assets-total-buchwert")).toContainText("100.000,00")
  await expect(page.getByTestId("assets-total-annual-afa")).toContainText("0,00")
  await expect(page.getByTestId("assets-total-annual-afa")).not.toContainText("2.000")
})
