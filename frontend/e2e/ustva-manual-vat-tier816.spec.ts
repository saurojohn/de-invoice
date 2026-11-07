import { test, expect } from "@playwright/test"

/**
 * Tier 816 — the UStVA page shows the VAT of the period's manual vouchers,
 * which the return does not add (§ 15 UStG: the input tax needs an invoice).
 * A fresh company, a manual voucher with Vorsteuer in the period the page
 * opens on (the period due, GET /ustva/deadlines defaults).
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a manual voucher's Vorsteuer is shown beside the UStVA, not in it", async ({ page, request }) => {
  const tag = `t816-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier816-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  await request.post(`${API}/api/v1/accounting/accounts/seed?${q}`, { headers: H })
  const accounts: any[] = await (await request.get(`${API}/api/v1/accounting/accounts?${q}`, { headers: H })).json()
  const id = (n: string) => accounts.find((a) => a.accountNumber === n).id
  const deadlines = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  const p = deadlines.defaults.ustva as { year: number; month?: number | null; quarter?: number | null }
  const month = p.month ?? ((p.quarter ?? 1) - 1) * 3 + 1
  const date = `${p.year}-${String(month).padStart(2, "0")}-10`
  const made = await request.post(`${API}/api/v1/accounting/vouchers?${q}`, {
    headers: H,
    data: {
      companyId, date, description: `Büro ${tag}`, referenceType: "Manual",
      lines: [{ accountId: id("4900"), debit: 100, credit: 0 }, { accountId: id("1576"), debit: 19, credit: 0 }, { accountId: id("1200"), debit: 0, credit: 119 }],
    },
  })
  expect(made.status(), "manual voucher").toBe(201)
  const voucherNumber: string = (await made.json()).voucherNumber

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
  await page.goto("/dashboard/accounting/ustva")
  const note = page.getByTestId("ustva-manual-vat")
  await expect(note).toBeVisible({ timeout: 90_000 })
  await expect(note).toContainText("19,00")
  await expect(note).toContainText(voucherNumber)
  await expect(note).toContainText("1576")
})
