/**
 * Tier 643 — the accounting page puts the forms of the company's legal form first.
 *
 * Before: nineteen forms in one fixed order for everyone — a GmbH found its
 * KSt 1 between Anlage N (wages) and Anlage R (pensions).
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function open(page: Page, request: APIRequestContext, companyName: string) {
  const tag = `t643-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier643-e2e", companyName },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().clearCookies()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/accounting")
  await expect(page.locator("[data-form-section]").first()).toBeVisible({ timeout: 60_000 })
}
const order = (page: Page) => page.locator("[data-form-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-form-section")))
// true when a stands before b in the document
const before = (page: Page, a: string, b: string) =>
  page.evaluate(([a, b]) => {
    const x = document.querySelector(a), y = document.querySelector(b)
    return !!x && !!y && !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING)
  }, [a, b])

test("a GmbH: KSt 1 and the annual accounts first, the annexes of a person's return under their own line", async ({ page, request }) => {
  test.setTimeout(180_000)
  await open(page, request, "Tier643 Handel GmbH")
  const divider = page.getByTestId("forms-other")
  await expect(divider).toBeVisible({ timeout: 60_000 })
  await expect(divider).toContainText("Für die Rechtsform „GmbH“ nicht einschlägig")
  await expect(divider).toContainText("aus dem Firmennamen abgeleitet")
  const keys = await order(page)
  expect(keys).toHaveLength(19)
  expect(new Set(keys).size).toBe(19)
  expect(keys.slice(0, 9)).toEqual(["beraterPackager", "kst1", "ustja", "gewst", "bilanz", "guv", "anhang", "ebilanz", "gobdArchive"])
  // in the page: KSt 1 above the line, Anlage N below it — and both still there to use
  expect(await before(page, '[data-testid="kst1-year"]', '[data-testid="forms-other"]')).toBe(true)
  expect(await before(page, '[data-testid="forms-other"]', '[data-testid="anlage-n-year"]')).toBe(true)
  await expect(page.getByTestId("anlage-n-year")).toBeVisible()
})

test("a company whose legal form is not known: the old order, no line", async ({ page, request }) => {
  test.setTimeout(180_000)
  await open(page, request, "Tier643 Werkstatt")
  const keys = await order(page)
  expect(keys).toHaveLength(19)
  expect(keys.slice(0, 4)).toEqual(["beraterPackager", "euer", "anlageS", "anlageV"])
  await expect(page.getByTestId("forms-other")).toHaveCount(0)
})
