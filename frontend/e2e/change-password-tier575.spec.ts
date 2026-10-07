/**
 * Tier 575 — "Passwort ändern" on the security page.
 *
 * A signed-in user had no way to set a new password (only "Passwort
 * vergessen", by mail). The card asks for the current password and the new
 * one twice, and says when the two do not match or the current one is wrong.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the security page changes the password", async ({ page, request }) => {
  const tag = `t575-${Date.now()}`
  const email = `${tag}@example.test`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email, password: "Tier575-alt1", companyName: `${tag} GmbH` },
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
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/security")
  await expect(page.getByTestId("change-password-card")).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  const submit = page.getByTestId("change-password-submit")
  await expect(submit).toBeDisabled()

  // the two new entries differ: said, and not sent
  await page.getByTestId("change-password-current").fill("Tier575-alt1")
  await page.getByTestId("change-password-new").fill("Tier575-neu2")
  await page.getByTestId("change-password-repeat").fill("Tier575-neu3")
  await expect(page.getByTestId("change-password-mismatch")).toBeVisible()
  await expect(submit).toBeDisabled()

  // the current password wrong: the server's answer is shown, the user stays signed in
  await page.getByTestId("change-password-current").fill("ganz-falsch-1")
  await page.getByTestId("change-password-repeat").fill("Tier575-neu2")
  await submit.click()
  await expect(page.getByTestId("change-password-error")).toContainText("aktuelle Passwort")
  await expect(page).toHaveURL(/\/dashboard\/security/)

  await page.getByTestId("change-password-current").fill("Tier575-alt1")
  await submit.click()
  await expect(page.getByTestId("change-password-done")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("change-password-current")).toHaveValue("")

  const withNew = await request.post(`${API}/api/v1/auth/login`, { data: { email, password: "Tier575-neu2" } })
  expect(withNew.status(), "login with the new password").toBe(200)
  const withOld = await request.post(`${API}/api/v1/auth/login`, { data: { email, password: "Tier575-alt1" } })
  expect(withOld.ok(), "login with the old password").toBe(false)
})
