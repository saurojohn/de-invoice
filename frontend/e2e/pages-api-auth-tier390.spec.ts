/**
 * Tier 390 — pages that called the backend without the auth headers.
 *
 * Measured in Chromium before the change:
 *   /dashboard/reminders "Erinnerung per E-Mail senden": email-data, /reminders/send
 *     and the refresh were raw fetches without x-user-id → 401 ×3, no Mahnung
 *   /dashboard/reminders/templates: GET /reminders/templates (no /api/v1) → 404,
 *     the page listed no templates
 *   /dashboard/accounting/ustva: POST /ustva/expenses, DELETE /ustva/expenses/:id and
 *     POST /ustva/filings without the headers → 401
 *   /dashboard/import "Vorlage herunterladen": a relative fetch to the Next server → 404
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { readFileSync } from "fs"

const API = "http://localhost:3001"
let tokens: { userId: string; companyId: string }
let H: Record<string, string>

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

async function overdueInvoice(request: APIRequestContext, tag: string) {
  const q = `companyId=${tokens.companyId}`
  const cust = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H,
    data: { name: `${tag} Kunde`, type: "business", contact: { email: `${tag}@example.test` } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: {
      customerId: cust.id,
      issueDate: "2026-01-01T00:00:00Z",
      dueDate: "2026-01-31T00:00:00Z",
      items: [{ description: tag, quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }],
    },
  })).json()
  const st = await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })
  expect(st.status(), "invoice set to sent").toBe(200)
  return inv as { id: string; invoiceNumber: string }
}

test.describe("Tier 390 — pages call the API with the auth headers", () => {
  test.setTimeout(180_000)

  test("reminders page sends the reminder", async ({ page, request }) => {
    const inv = await overdueInvoice(request, `t390-${Date.now()}`)
    await injectAuth(page)
    await page.goto("/dashboard/reminders")
    const card = page.locator(`[data-testid="reminder-card"][data-invoice-number="${inv.invoiceNumber}"]`)
    await expect(card).toBeVisible({ timeout: 90_000 })
    await page.waitForFunction(() => document.readyState === "complete")
    const send = page.waitForResponse(
      (r) => r.url().includes("/api/v1/reminders/send") && r.request().method() === "POST",
      { timeout: 60_000 },
    )
    await card.getByRole("button", { name: /E-Mail senden/ }).click()
    const res = await send
    expect(res.status(), "POST /reminders/send (401 before)").toBe(201)
    expect((await res.request().allHeaders())["x-user-id"]).toBe(tokens.userId)
    const list = await (await request.get(
      `${API}/api/v1/reminders/mahnungen?companyId=${tokens.companyId}&status=all`,
      { headers: H },
    )).json()
    const rows = (list.mahnungen || []).filter((m: { invoiceId: string }) => m.invoiceId === inv.id)
    expect(rows.length, "one Mahnung recorded").toBe(1)
  })

  test("reminder templates page loads the templates", async ({ page }) => {
    await injectAuth(page)
    const templates = page.waitForResponse(
      (r) => r.url().includes("/reminders/templates?") && r.request().method() === "GET",
      { timeout: 90_000 },
    )
    await page.goto("/dashboard/reminders/templates")
    const res = await templates
    expect(res.url(), "backend URL").toContain(`${API}/api/v1/reminders/templates`)
    expect(res.status(), "templates (404 before)").toBe(200)
  })

  test("UStVA page saves an expense", async ({ page, request }) => {
    const tag = `t390-ustva-${Date.now()}`
    await injectAuth(page)
    await page.goto("/dashboard/accounting/ustva")
    const toggle = page.getByTestId("ustva-add-expense-toggle")
    await expect(toggle).toBeVisible({ timeout: 90_000 })
    await page.waitForFunction(() => document.readyState === "complete")
    await expect(async () => {
      await toggle.click()
      await expect(page.getByTestId("ustva-expense-description")).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    await page.getByTestId("ustva-expense-description").fill(tag)
    await page.getByTestId("ustva-expense-net").fill("100")
    const save = page.waitForResponse(
      (r) => r.url().includes("/api/v1/ustva/expenses") && r.request().method() === "POST",
      { timeout: 60_000 },
    )
    await page.getByTestId("ustva-expense-submit").click()
    const res = await save
    expect(res.status(), "POST /ustva/expenses (401 before)").toBe(201)
    const created = await res.json()
    // cleanup
    if (created?.id) {
      await request.delete(`${API}/api/v1/ustva/expenses/${created.id}?companyId=${tokens.companyId}`, { headers: H })
    }
  })

  test("import page downloads the CSV template", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/import")
    const btn = page.getByRole("button", { name: /Vorlage herunterladen/ })
    await expect(btn).toBeVisible({ timeout: 90_000 })
    await page.waitForFunction(() => document.readyState === "complete")
    const tpl = page.waitForResponse((r) => r.url().includes("/import/template.csv"), { timeout: 60_000 })
    const download = page.waitForEvent("download", { timeout: 60_000 })
    await btn.click()
    const res = await tpl
    expect(res.url(), "backend URL (the Next server answered 404)").toContain(`${API}/api/v1/`)
    expect(res.status()).toBe(200)
    expect((await download).suggestedFilename()).toMatch(/template\.csv$/)
  })
})
