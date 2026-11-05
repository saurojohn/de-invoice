import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 804 — the quarterly GewSt / KSt prepayments among the deadlines on the
 * dashboard. A row shows the Bescheid's amount (no "ca."), and its link opens
 * the accounting page on that year's form, the prepayments filled in (the form
 * opened on last year, the return's). The company's prepayments are put back
 * as they were after the file.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"
const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"
function tokens(): { userId: string; companyId: string } {
  const map: Record<string, string> = {}
  for (const line of readFileSync(AUTH_CACHE, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}
const tk = tokens()
const H = { "x-user-id": tk.userId, "x-company-id": tk.companyId }
const q = `companyId=${tk.companyId}`

async function injectAuth(page: Page) {
  await page.context().addCookies([
    { name: "x-user-id", value: tk.userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: tk.companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
  }, tk)
}

type Quarters = { q1: number; q2: number; q3: number; q4: number }
const before = new Map<number, { gewst: Quarters; hebesatz: number }>()
let years: number[] = []

test.beforeAll(async ({ request }) => {
  const d = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  const y = Number(String(d.today).slice(0, 4))
  years = [y, y + 1]
  for (const year of years) {
    const g = await (await request.get(`${API}/api/v1/accounting/gewst?${q}&year=${year}`, { headers: H })).json()
    const v = g.vorauszahlungen
    before.set(year, { gewst: { q1: v.q1, q2: v.q2, q3: v.q3, q4: v.q4 }, hebesatz: g.hebesatz })
    const res = await request.put(`${API}/api/v1/accounting/gewst/settings?${q}`, {
      headers: H, data: { year, q1: 1234.56, q2: 1234.56, q3: 1234.56, q4: 1234.56 },
    })
    expect(res.ok(), "the prepayments entered").toBeTruthy()
  }
})

test.afterAll(async ({ request }) => {
  for (const year of years) {
    const b = before.get(year)
    if (!b) continue
    const res = await request.put(`${API}/api/v1/accounting/gewst/settings?${q}`, { headers: H, data: { year, ...b.gewst } })
    expect(res.ok(), "the prepayments put back as they were").toBeTruthy()
  }
})

test("the next GewSt prepayment is on the dashboard and opens its year's form", async ({ page, request }) => {
  const d = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  const next = d.deadlines.find((x: any) => x.kind === "gewst" && x.status !== "overdue")
  expect(next, "the next GewSt prepayment is listed").toBeTruthy()
  expect(next.amount).toBe(1234.56)

  await injectAuth(page)
  await page.goto("/dashboard")
  const card = page.getByTestId("filing-deadlines-card")
  await expect(card).toBeVisible({ timeout: 90_000 })
  const row = card.locator(`[data-testid="filing-deadline"][data-kind="gewst"][data-status="${next.status}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText("GewSt-Vorauszahlung")
  await expect(row.getByTestId("filing-deadline-amount")).toHaveText("1.234,56 €")
  await expect(row).not.toContainText("deadlines.")

  await row.locator("a").click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/accounting\\?gewstYear=${next.year}#form-gewst`), { timeout: 60_000 })
  await expect(page.getByTestId("gewst-year")).toHaveValue(String(next.year), { timeout: 60_000 })
  await expect(page.getByTestId(`gewst-vq-q${next.quarter}`)).toHaveValue("1234.56", { timeout: 30_000 })
  // the sections above loaded after the jump; the form is still where the link pointed
  await expect(page.getByTestId("gewst-section")).toBeInViewport({ timeout: 10_000 })
  // the card's title names returns and payments alike
  await page.goto("/dashboard")
  await expect(page.getByTestId("filing-deadlines-card")).toContainText("Nächste Steuertermine", { timeout: 90_000 })
})
