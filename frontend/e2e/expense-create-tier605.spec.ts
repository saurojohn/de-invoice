/**
 * Tier 605 — a supplier invoice can be entered by hand on the expenses page.
 *
 * The page could scan, read an e-invoice and import a CSV; to simply take an
 * invoice down one had to go to the UStVA page. And § 13b / intra-community
 * acquisition could not be chosen in the form at all.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("entering supplier invoices by hand, with the tax treatment", async ({ page, request }) => {
  const tag = `t605-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier605-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const list = async () =>
    ((await (await request.get(`${API}/api/v1/expenses?companyId=${companyId}`, { headers: H })).json()).data as Array<{
      id: string; description: string; netAmount: string; vatAmount: string; isReverseCharge: boolean; isIntraEU: boolean
    }>)
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/expenses")

  // an ordinary invoice: 200,00 + 19 %
  await page.getByTestId("expense-create-button").click({ timeout: 60_000 })
  const form = page.getByTestId("expense-create")
  await expect(form).toBeVisible()
  await expect(form.getByTestId("expense-edit-save")).toBeDisabled() // nothing entered yet
  await form.getByTestId("expense-edit-description").fill("Büromaterial")
  await form.getByTestId("expense-edit-net").fill("200")
  await form.getByTestId("expense-edit-save").click()
  await expect(page.getByTestId("expense-create-modal")).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId("expense-row").filter({ hasText: "Büromaterial" })).toBeVisible()
  let rows = await list()
  expect(rows.map((e) => [e.description, Number(e.netAmount), Number(e.vatAmount), e.isReverseCharge])).toEqual([["Büromaterial", 200, 38, false]])

  // § 13b: the rate disappears, the invoice has no VAT
  await page.getByTestId("expense-create-button").click()
  await form.getByTestId("expense-edit-description").fill("Software aus den USA")
  await form.getByTestId("expense-edit-net").fill("1000")
  await form.getByTestId("expense-edit-treatment").selectOption("rc")
  await expect(form.getByTestId("expense-edit-add-tax-line")).toBeHidden()
  await form.getByTestId("expense-edit-save").click()
  await expect(page.getByTestId("expense-create-modal")).toHaveCount(0, { timeout: 30_000 })
  rows = await list()
  const rc = rows.find((e) => e.description === "Software aus den USA")!
  expect([Number(rc.netAmount), Number(rc.vatAmount), rc.isReverseCharge, rc.isIntraEU]).toEqual([1000, 0, true, false])

  // …and the edit form shows that choice again
  await page.getByTestId(`expense-open-${rc.id}`).click()
  await expect(page.getByTestId("expense-edit").getByTestId("expense-edit-treatment")).toHaveValue("rc")
})
