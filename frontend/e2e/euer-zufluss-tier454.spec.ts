/**
 * Tier 454 — the EÜR counts expenses when they are paid (§ 11 EStG), and a
 * payment made outside the bank import, SEPA and the cash book can be entered.
 *
 * Measured before: the EÜR took every expense at its invoice date, paid or
 * not, and the expense form had no payment date (PUT refused `paidAt`).
 * Now an unpaid bill is listed as open under the EÜR; its "Bezahlt am" date,
 * entered in the expense's modal, puts it into the year it was paid.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("an expense paid by card counts in the EÜR from its payment date", async ({ page, request }) => {
  const tag = `t454-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier454-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  // The EÜR section opens on the previous year.
  const year = new Date().getFullYear() - 1

  const ex = await (await request.post(`${API}/api/v1/ustva/expenses?${q}`, {
    headers: H,
    data: {
      invoiceNumber: "ER-454", description: tag, invoiceDate: `${year}-03-01`, category: "Material",
      netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119,
    },
  })).json()

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
  await expect(page.getByTestId("euer-zufluss")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("euer-zufluss")).toContainText("§ 11 EStG")
  await expect(page.getByTestId("euer-zufluss")).toContainText(/0 [^,]*, 1 /)
  await expect(page.getByTestId("euer-exp-4300")).toContainText("0,00")

  await page.goto("/dashboard/expenses")
  const open = page.getByTestId(`expense-open-${ex.id}`)
  await expect(open).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  await expect(async () => {
    await open.click()
    await expect(page.getByTestId("expense-edit")).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByTestId("expense-edit-paid-at").fill(`${year}-03-05`)
  const save = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/expenses/${ex.id}`) && r.request().method() === "PUT",
    { timeout: 60_000 },
  )
  await page.getByTestId("expense-edit-save").click()
  const res = await save
  expect(res.status()).toBe(200)
  expect(String((await res.json()).paidAt).slice(0, 10)).toBe(`${year}-03-05`)

  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("euer-exp-4300")).toContainText("100,00", { timeout: 90_000 })
  await expect(page.getByTestId("euer-zufluss")).not.toContainText(/0 [^,]*, 1 /)
})
