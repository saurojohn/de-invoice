/**
 * Tier 455 — Anlage S and Anlage V count payments, as the EÜR (§ 11 EStG).
 *
 * Measured before: both took an invoice at its issue date, paid or not.
 * Now an unpaid invoice of the year is no income; both sections say they
 * count by payment date and list it as still open.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("an unpaid invoice is listed as open in Anlage S and Anlage V", async ({ page, request }) => {
  const tag = `t455-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier455-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  // The sections open on the previous year.
  const year = new Date().getFullYear() - 1

  const cust = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business" },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: {
      customerId: cust.id, issueDate: `${year}-05-01`,
      items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }],
    },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, {
    headers: H, data: { status: "sent" },
  })).status()).toBe(200)

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
  for (const id of ["anlage-s-zufluss", "anlage-v-zufluss"]) {
    const note = page.getByTestId(id)
    await expect(note).toBeVisible({ timeout: 90_000 })
    await expect(note).toContainText("§ 11 EStG")
    await expect(note).toContainText(/1 [^,]*, 0 /)
  }
  await expect(page.getByTestId("anlage-s-gewinn")).toContainText("0,00")
})
