import { test, expect } from "@playwright/test"
import { getTestEnv } from "./fixtures/test-env"

/**
 * Tier 823 — „Systembetrieb" lists the companies on the installation: the
 * totals, a search by name or an admin's address, one row per company with
 * how it came. A company that is not the operator sees no list.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the operator finds a company on the server by its name and its admin's address", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t823-${Date.now()}`
  const reg = await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier823-e2e", companyName: `${tag} Werkstatt GmbH` },
  })
  expect(reg.status(), "fixture: a company registered").toBe(201)

  const { userId, companyId } = getTestEnv()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId })
  await page.goto("/dashboard/operator")
  const card = page.getByTestId("operator-companies")
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("operator-companies-summary")).toContainText(/\d+ Firmen, davon \d+ aktiv · \d+ Benutzer/, { timeout: 60_000 })
  await expect(page.getByTestId("operator-companies-row").first()).toBeVisible()

  await page.getByTestId("operator-companies-search").fill(`${tag} Werkstatt`)
  const rows = page.getByTestId("operator-companies-row")
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(rows.first()).toContainText(`${tag} Werkstatt GmbH`)
  await expect(rows.first()).toContainText(`${tag}@example.test`)
  await expect(rows.first()).toContainText("Registrierung")
  await expect(rows.first()).toHaveAttribute("data-origin", "registration")

  await page.getByTestId("operator-companies-search").fill(`${tag}@EXAMPLE.test`)
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(rows.first()).toContainText(`${tag} Werkstatt GmbH`)

  await page.getByTestId("operator-companies-search").fill(`${tag}-nobody`)
  await expect(page.getByTestId("operator-companies-empty")).toBeVisible({ timeout: 30_000 })
})
