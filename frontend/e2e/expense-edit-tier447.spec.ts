/**
 * Tier 447 — the expenses page (/dashboard/expenses).
 *
 * Measured before:
 *   - the detail modal only listed receipts: an expense could be corrected
 *     only on the UStVA page (Tier 443);
 *   - an expense paid by SEPA showed the badge "Offen" (the state came from
 *     bank vouchers alone), so the "Offen" filter listed paid bills.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { readFileSync } from "fs"

const API = "http://localhost:3001"
let tokens: { userId: string; companyId: string }
let H: Record<string, string>
const today = new Date().toISOString().slice(0, 10)

test.beforeAll(() => {
  const env = readFileSync("/tmp/cashbook-e2e-auth.env", "utf-8")
  const get = (k: string) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]
  tokens = { userId: get("USER_ID"), companyId: get("COMPANY_ID") }
  H = { "x-user-id": tokens.userId, "x-company-id": tokens.companyId }
})

async function injectAuth(page: Page) {
  const { userId, companyId } = tokens
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
}

async function expense(request: APIRequestContext, tag: string) {
  const sup = await (await request.post(`${API}/api/v1/suppliers?companyId=${tokens.companyId}`, {
    headers: H,
    data: {
      name: `${tag} Lieferant`,
      address: { street: "a", city: "b", postalCode: "1", country: "DE" },
      bankInfo: { iban: "DE89370400440532013000", bic: "COBADEFFXXX" },
    },
  })).json()
  const res = await request.post(`${API}/api/v1/ustva/expenses?companyId=${tokens.companyId}`, {
    headers: H,
    data: {
      supplierId: sup.id, invoiceNumber: tag, description: tag, invoiceDate: today,
      netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119,
    },
  })
  expect(res.status(), "expense").toBe(201)
  return (await res.json()) as { id: string }
}

async function openModal(page: Page, id: string) {
  await injectAuth(page)
  await page.goto("/dashboard/expenses")
  const open = page.getByTestId(`expense-open-${id}`)
  await expect(open).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  await expect(async () => {
    await open.click()
    await expect(page.getByTestId("expense-edit").or(page.getByTestId("expense-locked"))).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
}

test.describe("Tier 447 — expenses page", () => {
  test("an open expense is corrected from its modal", async ({ page, request }) => {
    const tag = `t447-edit-${Date.now()}`
    const exp = await expense(request, tag)
    await openModal(page, exp.id)
    await expect(page.getByTestId("expense-edit-description")).toHaveValue(tag)
    await page.getByTestId("expense-edit-net").fill("200")
    const save = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/expenses/${exp.id}`) && r.request().method() === "PUT",
      { timeout: 60_000 },
    )
    await page.getByTestId("expense-edit-save").click()
    const res = await save
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect([Number(body.netAmount), Number(body.vatAmount), Number(body.grossAmount)]).toEqual([200, 38, 238])
    await expect(page.locator("tr", { hasText: tag })).toContainText("238,00")
    await request.delete(`${API}/api/v1/ustva/expenses/${exp.id}?companyId=${tokens.companyId}`, { headers: H })
  })

  test("a SEPA-paid expense is shown paid and offers no edit", async ({ page, request }) => {
    const tag = `t447-sepa-${Date.now()}`
    const exp = await expense(request, tag)
    const batch = await request.post(`${API}/api/v1/payments/batches`, {
      headers: H,
      data: {
        companyId: tokens.companyId, expenseIds: [exp.id], executionDate: today,
        debtorIban: "DE02120300000000202051", debtorName: "Tier 447 GmbH",
      },
    })
    expect(batch.status(), "SEPA batch").toBe(201)
    await openModal(page, exp.id)
    await expect(page.getByTestId("expense-locked")).toContainText("SEPA")
    await expect(page.getByTestId("expense-edit")).toHaveCount(0)
    await page.getByRole("button", { name: /Schließen|Close|关闭/ }).first().click()
    await expect(page.locator("tr", { hasText: tag })).toContainText(/Bezahlt|Paid|已付/)
    const { id } = await batch.json()
    await request.post(`${API}/api/v1/payments/batches/${id}/cancel?companyId=${tokens.companyId}`, {
      headers: H, data: { reason: "Testende" },
    })
    await request.delete(`${API}/api/v1/ustva/expenses/${exp.id}?companyId=${tokens.companyId}`, { headers: H })
  })
})
