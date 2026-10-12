/**
 * Tier 669 — a year field asks for whole years only.
 *
 * Before: every year field loaded on each keystroke. Typing „2024“ asked
 * the server for the years 2, 20 and 202 — three refusals and three times
 * „year ist ungültig“ on the screen, in each of the nineteen forms of the
 * accounting page and on seven other pages.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function company(page: Page, request: APIRequestContext) {
  const tag = `t669-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier669-e2e", companyName: `${tag} Einzelunternehmen` },
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
}

// what the server refused, and the years it was asked for
function watch(page: Page) {
  const refused: string[] = []
  const years: string[] = []
  page.on("response", (r) => {
    const url = new URL(r.url())
    if (!url.pathname.includes("/api/v1/")) return
    const year = url.searchParams.get("year")
    if (year) years.push(year)
    if (r.status() >= 400) refused.push(`${r.status()} ${url.pathname}?year=${year}`)
  })
  return { refused, years }
}
async function type(page: Page, testId: string, text: string) {
  const field = page.getByTestId(testId)
  await field.scrollIntoViewIfNeeded()
  await field.click({ clickCount: 3 })
  await page.keyboard.type(text, { delay: 80 })
  return field
}

test("the accounting page: typing a year asks for that year, once", async ({ page, request }) => {
  test.setTimeout(240_000)
  await company(page, request)
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("anlage-so-vordruck-table")).toBeVisible({ timeout: 120_000 })
  await page.waitForLoadState("networkidle")
  const seen = watch(page)

  for (const id of ["euer-year", "anlage-r-year", "anlage-so-year-input", "gewst-year", "anlage-aus-year-input"]) {
    seen.refused.length = 0
    seen.years.length = 0
    const asked = page.waitForResponse((r) => new URL(r.url()).searchParams.get("year") === "2021" && r.ok())
    const field = await type(page, id, "2021")
    await asked
    await page.waitForLoadState("networkidle")
    expect(seen.refused, `${id}: nothing refused`).toEqual([])
    // no half-typed year — a late answer to the page's first load (last year)
    // may still arrive here on a slow machine (CI run 38285101244)
    expect(seen.years.filter((y) => !/^\d{4}$/.test(y)), `${id}: no half-typed year (was: 2, 20, 202)`).toEqual([])
    expect(seen.years, `${id}: asked for 2021`).toContain("2021")
    await expect(field).toHaveValue("2021")
  }
  await expect(page.getByText("year ist ungültig")).toHaveCount(0)

  // a year left half-typed: nothing is asked, and the field goes back to the year that is shown
  seen.years.length = 0
  const field = await type(page, "anlage-kap-year", "20")
  await expect(field).toHaveValue("20")
  await page.getByTestId("anlage-kap-year").blur()
  await expect(field).toHaveValue(String(new Date().getFullYear() - 1))
  expect(seen.years.filter((y) => !/^\d{4}$/.test(y))).toEqual([])
})

test("the assets page and the reports: the same field", async ({ page, request }) => {
  test.setTimeout(240_000)
  await company(page, request)
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 120_000 })
  await page.waitForLoadState("networkidle")
  const seen = watch(page)
  const field = await type(page, "assets-year", "2022")
  await page.waitForLoadState("networkidle")
  await expect(field).toHaveValue("2022")
  expect(seen.refused).toEqual([])
  expect(seen.years.filter((y) => !/^\d{4}$/.test(y))).toEqual([])
  expect(seen.years).toContain("2022")
})
