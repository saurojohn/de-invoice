/**
 * Tier 452 — a debit that is a bill less its Skonto is booked from the bank
 * import page.
 *
 * Measured before: 1 166,20 € against a bill of 1 190 € matched nothing (the
 * payment button needs the exact amount, Tier 451). Now the row offers
 * "Zahlung ER-452 mit Skonto 23,80 €"; the server writes the Skonto credit
 * note and the bill is paid.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("a debit less 2 % Skonto pays the bill and books the Skonto", async ({ page, request }) => {
  const tag = `t452-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier452-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const ex = await (await request.post(`${API}/api/v1/ustva/expenses?${q}`, {
    headers: H,
    data: {
      invoiceNumber: "ER-452", description: "Ware", invoiceDate: "2026-06-01",
      netAmount: 1000, vatRate: 0.19, vatAmount: 190, grossAmount: 1190,
    },
  })).json()
  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST452UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR5000,00", ":61:2606080608D1166,20NTRFNONREF//ER-452 Skonto", "Lieferant",
    ":62F:C260608EUR3833,80", "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?${q}`, {
    headers: H,
    multipart: {
      file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) },
      companyId, userId,
    },
  })
  expect(up.status(), "statement imported").toBe(201)
  const txn = (await up.json()).transactions.find((t: any) => Number(t.amount) === -1166.2)

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
  const button = page.getByTestId(`book-payment-${txn.id}`)
  await expect(async () => {
    await statement.click()
    await expect(button).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(button).toContainText("ER-452")
  await expect(button).toContainText("23,80")

  const booked = page.waitForResponse(
    (r) => r.url().includes(`/transactions/${txn.id}/book-expense`) && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await button.click()
  const res = await booked
  expect(res.status()).toBe(201)
  expect(JSON.parse(res.request().postData() || "{}").skonto).toBe(true)

  const list = await (await request.get(`${API}/api/v1/expenses?${q}`, { headers: H })).json()
  const bill = list.data.find((e: any) => e.id === ex.id)
  const sk = list.data.find((e: any) => e.invoiceNumber === "ER-452-SKONTO")
  expect(bill.paidAt?.slice(0, 10), "the bill is paid").toBe("2026-06-08")
  expect([Number(sk?.netAmount), Number(sk?.vatAmount)], "Skonto credit note").toEqual([-20, -3.8])
})
