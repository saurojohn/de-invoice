/**
 * Tier 842 — the switch away from the Kleinunternehmerregelung has a date.
 *
 * Measured before: the settings switched `defaultVatMode` alone, and every
 * report read it for every period — the Kleinunternehmer's past turned
 * „steuerfrei“. Now the switch asks from when the Umsatzsteuer applies; the
 * past up to the day before stays § 19 (backend spec 536).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
test("switching a Kleinunternehmer to Regelbesteuerung keeps the past under § 19", async ({ page, request }) => {
  const tag = `t842-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier842-e2e", companyName: `${tag} KU` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { defaultVatMode: "kleinunternehmer", rechtsform: "Einzelunternehmen" },
  })).status()).toBe(200)
  const lastYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date())) - 1

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
  const mode = page.getByTestId("settings-default-vat-mode")
  await expect(mode).toHaveValue("kleinunternehmer", { timeout: 90_000 })
  await expect(page.getByTestId("settings-ku-date")).toHaveCount(0)

  await mode.selectOption("standard")
  const day = page.getByTestId("settings-ku-date")
  await expect(day).toBeVisible()
  await day.fill(`${lastYear}-07-01`)
  const saved = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/companies/${companyId}`) && r.request().method() === "PUT",
    { timeout: 30_000 },
  )
  await page.getByTestId("settings-save").click()
  expect((await saved).status()).toBe(200)

  const co = await (await request.get(`${API}/api/v1/companies/${companyId}?${q}`, { headers: H })).json()
  expect(co.defaultVatMode).toBe("standard")
  expect(String(co.kleinunternehmerBis).slice(0, 10)).toBe(`${lastYear}-06-30`)
  await expect(page.getByTestId("settings-ku-period")).toContainText(`Kleinunternehmerregelung bis 30.06.${lastYear}`)
  await expect(page.getByTestId("settings-ku-date")).toHaveCount(0)
})
