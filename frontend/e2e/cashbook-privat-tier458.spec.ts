/**
 * Tier 458 — a Privatentnahme from the Kassenbuch page.
 *
 * Measured before: the VAT select offered 19 %, 7 % and 0 % only, so the
 * owner taking cash out had to enter it at 0 % — a business expense in the
 * EÜR. Now "Privatentnahme" saves the entry without a rate: no expense, and
 * DATEV books it Privatentnahmen an Kasse (backend spec 247).
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("a Privatentnahme is saved without a VAT rate and is no expense", async ({ page, request }) => {
  const tag = `t458-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier458-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const today = new Date().toISOString().slice(0, 10)
  expect((await request.post(`${API}/api/v1/cashbook/entries?${q}`, {
    headers: H, data: { businessDate: today, type: "eroeffnung", description: "Anfangsbestand", amount: 500 },
  })).status()).toBe(201)

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
  await page.goto("/dashboard/cashbook")
  const add = page.getByTestId("cashbook-new-ausgabe")
  await expect(add).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  await expect(async () => {
    await add.click()
    await expect(page.getByTestId("cashbook-vat")).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  await page.getByTestId("cashbook-description").fill("Privatentnahme")
  await page.getByTestId("cashbook-amount").fill("200")
  await page.getByTestId("cashbook-vat").selectOption("privat")
  await expect(page.getByTestId("cashbook-privat-hint")).toBeVisible()
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/v1/cashbook/entries") && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await page.getByTestId("cashbook-save").click()
  const res = await saved
  expect(res.status()).toBe(201)
  expect(JSON.parse(res.request().postData() || "{}").vatRate).toBeNull()

  const year = today.slice(0, 4)
  const euer = await (await request.get(`${API}/api/v1/accounting/euer?${q}&year=${year}`, { headers: H })).json()
  expect(euer.totals.ausgabenTotal, "no business expense").toBe(0)
})
