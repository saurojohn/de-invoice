/**
 * Tier 443 — the UStVA page's expense form.
 *
 * Measured in Chromium before the change:
 *   - Typing the net amount 1000 key by key saved VAT 0.19 and gross 1.19: the
 *     read-only VAT field kept the value computed for the first digit.
 *   - The "Lieferant" select listed the company's CUSTOMERS; saving with one
 *     chosen answered 400 "Lieferant nicht gefunden".
 *   - An expense could not be corrected, and a paid one offered "Löschen".
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

async function supplier(request: APIRequestContext, tag: string) {
  const res = await request.post(`${API}/api/v1/suppliers?companyId=${tokens.companyId}`, {
    headers: H,
    data: {
      name: `${tag} Lieferant`,
      address: { street: "a", city: "b", postalCode: "1", country: "DE" },
      bankInfo: { iban: "DE89370400440532013000", bic: "COBADEFFXXX" },
    },
  })
  expect(res.status(), "supplier").toBe(201)
  return (await res.json()) as { id: string; name: string }
}

async function expense(request: APIRequestContext, tag: string, supplierId: string, net: number) {
  const res = await request.post(`${API}/api/v1/ustva/expenses?companyId=${tokens.companyId}`, {
    headers: H,
    data: {
      supplierId, invoiceNumber: tag, description: tag, invoiceDate: today,
      netAmount: net, vatRate: 0.19, vatAmount: net * 0.19, grossAmount: net * 1.19,
    },
  })
  expect(res.status(), "expense").toBe(201)
  return (await res.json()) as { id: string }
}

async function openPage(page: Page) {
  await injectAuth(page)
  await page.goto("/dashboard/accounting/ustva")
  await expect(page.getByTestId("ustva-add-expense-toggle")).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
}

test.describe("Tier 443 — UStVA expense form", () => {
  test("typed amounts and a real supplier are saved", async ({ page, request }) => {
    const tag = `t443-new-${Date.now()}`
    const sup = await supplier(request, tag)
    await openPage(page)
    const toggle = page.getByTestId("ustva-add-expense-toggle")
    await expect(async () => {
      await toggle.click()
      await expect(page.getByTestId("ustva-expense-description")).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    await page.getByTestId("ustva-expense-description").fill(tag)
    // Key by key, as a person types — fill() set the whole value at once.
    await page.getByTestId("ustva-expense-net").pressSequentially("1000")
    await page.locator("select").filter({ has: page.locator(`option[value="${sup.id}"]`) })
      .selectOption(sup.id)
    const save = page.waitForResponse(
      (r) => r.url().includes("/api/v1/ustva/expenses") && r.request().method() === "POST",
      { timeout: 60_000 },
    )
    await page.getByTestId("ustva-expense-submit").click()
    const res = await save
    expect(res.status(), "a supplier from the list is accepted (was 400)").toBe(201)
    const created = await res.json()
    expect([Number(created.netAmount), Number(created.vatAmount), Number(created.grossAmount)],
      "VAT and gross follow the typed net (were 0.19 / 1.19)").toEqual([1000, 190, 1190])
    expect(created.supplierId).toBe(sup.id)
    await request.delete(`${API}/api/v1/ustva/expenses/${created.id}?companyId=${tokens.companyId}`, { headers: H })
  })

  test("an open expense is corrected in place", async ({ page, request }) => {
    const tag = `t443-edit-${Date.now()}`
    const sup = await supplier(request, tag)
    const exp = await expense(request, tag, sup.id, 100)
    await openPage(page)
    const edit = page.getByTestId(`ustva-expense-edit-${exp.id}`)
    await expect(edit).toBeVisible({ timeout: 30_000 })
    await expect(async () => {
      await edit.click()
      await expect(page.getByTestId("ustva-expense-editing")).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    await expect(page.getByTestId("ustva-expense-description")).toHaveValue(tag)
    await page.getByTestId("ustva-expense-net").fill("200")
    const save = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/ustva/expenses/${exp.id}`) && r.request().method() === "PUT",
      { timeout: 60_000 },
    )
    await page.getByTestId("ustva-expense-submit").click()
    const res = await save
    expect(res.status()).toBe(200)
    const updated = await res.json()
    expect([Number(updated.netAmount), Number(updated.vatAmount), Number(updated.grossAmount)]).toEqual([200, 38, 238])
    await expect(page.getByTestId("ustva-expense-editing")).toHaveCount(0)
    await expect(page.locator("tr", { hasText: tag })).toContainText("238,00")
    await request.delete(`${API}/api/v1/ustva/expenses/${exp.id}?companyId=${tokens.companyId}`, { headers: H })
  })

  test("a paid expense offers neither edit nor delete", async ({ page, request }) => {
    const tag = `t443-paid-${Date.now()}`
    const sup = await supplier(request, tag)
    const exp = await expense(request, tag, sup.id, 100)
    const batch = await request.post(`${API}/api/v1/payments/batches`, {
      headers: H,
      data: {
        companyId: tokens.companyId, expenseIds: [exp.id], executionDate: today,
        debtorIban: "DE02120300000000202051", debtorName: "Tier 443 GmbH",
      },
    })
    expect(batch.status(), "SEPA batch").toBe(201)
    await openPage(page)
    const locked = page.getByTestId(`ustva-expense-locked-${exp.id}`)
    await expect(locked).toBeVisible({ timeout: 30_000 })
    await expect(locked).toHaveAttribute("title", /SEPA/)
    await expect(page.getByTestId(`ustva-expense-edit-${exp.id}`)).toHaveCount(0)
    await expect(page.locator("tr", { hasText: tag }).getByRole("button", { name: /Löschen|Delete|删除/ })).toHaveCount(0)
    const { id } = await batch.json()
    await request.post(`${API}/api/v1/payments/batches/${id}/cancel?companyId=${tokens.companyId}`, {
      headers: H, data: { reason: "Testende" },
    })
    await request.delete(`${API}/api/v1/ustva/expenses/${exp.id}?companyId=${tokens.companyId}`, { headers: H })
  })
})
