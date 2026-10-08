/**
 * Tier 582 — an invoice with two VAT rates is entered on the UStVA page.
 *
 * The page's expense form had one rate; since Tier 581 an expense can carry
 * several, but a second one could only be added afterwards on the expenses
 * page. The form now takes further rates, and corrects such an expense too.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("an expense with 19 % and 7 % is entered and corrected on the UStVA page", async ({ page, request }) => {
  const tag = `t582-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier582-e2e", companyName: `${tag} GmbH` },
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
  const lines = (e: { taxLines: { vatRate: string; netAmount: string; vatAmount: string }[] }) =>
    e.taxLines.map((l) => [Number(l.vatRate), Number(l.netAmount), Number(l.vatAmount)])

  await page.goto("/dashboard/accounting/ustva")
  const toggle = page.getByTestId("ustva-add-expense-toggle")
  await expect(toggle).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  await expect(async () => {
    await toggle.click()
    await expect(page.getByTestId("ustva-expense-description")).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  await page.getByTestId("ustva-expense-description").fill(tag)
  await page.getByTestId("ustva-expense-net").pressSequentially("200")
  await page.getByTestId("ustva-expense-add-rate").click()
  await page.getByTestId("ustva-expense-extra-net-0").pressSequentially("100")
  await expect(page.getByTestId("ustva-expense-extra-vat-0"), "the second rate is the next free one, 7 %").toHaveValue("7")
  const created = page.waitForResponse(
    (r) => r.url().includes("/api/v1/ustva/expenses") && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await page.getByTestId("ustva-expense-submit").click()
  const made = await (await created).json()
  expect([Number(made.netAmount), Number(made.vatAmount), Number(made.grossAmount)], "the amounts are the lines' sums").toEqual([300, 45, 345])
  expect(lines(made)).toEqual([[0.19, 200, 38], [0.07, 100, 7]])
  const row = page.locator("tr", { hasText: tag })
  await expect(row).toContainText("19% / 7%", { timeout: 30_000 })

  // corrected in the same form: the second rate is taken out again
  const edit = page.getByTestId(`ustva-expense-edit-${made.id}`)
  await expect(async () => {
    await edit.click()
    await expect(page.getByTestId("ustva-expense-editing")).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page.getByTestId("ustva-expense-net")).toHaveValue("200")
  await expect(page.getByTestId("ustva-expense-extra-net-0")).toHaveValue("100")
  await page.getByTestId("ustva-expense-extra-rate").getByRole("button").click()
  await expect(page.getByTestId("ustva-expense-extra-rate")).toHaveCount(0)
  const saved = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/ustva/expenses/${made.id}`) && r.request().method() === "PUT",
    { timeout: 60_000 },
  )
  await page.getByTestId("ustva-expense-submit").click()
  const res = await saved
  expect(res.status()).toBe(200)
  const after = await res.json()
  expect([Number(after.netAmount), Number(after.vatAmount), Number(after.grossAmount)]).toEqual([200, 38, 238])
  expect(lines(after), "one rate again: no lines").toEqual([])
})
