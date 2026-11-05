import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 805 — the tax deadlines as a calendar subscription, made on the UStVA
 * page. The link is shown once; afterwards the page says only that one is
 * active. A new link replaces it, and it can be withdrawn. The company's link
 * is withdrawn after the file.
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

/** The feed of a link, fetched from the backend this run talks to. */
const feedUrl = (url: string) => `${API}/api/v1/calendar/${url.split("/").pop()}`

test.beforeAll(async ({ request }) => {
  await request.delete(`${API}/api/v1/ustva/calendar?${q}`, { headers: H })
})
test.afterAll(async ({ request }) => {
  const res = await request.delete(`${API}/api/v1/ustva/calendar?${q}`, { headers: H })
  expect(res.ok(), "the calendar link withdrawn").toBeTruthy()
})

test("a calendar link is made, shown once, replaced and withdrawn", async ({ page, request }) => {
  await injectAuth(page)
  page.on("dialog", (d) => d.accept())
  await page.goto("/dashboard/accounting/ustva?period=year")
  const box = page.getByTestId("calendar-link")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await expect(box).not.toContainText("deadlines.")
  await expect(page.getByTestId("calendar-link-active")).toHaveCount(0)

  // made: the link is shown, the feed answers
  await page.getByTestId("calendar-link-create").click()
  const input = page.getByTestId("calendar-link-url")
  await expect(input).toHaveValue(/\/api\/v1\/calendar\/[A-Za-z0-9_-]{43}\.ics$/, { timeout: 30_000 })
  const first = await input.inputValue()
  await expect(page.getByTestId("calendar-link-open")).toHaveAttribute("href", first.replace(/^https?:/, "webcal:"))
  const feed = await request.get(feedUrl(first))
  expect(feed.status()).toBe(200)
  expect(feed.headers()["content-type"]).toContain("text/calendar")
  expect(await feed.text()).toContain("BEGIN:VEVENT")

  // after a reload: active, the link itself no longer shown
  await page.reload()
  await expect(page.getByTestId("calendar-link-active")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("calendar-link-url")).toHaveCount(0)

  // replaced: the old link stops
  await page.getByTestId("calendar-link-create").click()
  await expect(input).toHaveValue(/\.ics$/, { timeout: 30_000 })
  const second = await input.inputValue()
  expect(second).not.toBe(first)
  expect((await request.get(feedUrl(first))).status()).toBe(404)
  expect((await request.get(feedUrl(second))).status()).toBe(200)

  // withdrawn
  await page.getByTestId("calendar-link-revoke").click()
  await expect(page.getByTestId("calendar-link-revoke")).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId("calendar-link-url")).toHaveCount(0)
  expect((await request.get(feedUrl(second))).status()).toBe(404)
})
