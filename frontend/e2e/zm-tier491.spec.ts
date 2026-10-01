/**
 * Tier 491 — the Zusammenfassende Meldung on the UStVA page.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("the ZM card lists an igL per USt-IdNr. and reconciles with Kz 41", async ({ page, request }) => {
  const tag = `t491-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier491-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const cust = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} FR`, type: "business", vatId: "FR12345678901", address: { country: "FR" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: {
      customerId: cust.id, issueDate: "2026-07-10", euTransaction: true,
      items: [{ description: "Ware", quantity: 1, unit: "Stk", unitPrice: 1234, vatRate: 0 }],
    },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

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
  await expect(page.getByTestId("zm-card")).toBeVisible({ timeout: 90_000 })
  await page.getByTestId("zm-year").fill("2026")
  await page.getByTestId("zm-quarter").selectOption("3")
  const row = page.getByTestId("zm-row").first()
  await expect(row).toContainText("12345678901", { timeout: 30_000 })
  await expect(row).toContainText("1.234,00")
  await expect(page.getByTestId("zm-abgleich")).toContainText("✓")
})
