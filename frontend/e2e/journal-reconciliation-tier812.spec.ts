import { test, expect } from "@playwright/test"

/**
 * Tier 812 — the journal against the reports: the accounting page lists the
 * vouchers that are in the journal and DATEV and in no report, and the
 * „Neuer Beleg" form says so when an expense, revenue or VAT account is
 * picked. A fresh company, so nothing is left on the shared one. Tier 815: a
 * purchase on an Anlagekonto with no asset in the register is listed too.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a manual voucher on an expense account is listed as missing from the reports; the form warns", async ({ page, request }) => {
  const tag = `t812-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier812-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  await request.post(`${API}/api/v1/accounting/accounts/seed?${q}`, { headers: H })
  const accounts: any[] = await (await request.get(`${API}/api/v1/accounting/accounts?${q}`, { headers: H })).json()
  const id = (n: string) => accounts.find((a) => a.accountNumber === n).id
  const year = new Date().getFullYear()
  const made = await request.post(`${API}/api/v1/accounting/vouchers?${q}`, {
    headers: H,
    data: {
      companyId, date: `${year}-01-15`, description: `Miete ${tag}`, referenceType: "Manual",
      lines: [{ accountId: id("4900"), debit: 1000, credit: 0 }, { accountId: id("1576"), debit: 190, credit: 0 }, { accountId: id("1200"), debit: 0, credit: 1190 }],
    },
  })
  expect(made.status(), "manual voucher").toBe(201)
  // Tier 815: a purchase on an Anlagekonto with no asset in the register
  const printer = await request.post(`${API}/api/v1/expenses?${q}`, {
    headers: H,
    data: { description: `Drucker ${tag}`, invoiceDate: `${year}-01-20`, netAmount: 900, vatRate: 0.19, vatAmount: 171, grossAmount: 1071, category: "Betriebsausstattung", accountNumber: "0400" },
  })
  expect(printer.status(), "asset purchase").toBe(201)

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
  const card = page.getByTestId("journal-reconciliation")
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(card.getByTestId("abstimmung-entry")).toHaveCount(1, { timeout: 30_000 })
  await expect(card.getByTestId("abstimmung-summary")).toContainText("1.000,00")
  await expect(card.getByTestId("abstimmung-entry")).toContainText("4900")
  await expect(card.getByTestId("abstimmung-asset-purchase")).toContainText(`Drucker ${tag}`)
  // last year: nothing booked, nothing missing
  await card.getByTestId("abstimmung-year").selectOption(String(year - 1))
  await expect(card.getByTestId("abstimmung-ok")).toBeVisible({ timeout: 30_000 })

  // the form: no warning for a balance-sheet account, a warning for 4900
  await page.getByTestId("accounting-new-voucher").click()
  const firstAccount = page.locator("select").filter({ has: page.locator('option:text-is("— Konto wählen —")') }).first()
  await firstAccount.selectOption({ label: accounts.find((a) => a.accountNumber === "1200") ? `1200 ${accounts.find((a) => a.accountNumber === "1200").name}` : "" })
  await expect(page.getByTestId("voucher-off-reports")).toHaveCount(0)
  await firstAccount.selectOption({ label: `4900 ${accounts.find((a) => a.accountNumber === "4900").name}` })
  await expect(page.getByTestId("voucher-off-reports")).toBeVisible()
})
