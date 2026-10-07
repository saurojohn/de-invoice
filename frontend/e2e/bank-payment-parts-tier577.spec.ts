/**
 * Tier 577 — one bank debit pays an invoice that was entered as two expenses.
 *
 * An invoice with 19 % and 7 % is two expenses (an Expense has one VAT
 * rate). The bank import page offered no payment button for its single
 * debit — the amount matched neither. Now it offers "Zahlung <nr> (2
 * Teilbeträge)", and both expenses are paid.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a debit of the invoice total is booked as the payment of both parts", async ({ page, request }) => {
  const tag = `t577-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier577-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const sup = await (await request.post(`${API}/api/v1/suppliers?${q}`, {
    headers: H,
    data: { name: `${tag} Lieferant`, address: { street: "a", city: "b", postalCode: "1", country: "DE" } },
  })).json()
  const part = async (net: number, vat: number, rate: number) =>
    (await (await request.post(`${API}/api/v1/expenses?${q}`, {
      headers: H,
      data: {
        supplierId: sup.id, invoiceNumber: "ER-577", description: `Ware ${rate * 100} %`, invoiceDate: "2026-06-01",
        netAmount: net, vatRate: rate, vatAmount: vat, grossAmount: Math.round((net + vat) * 100) / 100, confirmDuplicate: true,
      },
    })).json()) as { id: string }
  const p19 = await part(200, 38, 0.19)
  const p7 = await part(107.14, 7.5, 0.07)
  expect(p19.id && p7.id, "fixture: two expenses under one invoice number").toBeTruthy()

  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST577UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR1000,00",
    ":61:2606020602D352,64NTRFNONREF//Zahlung ER-577", "Lieferant",
    ":61:2606030603D50,00NTRFNONREF//Sonstiges", "Irgendwer",
    ":62F:C260603EUR597,36", "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?${q}`, {
    headers: H,
    multipart: {
      file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) },
      companyId, userId,
    },
  })
  expect(up.status(), "statement imported").toBe(201)
  const txns = (await up.json()).transactions
  const pay = txns.find((t: { amount: string }) => Number(t.amount) === -352.64)
  const other = txns.find((t: { amount: string }) => Number(t.amount) === -50)

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
  await page.goto("/dashboard/bank-import")
  const statement = page.getByText(`${tag}.mt940`)
  await expect(statement).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  const button = page.getByTestId(`book-payment-${pay.id}`)
  await expect(async () => {
    await statement.click()
    await expect(button).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(button).toContainText("ER-577")
  await expect(button).toContainText("2")
  await expect(page.getByTestId(`book-payment-${other.id}`), "no match for 50,00").toHaveCount(0)

  const booked = page.waitForResponse(
    (r) => r.url().includes(`/transactions/${pay.id}/book-expense`) && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await button.click()
  const res = await booked
  expect(res.status()).toBe(201)
  expect(((await res.json()).expenseIds as string[]).sort()).toEqual([p19.id, p7.id].sort())
  await expect(button).toHaveCount(0)

  for (const p of [p19, p7]) {
    const after = await (await request.get(`${API}/api/v1/expenses/${p.id}?${q}`, { headers: H })).json()
    expect(after.paidAt?.slice(0, 10), "each part is paid on the value date").toBe("2026-06-02")
  }
})
