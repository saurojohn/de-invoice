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

// Tier 646c: the sections are on the page from the first render and are moved,
// not placed late and not mounted again. Placing them only once the answer
// was there (Tier 643) made two other tests of this page need their retry in
// every CI run: a field filled right after the page loaded was overwritten by
// the section's own load, which now came later.
test("the sections are there before the answer and keep what was typed when they move", async ({ page, request }) => {
  test.setTimeout(180_000)
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/v1/accounting/forms?*", async (route) => {
    await held
    await route.continue()
  })
  await open(page, request, "Tier643 Langsam GmbH")
  // the answer is still held back: the old order, no line
  expect((await order(page)).slice(0, 3)).toEqual(["beraterPackager", "euer", "anlageS"])
  await expect(page.getByTestId("forms-other")).toHaveCount(0)
  const year = page.getByTestId("kst1-year")
  await expect(year).toBeVisible({ timeout: 60_000 })
  await year.fill("2019")
  await page.evaluate(() => { (document.querySelector('[data-form-section="kst1"]') as HTMLElement).dataset.seen = "before" })
  release()
  await expect(page.getByTestId("forms-other")).toBeVisible({ timeout: 60_000 })
  expect((await order(page)).slice(0, 2)).toEqual(["beraterPackager", "kst1"])
  // the same element, moved — and the field still holds what was typed
  await expect(page.locator('[data-form-section="kst1"]')).toHaveAttribute("data-seen", "before")
  await expect(year).toHaveValue("2019")
})

test("a company whose legal form is not known: the old order, no line", async ({ page, request }) => {
  test.setTimeout(180_000)
  await open(page, request, "Tier643 Werkstatt")
  const keys = await order(page)
  expect(keys).toHaveLength(19)
  expect(keys.slice(0, 4)).toEqual(["beraterPackager", "euer", "anlageS", "anlageV"])
  await expect(page.getByTestId("forms-other")).toHaveCount(0)
})
