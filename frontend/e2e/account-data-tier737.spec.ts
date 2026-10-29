/**
 * Tier 737 — the security page: „Meine Daten herunterladen" and „Konto löschen".
 *
 * A fresh account downloads its data (a JSON naming its address, without
 * secrets); deleting it names the company that closes with it and the date
 * its records are kept until, asks for the password and the confirmation,
 * and ends at the login — where the old password no longer works.
 * (The rules: backend spec 457.)
 */
import { test, expect, type Page } from "@playwright/test"
import * as fs from "fs"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function as(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (sessionStorage.getItem("t737-signed-out")) return
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-29T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("my data as JSON; deleting the account closes its only company", async ({ page, request }) => {
  const tag = `t737-${Date.now()}`
  const email = `${tag}@example.test`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email, password: "Tier737-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id

  await as(page, userId, companyId)
  await page.goto("/dashboard/security")
  const card = page.getByTestId("account-data-card")
  await expect(card).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")

  const download = page.waitForEvent("download", { timeout: 60_000 })
  await page.getByTestId("account-export").click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^meine-daten-\d{4}-\d{2}-\d{2}\.json$/)
  const json = fs.readFileSync(await file.path(), "utf8")
  const data = JSON.parse(json)
  expect(data.account.email).toBe(email)
  expect(data.memberships).toEqual([expect.objectContaining({ companyId, role: "admin" })])
  expect(json).not.toContain("passwordHash")
  expect(json).not.toContain("$2b$")

  await page.getByTestId("account-delete-start").click()
  const closes = page.getByTestId("account-delete-closes")
  await expect(closes).toContainText(`${tag} GmbH`, { timeout: 30_000 })
  await expect(closes).toContainText(`31.12.${new Date().getFullYear() + 10}`)
  const confirm = page.getByTestId("account-delete-confirm-button")
  await expect(confirm).toBeDisabled()
  await page.getByTestId("account-delete-password").fill("falsch-123")
  await page.getByTestId("account-delete-understood").check()
  await confirm.click()
  await expect(page.getByTestId("account-delete-error")).toContainText("Passwort ist nicht richtig", { timeout: 30_000 })

  await page.getByTestId("account-delete-password").fill("Tier737-e2e")
  await page.evaluate(() => sessionStorage.setItem("t737-signed-out", "1"))
  await confirm.click()
  await page.waitForURL(/\/login/, { timeout: 60_000 })

  const login = await request.post(`${API}/api/v1/auth/login`, { data: { email, password: "Tier737-e2e" } })
  expect(login.status()).toBe(400)
})
