/**
 * Tier 598 — the dashboard offers the operator's pages to the operator only.
 *
 * Every company's dashboard had cards for „Systemzustand“ and „Backups“; for
 * all but the operator they lead to „Diese Funktion ist dem Betreiber der
 * Installation vorbehalten“. GET /auth/me now says whether the session is the
 * operator's, and the two cards are shown only then.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a company that is not the operator sees no card for backups or scheduled jobs", async ({ page, request }) => {
  const tag = `t598-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier598-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const me = await (await request.get(`${API}/api/v1/auth/me`, { headers: { "x-user-id": userId, "x-company-id": companyId } })).json()
  expect(me.operator, "fixture: a freshly registered company is not the operator").toBe(false)
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard")
  // the hub has rendered: a card every company has
  await expect(page.getByTestId("dashboard-card-audit")).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  await expect(page.getByTestId("dashboard-card-backups")).toHaveCount(0)
  await expect(page.getByTestId("dashboard-card-system-health")).toHaveCount(0)
  // …and nothing on the page asked for the operator's data
  const forbidden: string[] = []
  page.on("response", (r) => { if (r.status() === 403) forbidden.push(r.url()) })
  await page.reload()
  await expect(page.getByTestId("dashboard-card-audit")).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  expect(forbidden, "requests answered 403 while loading the dashboard").toEqual([])

  // Tier 608: the error page is a company's own — without the operator's
  // notification settings, and without asking for them
  forbidden.length = 0
  await page.goto("/dashboard/system-errors")
  await page.waitForLoadState("networkidle")
  await expect(page.locator("body")).toContainText(/Fehler/)
  expect(forbidden, "requests answered 403 while loading the error page").toEqual([])
  await expect(page.getByTestId("threshold-count")).toHaveCount(0) // the alert-threshold form
  await expect(page.getByTestId("notif-test")).toHaveCount(0) // the test-notification button
})
