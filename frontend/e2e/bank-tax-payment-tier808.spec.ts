import { test, expect } from "@playwright/test"

/**
 * Tier 808 — a tax payment in the bank statement: the bank page recognises a
 * debit to the Finanzamt (GET /bank-statements/:id/tax-payments) and books it
 * where the reports read it — here a Sondervorauszahlung, a UstPayment. A
 * fresh company, so nothing is left on the shared one.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a Finanzamt debit is recognised and booked as the Sondervorauszahlung", async ({ page, request }) => {
  const tag = `t808-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier808-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST808UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR1000,00",
    // name and purpose in :86: (?20 Verwendungszweck, ?32 Name), as banks write them
    ":61:2606020602D300,00NTRFNONREF", ":86:177?00SEPA-UEBERWEISUNG?20Sondervorauszahlung 2027?32Finanzamt Koeln-Altstadt",
    ":61:2606030603D50,00NTRFNONREF", ":86:177?00SEPA-UEBERWEISUNG?20Sonstiges?32Irgendwer",
    ":62F:C260603EUR650,00", "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?${q}`, {
    headers: H,
    multipart: { file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) }, companyId, userId },
  })
  expect(up.status(), "statement imported").toBe(201)
  const txns = (await up.json()).transactions
  const tax = txns.find((t: any) => Number(t.amount) === -300)
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
  const button = page.getByTestId(`book-tax-${tax.id}`)
  await expect(async () => {
    await statement.click()
    await expect(button).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(button).toContainText("Sondervorauszahlung 2027")
  await expect(page.getByTestId(`book-tax-${other.id}`), "a debit to anyone else is no tax payment").toHaveCount(0)

  const booked = page.waitForResponse(
    (r) => r.url().includes(`/transactions/${tax.id}/book-tax`) && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await button.click()
  const res = await booked
  expect(res.status()).toBe(201)
  expect(JSON.parse(res.request().postData() || "{}")).toEqual({ kind: "svz", year: 2027 })
  await expect(button).toHaveCount(0, { timeout: 30_000 })

  const payments = await (await request.get(`${API}/api/v1/ustva/payments?${q}&year=2027`, { headers: H })).json()
  const list = Array.isArray(payments) ? payments : payments.data ?? payments.payments ?? []
  expect(list.map((p: any) => [p.kind, Number(p.amount), String(p.paidAt).slice(0, 10)])).toEqual([["sondervorauszahlung", 300, "2026-06-02"]])
})
