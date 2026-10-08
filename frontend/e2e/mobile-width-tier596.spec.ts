/**
 * Tier 596 — no page is wider than a phone.
 *
 * A walk through all 64 pages at 390 × 844 found 21 on which the whole page
 * scrolled sideways (up to 543 px): a header row of buttons that never
 * wrapped, the invoice-type buttons, two tables. globals.css lets such rows
 * wrap and tables scroll inside their box below 640 px.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test.use({ viewport: { width: 390, height: 844 } })

// the worst twelve of the walk, with what they overflowed by
const PAGES: [string, number][] = [
  ["/dashboard/system-errors", 543],
  ["/dashboard/reminders", 525],
  ["/dashboard/mahnungen/settings", 356],
  ["/dashboard/products", 349],
  ["/dashboard/invoices/create", 279],
  ["/dashboard/v2", 252],
  ["/dashboard/accounting/ustva", 190],
  ["/dashboard/reports/aging", 181],
  ["/dashboard/settings", 173],
  ["/dashboard/settings/users", 165],
  ["/dashboard/cashbook", 152],
  ["/dashboard/cost-center-report", 95],
]

test("the pages that were wider than a phone fit now", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t596-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier596-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
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
  const tooWide: string[] = []
  for (const [route, was] of PAGES) {
    await page.goto(route)
    await page.waitForLoadState("networkidle").catch(() => undefined)
    await expect(page.locator("body")).not.toBeEmpty()
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (over > 4) tooWide.push(`${route} +${over}px (was +${was})`)
  }
  expect(tooWide, "pages wider than the 390 px screen").toEqual([])
})
