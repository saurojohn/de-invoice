/**
 * Tier 450 — a supplier's refund is booked against its credit note from the
 * bank import page.
 *
 * Measured before: an incoming transaction offered no action at all (only
 * debits had "Als Aufwand buchen"), and the API refused incoming payments.
 * Now a credit row whose amount matches an open supplier credit note shows
 * "Erstattung Gutschrift <number>".
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("an incoming payment is booked as the refund of a credit note", async ({ page, request }) => {
  const tag = `t450-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier450-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const sup = await (await request.post(`${API}/api/v1/suppliers?${q}`, {
    headers: H,
    data: { name: `${tag} Lieferant`, address: { street: "a", city: "b", postalCode: "1", country: "DE" } },
  })).json()
  const cn = await (await request.post(`${API}/api/v1/ustva/expenses?${q}`, {
    headers: H,
    data: {
      supplierId: sup.id, invoiceNumber: "GS-450", description: "Retoure", invoiceDate: "2026-06-05",
      netAmount: 200, vatRate: 0.19, vatAmount: 38, grossAmount: 238, creditNote: true,
    },
  })).json()
  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST450UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR1000,00", ":61:2606100610C238,00NTRFNONREF//Erstattung GS-450", "Lieferant",
    ":62F:C260610EUR1238,00", "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?${q}`, {
    headers: H,
    multipart: {
      file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) },
      companyId, userId,
    },
  })
  expect(up.status(), "statement imported").toBe(201)
  const txn = (await up.json()).transactions.find((t: any) => Number(t.amount) === 238)

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
  const button = page.getByTestId(`book-refund-${txn.id}`)
  await expect(async () => {
    await statement.click()
    await expect(button).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(button).toContainText("GS-450")

  const booked = page.waitForResponse(
    (r) => r.url().includes(`/transactions/${txn.id}/book-expense`) && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await button.click()
  expect((await booked).status()).toBe(201)
  await expect(button).toHaveCount(0)
  await expect(page.locator("tbody tr").filter({ hasText: "238" })).toContainText(/BK-\d{4}-\d+/)

  const after = await (await request.get(`${API}/api/v1/expenses/${cn.id}?${q}`, { headers: H })).json()
  expect(after.paidAt?.slice(0, 10), "the credit note is settled").toBe("2026-06-10")
})
