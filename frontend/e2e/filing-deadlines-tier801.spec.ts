import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 801 — the filing deadlines on the dashboard, and the period the UStVA,
 * ZM and OSS reports open on.
 *
 * The UStVA page opened on the whole running year and the ZM / OSS on the
 * running quarter; the return actually due was a few clicks away, and no page
 * said when it was due. Now:
 *   1. the dashboard lists the returns due next (GET /ustva/deadlines), each
 *      linking to its period;
 *   2. the UStVA page and its ZM card open on the period the backend names,
 *      the OSS tab on the last ended quarter;
 *   3. the rhythm and the Dauerfristverlängerung are set on the UStVA page.
 * The company's settings are put back as they were after the file.
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

let before: { ustvaRhythmus: string | null; dauerfristverlaengerung: boolean | null } | null = null

test.beforeAll(async ({ request }) => {
  const d = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  before = {
    ustvaRhythmus: d.rhythmSource === "setting" ? d.rhythm : null,
    dauerfristverlaengerung: d.dauerfristSource === "setting" ? d.dauerfrist : null,
  }
})

test.afterAll(async ({ request }) => {
  if (!before) return
  const res = await request.put(`${API}/api/v1/ustva/filing-settings?${q}`, { headers: H, data: before })
  expect(res.ok(), "the settings put back as they were").toBeTruthy()
})

const dmy = (iso: string) => iso.split("-").reverse().join(".")

test("the dashboard lists the returns due next, each linking to its period", async ({ page, request }) => {
  const d = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  await injectAuth(page)
  await page.goto("/dashboard")
  const card = page.getByTestId("filing-deadlines-card")
  await expect(card).toBeVisible({ timeout: 90_000 })
  const rows = card.getByTestId("filing-deadline")
  await expect(rows).toHaveCount(d.deadlines.length, { timeout: 30_000 })
  const running = d.deadlines.find((x: any) => x.kind === "ustva" && x.status === "running")
  expect(running, "the running UStVA period is always listed").toBeTruthy()
  const row = card.locator('[data-testid="filing-deadline"][data-kind="ustva"][data-status="running"]')
  await expect(row.getByTestId("filing-deadline-due")).toHaveText(`fällig am ${dmy(running.dueDate)}`)
  // the link opens the UStVA page on that period
  await row.locator("a").click()
  await expect(page).toHaveURL(/\/dashboard\/accounting\/ustva\?year=\d{4}&(month|quarter)=\d+/, { timeout: 60_000 })
  const period = page.locator("select").first()
  await expect(period).toHaveValue(running.month ? `m${running.month}` : `q${running.quarter}`, { timeout: 30_000 })
})

test("the UStVA page and its ZM card open on the period due, the OSS tab on the last ended quarter", async ({ page, request }) => {
  const d = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  await injectAuth(page)
  const computed = page.waitForResponse((r) => r.url().includes("/api/v1/ustva/compute"), { timeout: 90_000 })
  await page.goto("/dashboard/accounting/ustva")
  const first = await computed
  // the first computation is already the period due — not the year, then the period
  const u = d.defaults.ustva
  expect(first.url()).toContain(`year=${u.year}`)
  expect(first.url()).toContain(u.month ? `month=${u.month}` : `quarter=${u.quarter}`)
  await expect(page.locator("select").first()).toHaveValue(u.month ? `m${u.month}` : `q${u.quarter}`)
  await expect(page.getByTestId("zm-year")).toHaveValue(String(d.defaults.zm.year), { timeout: 30_000 })
  await expect(page.getByTestId("zm-quarter")).toHaveValue(String(d.defaults.zm.quarter))

  await page.goto("/dashboard/reports?tab=oss")
  await expect(page.getByTestId("oss-tab")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("oss-year")).toHaveValue(String(d.defaults.oss.year), { timeout: 30_000 })
  await expect(page.getByTestId("oss-quarter")).toHaveValue(String(d.defaults.oss.quarter))
})

test("the rhythm and the Dauerfristverlängerung are set on the UStVA page", async ({ page, request }) => {
  const d = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  const other = d.rhythm === "monthly" ? "quarterly" : "monthly"
  await injectAuth(page)
  await page.goto("/dashboard/accounting/ustva?period=year")
  const rhythm = page.getByTestId("ustva-rhythm")
  await expect(rhythm).toHaveValue(d.rhythm, { timeout: 90_000 })
  const saved = page.waitForResponse((r) => r.url().includes("/api/v1/ustva/filing-settings") && r.request().method() === "PUT", { timeout: 60_000 })
  await rhythm.selectOption(other)
  expect((await saved).status()).toBe(200)
  await expect(page.getByTestId("ustva-rhythm-source")).toHaveText("festgelegt", { timeout: 30_000 })
  await expect(rhythm).toHaveValue(other)

  const dauerfrist = page.getByTestId("ustva-dauerfrist")
  const wasOn = await dauerfrist.isChecked()
  const saved2 = page.waitForResponse((r) => r.url().includes("/api/v1/ustva/filing-settings") && r.request().method() === "PUT", { timeout: 60_000 })
  await dauerfrist.click()
  expect((await saved2).status()).toBe(200)
  await expect(dauerfrist).toBeChecked({ checked: !wasOn, timeout: 30_000 })
  await expect(page.getByTestId("ustva-dauerfrist-source")).toHaveText("festgelegt")

  const now = await (await request.get(`${API}/api/v1/ustva/deadlines?${q}`, { headers: H })).json()
  expect([now.rhythm, now.rhythmSource, now.dauerfrist, now.dauerfristSource]).toEqual([other, "setting", !wasOn, "setting"])
  // the dashboard says nothing is assumed any more
  await page.goto("/dashboard")
  await expect(page.getByTestId("filing-deadlines-card")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("filing-deadline").first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("filing-deadlines-assumed")).toHaveCount(0)
})
