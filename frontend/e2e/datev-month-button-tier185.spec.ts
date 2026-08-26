/**
 * Tier 185 — frontend DATEV month bundle button
 *
 * Background: Tier 167 added the year-scoped
 * DATEV-Buchungsstapel ZIP download button.
 * Tier 184 added the backend's `?year=&month=`
 * shortcut. This tier wires a "Monats-Archiv"
 * button + year/month pickers to that
 * endpoint on the DATEV-Export tab.
 *
 * Tests:
 *   1. page renders the new "Monats-Archiv" button
 *   2. page renders the new year <select> +
 *      month <select> next to the button
 *   3. clicking the button opens a new tab to
 *      the month-scoped bundle URL
 *      (`?year=YYYY&month=N`)
 *   4. error path: month=13 → 400 with German
 *      error (asserted via direct API call;
 *      the <select> only offers 1-12 so the
 *      UI can't trigger this)
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"
const COMPANY_ID = (() => {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const m = env.match(/^COMPANY_ID=(.*)$/m)
  if (!m) throw new Error("COMPANY_ID not in auth cache")
  return m[1]
})()
const USER_ID = (() => {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const m = env.match(/^USER_ID=(.*)$/m)
  if (!m) throw new Error("USER_ID not in auth cache")
  return m[1]
})()

async function loginAsTestUser(page: any) {
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId: USER_ID, companyId: COMPANY_ID },
  )
  await page.context().addCookies([
    {
      name: "x-user-id",
      value: USER_ID,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: COMPANY_ID,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
}

test.describe("Tier 185 — frontend DATEV month bundle button", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsTestUser(page)
  })

  test("1. page renders the new Monats-Archiv button", async ({ page }) => {
    page.setDefaultTimeout(60_000)
    await page.goto("/dashboard/reports", {
      timeout: 90_000,
      waitUntil: "domcontentloaded",
    })
    // Switch to the DATEV-Export tab (the
    // DatevExportTab component is only mounted
    // when activeTab === "datev"). The tab
    // toggle has data-testid="tab-datev".
    const datevTab = page.getByTestId("tab-datev")
    await expect(datevTab).toBeVisible({ timeout: 30_000 })
    // Make sure the React onClick handler is attached
    // (hydration complete) before clicking. Hydrating
    // /dashboard/reports on a cold compile takes 10-15s
    // and a click before hydration lands silently does
    // nothing — the page would stay on the sales tab.
    await page.waitForFunction(
      () => {
        // The DATEV-Export tab button's class list
        // includes the active styling when activeTab
        // changes. Before hydration, clicking doesn't
        // set the state. We detect hydration by
        // checking that the page has finished loading
        // its first network roundtrip.
        return document.readyState === 'complete'
      },
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    await datevTab.click()
    // The DatevExportTab component is mounted on
    // activeTab === "datev"; its first render
    // includes the datev-bundle-month-btn.
    await page.waitForSelector('[data-testid="datev-bundle-month-btn"]', { timeout: 30_000, state: 'visible' })
    const btn = page.getByTestId("datev-bundle-month-btn")
    await expect(btn).toBeVisible({ timeout: 30_000 })
    // i18n: button is hardcoded German
    // "Monats-Archiv (ZIP)" for now.
    await expect(btn).toContainText(/Monats-Archiv/i)
  })

  test("2. page renders the new year + month pickers", async ({ page }) => {
    page.setDefaultTimeout(60_000)
    await page.goto("/dashboard/reports", {
      timeout: 90_000,
      waitUntil: "domcontentloaded",
    })
    const datevTab = page.getByTestId("tab-datev")
    await expect(datevTab).toBeVisible({ timeout: 30_000 })
    // Same hydration wait as test 1 — the React
    // onClick handler isn't attached until React
    // hydrates the page, and the cold compile
    // of /dashboard/reports can take 10-15s.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    await datevTab.click()
    const yearSel = page.getByTestId("datev-bundle-month-year")
    const monthSel = page.getByTestId("datev-bundle-month-month")
    await expect(yearSel).toBeVisible({ timeout: 30_000 })
    await expect(monthSel).toBeVisible({ timeout: 30_000 })
    // The year <select> default is 4-digit year
    const year = await yearSel.inputValue()
    expect(year, `year default should be 4-digit, got: ${year}`).toMatch(
      /^\d{4}$/,
    )
    // The month <select> default is 1-12
    const month = await monthSel.inputValue()
    expect(month, `month default should be 1-12, got: ${month}`).toMatch(
      /^(1[0-2]|[1-9])$/,
    )
    // The first month <option> should be "01 — Januar"
    const firstOption = await monthSel.locator("option").first().textContent()
    expect(firstOption, `first option should start with 01, got: ${firstOption}`).toMatch(
      /^01/,
    )
  })

  test("3. clicking the button opens a new tab to the month bundle URL", async ({ page, context }) => {
    page.setDefaultTimeout(60_000)
    await page.goto("/dashboard/reports", {
      timeout: 90_000,
      waitUntil: "domcontentloaded",
    })
    const datevTab = page.getByTestId("tab-datev")
    await expect(datevTab).toBeVisible({ timeout: 30_000 })
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    await datevTab.click()
    // Set year + month
    const yearSel = page.getByTestId("datev-bundle-month-year")
    const monthSel = page.getByTestId("datev-bundle-month-month")
    await expect(yearSel).toBeVisible({ timeout: 30_000 })
    await yearSel.selectOption("2026")
    await monthSel.selectOption("7")
    const btn = page.getByTestId("datev-bundle-month-btn")
    await expect(btn).toBeEnabled({ timeout: 10_000 })

    // The button calls `window.open(url, "_blank")`
    // which Playwright turns into a popup event.
    const popupPromise = context.waitForEvent("page", { timeout: 30_000 })
    await btn.click()
    const popup = await popupPromise
    // The popup URL should contain year=2026&month=7
    // and the datev-export-bundle endpoint.
    const url = popup.url()
    expect(url, `expected month bundle URL, got: ${url}`).toMatch(
      /\/api\/v1\/reports\/datev-export-bundle/,
    )
    expect(url, `expected year=2026, got: ${url}`).toMatch(/year=2026/)
    expect(url, `expected month=7, got: ${url}`).toMatch(/month=7/)
  })

  test("4. error path: month=13 → 400 with German error", async ({ page, request }) => {
    // Direct API call — the page's month <select>
    // only offers 1-12, so we test the backend's
    // German 400 message directly.
    const res = await request.get(
      "http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&month=13&companyId=" +
        COMPANY_ID,
      { headers: { "x-user-id": USER_ID, "x-company-id": COMPANY_ID } },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected German month error, got: ${body}`).toMatch(
      /Ungültiger Monat/i,
    )
    expect(body, `expected range 1-12, got: ${body}`).toMatch(/1-12/)
  })
})
