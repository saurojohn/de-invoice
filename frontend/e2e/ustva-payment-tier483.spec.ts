/**
 * Tier 483 — the payment of a submitted UStVA is recorded on its row.
 *
 * The EÜR counts the VAT paid to / refunded by the Finanzamt on the day it
 * moved (Anlage EÜR Zeilen 18 / 58). The filings list had no way to record
 * it; now a submitted return has "Zahlung erfassen", and afterwards shows
 * "bezahlt am …".
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("a submitted return's payment is recorded from the filings list", async ({ page, request }) => {
  const tag = `t483-${Date.now()}`
  const year = new Date().getFullYear()
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier483-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const exp = await request.post(`${API}/api/v1/ustva/expenses?${q}`, {
    headers: H,
    data: { description: tag, invoiceDate: `${year}-01-15`, netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119 },
  })
  expect(exp.status(), "expense").toBe(201)
  const data = await (await request.get(`${API}/api/v1/ustva/compute?${q}&year=${year}&month=1`, { headers: H })).json()
  const sub = await request.post(`${API}/api/v1/ustva/filings?${q}`, { headers: H, data: { ...data, status: "submitted" } })
  expect(sub.status(), "submitted").toBe(201)
  const filing = await sub.json()

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
  const button = page.getByTestId(`ustva-record-payment-${filing.id}`)
  await expect(button).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")

  page.once("dialog", (d) => d.accept(`${year}-02-10`))
  await button.click()
  const paid = page.getByTestId(`ustva-paid-${filing.id}`)
  // a Vorsteuer surplus of 19 € — refunded by the Finanzamt
  await expect(paid).toContainText("10.2.", { timeout: 30_000 })
  await expect(paid).toContainText("19,00")

  const list = await (await request.get(`${API}/api/v1/ustva/filings?${q}`, { headers: H })).json()
  const saved = list.find((f: any) => f.id === filing.id)
  expect(Number(saved.paidAmount)).toBe(-19)
})
