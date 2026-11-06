import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 807 — a ZM / OSS return marked as filed on the dashboard, and the ZM
 * card on a month (the ZM is monthly above 50 000 € of goods a quarter).
 *
 * Whether a ZM or OSS row is on the dashboard depends on the day and on the
 * company's sales, so the deadlines answer is given here (page.route) and
 * the PUT is caught: the test checks what the page shows and sends, not the
 * backend (spec 508 does that).
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

const row = (kind: string, status: string, p: { month?: number; quarter?: number }, dueDate: string, noteCode: string | null) => ({
  kind, year: 2026, month: p.month ?? null, quarter: p.quarter ?? null, periodName: "", periodEnd: "2026-10-31",
  dueDate, daysLeft: 19, status, noteCode, note: null,
})

test("a ZM row is marked as filed and the mark taken back; the link opens the ZM card on its month", async ({ page, request }) => {
  const real = await (await request.get(`${API}/api/v1/ustva/deadlines?companyId=${tk.companyId}`, { headers: H })).json()
  let zmStatus = "open"
  const sent: any[] = []
  await page.route("**/api/v1/ustva/deadlines?*", (route) =>
    route.fulfill({
      json: {
        ...real,
        deadlines: [
          row("zm", zmStatus, { month: 10 }, "2026-11-25", "zm-monthly"),
          row("oss", "open", { quarter: 3 }, "2026-11-30", "oss-check"),
        ],
      },
    }),
  )
  await page.route("**/api/v1/ustva/deadlines/filed?*", async (route) => {
    const body = route.request().postDataJSON()
    sent.push(body)
    zmStatus = body.filed ? "filed" : "open"
    await route.fulfill({ json: { key: "zm:2026:M10", filed: body.filed, changed: true } })
  })
  await injectAuth(page)
  await page.goto("/dashboard")
  const zm = page.locator('[data-testid="filing-deadline"][data-kind="zm"]')
  await expect(zm).toBeVisible({ timeout: 90_000 })
  await expect(zm).toContainText("monatlich")
  await expect(page.locator('[data-testid="filing-deadline"][data-kind="oss"] [data-testid="filing-deadline-mark"]')).toBeVisible()

  await zm.getByTestId("filing-deadline-mark").click()
  await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(1)
  expect(sent[0]).toEqual({ kind: "zm", year: 2026, month: 10, filed: true })
  await expect(page.locator('[data-testid="filing-deadline"][data-kind="zm"][data-status="filed"]')).toBeVisible({ timeout: 30_000 })

  await page.locator('[data-testid="filing-deadline"][data-kind="zm"] [data-testid="filing-deadline-mark"]').click()
  await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(2)
  expect(sent[1]).toEqual({ kind: "zm", year: 2026, month: 10, filed: false })
  await expect(page.locator('[data-testid="filing-deadline"][data-kind="zm"][data-status="open"]')).toBeVisible({ timeout: 30_000 })

  // the link of a monthly ZM: the card on October, the request by month
  const zmRequest = page.waitForRequest((r) => r.url().includes("/api/v1/ustva/zm?") && r.url().includes("month=10"), { timeout: 90_000 })
  await page.locator('[data-testid="filing-deadline"][data-kind="zm"] a').click()
  await expect(page).toHaveURL(/zmYear=2026&zmMonth=10#zm/, { timeout: 60_000 })
  await zmRequest
  await expect(page.getByTestId("zm-month")).toHaveValue("10", { timeout: 30_000 })
  await expect(page.getByTestId("zm-quarter")).toHaveValue("4")
  // the whole quarter again
  const quarterRequest = page.waitForRequest((r) => r.url().includes("/api/v1/ustva/zm?") && r.url().includes("quarter=4") && !r.url().includes("month="))
  await page.getByTestId("zm-month").selectOption("0")
  await quarterRequest
})
