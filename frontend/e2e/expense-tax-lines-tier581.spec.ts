/**
 * Tier 581 — an expense with several VAT rates, on the expenses page.
 *
 * An invoice with 19 % and 7 % is one expense with a line per rate. The list
 * names the rates; the edit form shows the lines, adds one, removes one — and
 * an ordinary expense can be given a second rate.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the VAT lines of an expense are shown and can be edited", async ({ page, request }) => {
  const tag = `t581-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier581-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const post = async (data: Record<string, unknown>) =>
    (await (await request.post(`${API}/api/v1/expenses?${q}`, { headers: H, data })).json()) as { id: string }
  const mixed = await post({
    invoiceNumber: "ER-MIX", description: "Papier und Bücher", invoiceDate: "2026-06-01",
    taxLines: [{ vatRate: 0.19, netAmount: 200, vatAmount: 38 }, { vatRate: 0.07, netAmount: 100, vatAmount: 7 }],
  })
  const plain = await post({
    invoiceNumber: "ER-EIN", description: "Nur Papier", invoiceDate: "2026-06-02", netAmount: 100, vatAmount: 19, grossAmount: 119, vatRate: 0.19,
  })
  expect(mixed.id && plain.id, "fixture: one expense with two rates, one with one").toBeTruthy()
  const stored = async (id: string) => {
    const e = await (await request.get(`${API}/api/v1/expenses/${id}?${q}`, { headers: H })).json()
    return {
      net: Number(e.netAmount), vat: Number(e.vatAmount),
      lines: (e.taxLines as { vatRate: string; netAmount: string; vatAmount: string }[]).map((l) => [Number(l.vatRate), Number(l.netAmount), Number(l.vatAmount)]),
    }
  }

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
  await page.goto("/dashboard/expenses")
  const row = (number: string) => page.getByTestId("expense-row").filter({ hasText: number })
  await expect(row("ER-MIX")).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  await expect(row("ER-MIX").getByTestId("expense-rates")).toHaveText("19 % / 7 %")
  await expect(row("ER-EIN").getByTestId("expense-rates")).toHaveCount(0)

  // the two lines, one changed: its VAT follows, the totals too
  await page.getByTestId(`expense-open-${mixed.id}`).click()
  await expect(page.getByTestId("expense-edit-tax-line")).toHaveCount(2)
  await expect(page.getByTestId("expense-edit-line-net-0")).toHaveValue("200")
  await page.getByTestId("expense-edit-line-net-1").fill("200")
  await expect(page.getByTestId("expense-edit-line-vat-1")).toHaveValue("14.00")
  await expect(page.getByTestId("expense-edit-line-totals")).toContainText("452,00")
  await page.getByTestId("expense-edit-save").click()
  await expect(page.getByTestId("expense-edit")).toBeHidden({ timeout: 30_000 })
  await expect.poll(() => stored(mixed.id)).toEqual({ net: 400, vat: 52, lines: [[0.19, 200, 38], [0.07, 200, 14]] })

  // an ordinary expense gets a second rate …
  await page.getByTestId(`expense-open-${plain.id}`).click()
  await expect(page.getByTestId("expense-edit-net")).toHaveValue("100")
  await page.getByTestId("expense-edit-add-tax-line").click()
  await expect(page.getByTestId("expense-edit-tax-line")).toHaveCount(2)
  await page.getByTestId("expense-edit-line-net-1").fill("50")
  await expect(page.getByTestId("expense-edit-line-vat-1")).toHaveValue("3.50")
  await page.getByTestId("expense-edit-save").click()
  await expect(page.getByTestId("expense-edit")).toBeHidden({ timeout: 30_000 })
  await expect.poll(() => stored(plain.id)).toEqual({ net: 150, vat: 22.5, lines: [[0.19, 100, 19], [0.07, 50, 3.5]] })
  await expect(row("ER-EIN").getByTestId("expense-rates")).toHaveText("19 % / 7 %", { timeout: 30_000 })

  // … and loses it again: one rate, no lines
  await page.getByTestId(`expense-open-${plain.id}`).click()
  await expect(page.getByTestId("expense-edit-tax-line")).toHaveCount(2)
  await page.getByTestId("expense-edit-line-remove-1").click()
  await expect(page.getByTestId("expense-edit-tax-line")).toHaveCount(0)
  await expect(page.getByTestId("expense-edit-net")).toHaveValue("100")
  await page.getByTestId("expense-edit-save").click()
  await expect(page.getByTestId("expense-edit")).toBeHidden({ timeout: 30_000 })
  await expect.poll(() => stored(plain.id)).toEqual({ net: 100, vat: 19, lines: [] })
})
