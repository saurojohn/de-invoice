/**
 * Tier 507 — the KSt (+ Soli) prepayments are entered in the KSt 1 section
 * and reduce what is left to pay (the Steuerrückstellung).
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("KSt prepayments are entered and reduce what is left to pay", async ({ page, request }) => {
  const tag = `t507-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier507-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const year = new Date().getFullYear() - 1 // the section opens on the previous year

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
  await page.goto("/dashboard/accounting")
  const box = page.getByTestId("kst1-vorauszahlungen")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")

  for (const q of ["q1", "q2", "q3", "q4"]) await box.getByTestId(`kst1-vz-${q}`).fill("250")
  await box.getByTestId("kst1-vz-save").click()
  // nothing to pay in a year without profit: 1 000 € prepaid → −1 000 € left
  await expect(box.getByTestId("kst1-verbleibend")).toContainText("1.000,00", { timeout: 30_000 })

  const k = await (await request.get(`${API}/api/v1/accounting/kst1?companyId=${companyId}&year=${year}`, { headers: H })).json()
  expect(k.kstVorauszahlungen).toEqual({ q1: 250, q2: 250, q3: 250, q4: 250 })
  expect(k.totals.vorauszahlungen).toBe(1000)
})
