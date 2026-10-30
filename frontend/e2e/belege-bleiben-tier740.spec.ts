/**
 * Tier 740 — a Beleg stays: the expense's receipts panel.
 *
 * In closed books the removal is refused and the page says why (the panel
 * only logged the failure to the console); a wrong file on an open expense
 * goes off the record after a question that says it is kept, and can be put
 * back (Tier 745). (The rules: backend specs 460, 465.)
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function as(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-30T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

async function expenseWithBeleg(request: APIRequestContext, H: Record<string, string>, companyId: string, number: string, date: string) {
  const expense = await (await request.post(`${API}/api/v1/expenses?companyId=${companyId}`, {
    headers: H,
    data: { description: "Beleg", invoiceDate: date, invoiceNumber: number, netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119 },
  })).json()
  const attached = await request.post(`${API}/api/v1/attachments`, {
    headers: H,
    multipart: {
      companyId, entityType: "expense", entityId: expense.id,
      file: { name: `${number}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4 ${number}\n`) },
    },
  })
  expect(attached.status()).toBe(201)
  return expense.id as string
}

test("the receipts panel: refused in closed books, with the reason; an open expense's file goes off the record", async ({ page, request }) => {
  const tag = `t740-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier740-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const closed = await expenseWithBeleg(request, H, companyId, `${tag}-A`, "2026-09-15")
  const open = await expenseWithBeleg(request, H, companyId, `${tag}-B`, "2026-10-15")
  expect((await request.put(`${API}/api/v1/accounting/books-closing?companyId=${companyId}`, {
    headers: H, data: { closedUntil: "2026-09-30", reason: "Tier 740" },
  })).status()).toBe(200)

  await as(page, userId, companyId)
  await page.goto("/dashboard/expenses")
  await expect(page.getByTestId(`expense-open-${closed}`)).toBeVisible({ timeout: 90_000 })
  await page.waitForLoadState("networkidle")
  const messages: string[] = []
  page.on("dialog", (d) => { messages.push(d.message()); void d.accept() })

  await page.getByTestId(`expense-open-${closed}`).click()
  await page.getByTestId("attachment-remove").click()
  await expect(page.getByTestId("attachment-remove-error")).toContainText("Beleg", { timeout: 30_000 })
  await expect(page.getByTestId("attachment-remove")).toHaveCount(1)
  await page.getByRole("button", { name: /Schließen|Close|关闭/ }).first().click()

  await page.getByTestId(`expense-open-${open}`).click()
  await page.getByTestId("attachment-remove").click()
  await expect(page.getByTestId("attachment-remove")).toHaveCount(0, { timeout: 30_000 })
  expect(messages.at(-1)).toContain("nicht vernichtet")

  // Tier 745: the way back
  const removed = page.getByTestId("attachments-removed")
  await expect(removed).toContainText("Entfernte Belege (1)", { timeout: 30_000 })
  await removed.locator("summary").click()
  await expect(page.getByTestId("attachment-removed-row")).toContainText(`${tag}-B.pdf`)
  await expect(page.getByTestId("attachment-removed-row")).toContainText(`${tag}@example.test`)
  await page.getByTestId("attachment-restore").click()
  await expect(page.getByTestId("attachment-remove")).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId("attachments-removed")).toHaveCount(0)
})
