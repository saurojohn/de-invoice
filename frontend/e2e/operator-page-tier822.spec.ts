import { test, expect, type Page } from "@playwright/test"
import { getTestEnv } from "./fixtures/test-env"

/**
 * Tier 822 — the operator's functions on one page, „Systembetrieb“.
 *
 * They were spread over the dashboard (a card for the scheduled jobs, one for
 * the backups), the user page (the registration and the company
 * invitations), the company settings (the storage) and the error page (the
 * notification channels). The dashboard has one card now; the page sums up
 * each area with its state and links to its own page, and holds the
 * registration card. A company that is not the operator gets a notice, and
 * nothing on the page asks for the operator's data.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId })
}

const AREAS = ["server", "jobs", "backups", "storage", "errors"]

test("the operator finds every operator function on „Systembetrieb“", async ({ page }) => {
  test.setTimeout(240_000)
  const { userId, companyId } = getTestEnv()
  await signIn(page, userId, companyId)
  const forbidden: string[] = []
  page.on("response", (r) => { if (r.status() === 403) forbidden.push(r.request().method() + " " + r.url()) })

  // the dashboard: one card instead of two
  const me = page.waitForResponse((r) => r.url().includes("/api/v1/auth/me") && r.request().method() === "GET", { timeout: 90_000 })
  await page.goto("/dashboard")
  const meBody = await (await me).json()
  expect(meBody.operator, `GET /auth/me as the seed admin: ${JSON.stringify({ role: meBody.role, operator: meBody.operator })}`).toBe(true)
  const card = page.getByTestId("dashboard-card-operator")
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("dashboard-card-backups")).toHaveCount(0)
  await expect(page.getByTestId("dashboard-card-system-health")).toHaveCount(0)
  await card.click()
  await expect(page).toHaveURL(/\/dashboard\/operator$/, { timeout: 60_000 })

  // every area answered, with what it found
  for (const id of AREAS) {
    const area = page.getByTestId(`operator-area-${id}`)
    await expect(area, `area ${id}`).not.toHaveAttribute("data-health", "loading", { timeout: 90_000 })
    await expect(area, `area ${id}`).not.toContainText("Konnte nicht abgerufen werden")
  }
  await expect(page.getByTestId("operator-area-server")).toContainText("Datenbank erreichbar")
  await expect(page.getByTestId("operator-area-jobs")).toContainText("Hintergrundjobs:")
  await expect(page.getByTestId("operator-area-backups")).toContainText("Datenbank:")
  await expect(page.getByTestId("operator-area-errors")).toContainText("E-Mail-Versand (SMTP):")
  await expect(page.getByTestId("operator-overall")).toBeVisible()
  // …each with the way to its page
  await expect(page.getByTestId("operator-link-jobs")).toHaveAttribute("href", "/dashboard/system-health")
  await expect(page.getByTestId("operator-link-backups")).toHaveAttribute("href", "/dashboard/backups")
  await expect(page.getByTestId("operator-link-storage")).toHaveAttribute("href", "/dashboard/settings#storage")
  await expect(page.getByTestId("operator-link-errors")).toHaveAttribute("href", "/dashboard/system-errors")
  // the registration and the company invitations, in full
  await expect(page.getByTestId("registration-card")).toBeVisible()
  await expect(page.getByTestId("company-invite-email")).toBeVisible()

  // the pages it links to lead back
  // (a page the dev server compiles on first use takes longer than 5 s)
  await page.getByTestId("operator-link-jobs").click()
  await expect(page).toHaveURL(/\/dashboard\/system-health$/, { timeout: 60_000 })
  await page.getByTestId("back-to-operator").click()
  await expect(page).toHaveURL(/\/dashboard\/operator$/, { timeout: 60_000 })

  // the user page points the operator here
  await page.goto("/dashboard/settings/users")
  await expect(page.getByTestId("operator-page-link")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("registration-card")).toHaveCount(0)

  // on a phone it fits the width
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/dashboard/operator")
  await expect(page.getByTestId("operator-area-errors")).not.toHaveAttribute("data-health", "loading", { timeout: 90_000 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, "pixels wider than a phone").toBeLessThanOrEqual(0)

  expect(forbidden, "requests answered 403").toEqual([])
})

test("a company that is not the operator gets the notice and asks for nothing", async ({ page, request }) => {
  const tag = `t822-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier822-e2e", companyName: `${tag} GmbH` },
  })).json()
  const uid: string = reg.user.id
  const cid: string = reg.user.companyId || reg.company.id
  await signIn(page, uid, cid)
  const forbidden: string[] = []
  page.on("response", (r) => { if (r.status() === 403) forbidden.push(r.request().method() + " " + r.url()) })
  await page.goto("/dashboard/operator")
  await expect(page.getByTestId("operator-not-allowed")).toBeVisible({ timeout: 90_000 })
  await page.waitForLoadState("networkidle")
  await expect(page.getByTestId("registration-card")).toHaveCount(0)
  await expect(page.getByTestId("operator-area-server")).toHaveCount(0)
  expect(forbidden, "requests answered 403").toEqual([])
})
