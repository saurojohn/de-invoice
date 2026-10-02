/**
 * Tier 504 — the home office is recorded per year in the settings and
 * reaches the EÜR as a Betriebsausgabe.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("the home office is recorded in the settings and reaches the EÜR", async ({ page, request }) => {
  const tag = `t504-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier504-e2e", companyName: `${tag} Beratung` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H, data: { rechtsform: "Einzelunternehmen" },
  })

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/settings")
  const card = page.getByTestId("home-office-card")
  await expect(card).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  // an empty year loads without an error
  await expect(card).not.toContainText(/konnte nicht|could not|无法/)

  await card.getByTestId("home-office-days").fill("150")
  await card.getByTestId("home-office-save").click()
  // 150 × 6 € = 900 €
  await expect(card.getByTestId("home-office-amount")).toContainText("900,00", { timeout: 30_000 })

  const year = new Date().getFullYear()
  const euer = await (await request.get(`${API}/api/v1/accounting/euer?companyId=${companyId}&year=${year}`, { headers: H })).json()
  const line = euer.ausgaben.find((l: any) => l.kennziffer === "5410")
  expect(Number(line.amount)).toBe(900)
})
