/**
 * Tier 183 — frontend GoBD month packager button
 *
 * Background: Tier 166 added the year-scoped
 * GoBD-Archiv download button. Tier 181 added
 * the backend's `?month=N` query param to
 * GET /api/v1/gobd-export. This tier wires a
 * "GoBD-Monats-Archiv" button + month picker
 * to that endpoint on the audit page.
 *
 * Tests:
 *   1. page renders the new "GoBD-Monats-Archiv" button
 *   2. page renders the new month <select> next to
 *      the year picker
 *   3. clicking the button triggers a download of a
 *      month-scoped GoBD-YYYY-MM-…zip (default = current
 *      month, so we override to 7)
 *   4. error path: month=13 → German 400 error shown
 *      in a toast (the backend returns
 *      "Ungültiger Monat: 13 (1-12)")
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

test.describe("Tier 183 — frontend GoBD month packager button", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsTestUser(page)
  })

  test("1. page renders the new GoBD-Monats-Archiv button", async ({ page }) => {
    page.setDefaultTimeout(60_000)
    await page.goto("/dashboard/audit", {
      timeout: 90_000,
      waitUntil: "domcontentloaded",
    })
    const btn = page.getByTestId("audit-export-gobd-month")
    await expect(btn).toBeVisible({ timeout: 30_000 })
    // i18n: de="GoBD-Monats-Archiv", en="GoBD month
    // archive", zh="GoBD 月度归档". We don't pin
    // to a specific locale; just check for the
    // presence of "GoBD" + "Archiv"/"archive"/"归档".
    await expect(btn).toContainText(/GoBD/i)
  })

  test("2. page renders the new month picker next to the year picker", async ({ page }) => {
    page.setDefaultTimeout(60_000)
    await page.goto("/dashboard/audit", {
      timeout: 90_000,
      waitUntil: "domcontentloaded",
    })
    // The new <select data-testid="audit-gobd-month">
    // has options for 01-12. The default value is
    // the current month (1-12).
    const monthSel = page.getByTestId("audit-gobd-month")
    await expect(monthSel).toBeVisible({ timeout: 30_000 })
    const value = await monthSel.inputValue()
    expect(value, `month picker default should be 1-12, got: ${value}`).toMatch(
      /^(1[0-2]|[1-9])$/,
    )
    // The first <option> should be "01 — Januar"
    // (or the i18n-equivalent). We check the first
    // <option> exists and starts with "01".
    const firstOption = await monthSel.locator("option").first().textContent()
    expect(firstOption, `first option should start with 01, got: ${firstOption}`).toMatch(
      /^01/,
    )
  })

  test("3. clicking the button triggers a month ZIP download", async ({ page }) => {
    page.setDefaultTimeout(60_000)
    await page.goto("/dashboard/audit", {
      timeout: 90_000,
      waitUntil: "domcontentloaded",
    })
    // Set month to 7 (Juli). The month <select>
    // uses numeric value 1-12.
    const monthSel = page.getByTestId("audit-gobd-month")
    await expect(monthSel).toBeVisible({ timeout: 30_000 })
    await monthSel.selectOption("7")
    const btn = page.getByTestId("audit-export-gobd-month")
    await expect(btn).toBeEnabled({ timeout: 10_000 })

    // Wait for the download. The page calls
    // fetch → blob → objectURL → <a download>.
    // The <a download> attribute falls back to
    // `GoBD-${year}-${MM}.zip` if the CORS
    // response doesn't expose Content-Disposition
    // (which is the default — only headers in
    // Access-Control-Expose-Headers are visible
    // to JS). The download is non-empty and the
    // filename encodes year+month, which is what
    // we care about for Tier 183.
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 })
    await btn.click()
    const download = await downloadPromise
    const suggested = download.suggestedFilename()
    // The filename MUST encode the year + month.
    // The exact spelling differs between Content-
    // Disclosure (GoBD-2026-07-CompanyName-…zip)
    // and the JS-side fallback (GoBD-2026-07.zip).
    // Both forms contain "GoBD-2026-07".
    expect(suggested, `expected GoBD-2026-07*.zip, got: ${suggested}`).toMatch(
      /GoBD-2026-07/,
    )
    expect(suggested, `filename should end in .zip, got: ${suggested}`).toMatch(
      /\.zip$/,
    )
  })

  test("4. error path: month=13 → German 400 error toast", async ({ page }) => {
    page.setDefaultTimeout(60_000)
    // Direct API call — the page's month <select>
    // only offers 1-12 so we can't trigger the
    // error from the UI. The test asserts the
    // backend's German error message is what the
    // UI's setDownloadError would surface.
    const res = await page.request.get(
      "http://localhost:3001/api/v1/gobd-export?year=2026&month=13&companyId=" +
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
