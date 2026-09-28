/**
 * Tier 451 — a bank debit is booked as the payment of a recorded
 * Eingangsrechnung from the bank import page.
 *
 * Measured before: a debit row offered only "Als Aufwand buchen" (an account,
 * never an expense), so a recorded bill stayed open after the bank had paid
 * it. Now a debit whose amount matches an open expense shows "Zahlung <nr>".
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("a debit is booked as the payment of the matching expense", async ({ page, request }) => {
  const tag = `t451-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier451-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const sup = await (await request.post(`${API}/api/v1/suppliers?${q}`, {
    headers: H,
    data: { name: `${tag} Lieferant`, address: { street: "a", city: "b", postalCode: "1", country: "DE" } },
  })).json()
  const ex = await (await request.post(`${API}/api/v1/ustva/expenses?${q}`, {
    headers: H,
    data: {
      supplierId: sup.id, invoiceNumber: "ER-451", description: "Ware", invoiceDate: "2026-06-01",
      netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119,
    },
  })).json()
  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST451UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR1000,00",
    ":61:2606020602D119,00NTRFNONREF//Zahlung ER-451", "Lieferant",
    ":61:2606030603D50,00NTRFNONREF//Sonstiges", "Irgendwer",
    ":62F:C260603EUR831,00", "-",
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
  const pay = txns.find((t: any) => Number(t.amount) === -119)
  const other = txns.find((t: any) => Number(t.amount) === -50)

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
  await expect(button).toContainText("ER-451")
  await expect(page.getByTestId(`book-payment-${other.id}`), "no match for 50,00").toHaveCount(0)

  const booked = page.waitForResponse(
    (r) => r.url().includes(`/transactions/${pay.id}/book-expense`) && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await button.click()
  const res = await booked
  expect(res.status()).toBe(201)
  expect(JSON.parse(res.request().postData() || "{}").expenseId).toBe(ex.id)
  await expect(button).toHaveCount(0)

  const after = await (await request.get(`${API}/api/v1/expenses/${ex.id}?${q}`, { headers: H })).json()
  expect(after.paidAt?.slice(0, 10), "the bill is paid on the value date").toBe("2026-06-02")
})
