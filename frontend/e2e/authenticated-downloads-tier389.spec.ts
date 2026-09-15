/**
 * Tier 389 — download links and buttons fetch with the auth headers.
 *
 * Every protected backend route needs x-user-id / x-company-id. The download
 * links (`<a href={pdfUrl}>`) and `window.open` buttons are navigations, which
 * send no headers: measured, anlage-n.pdf, euer.pdf, gobd-archive, bwa.pdf,
 * datev-export, activity.csv, ustja.pdf all answer 401 without the headers and
 * 200 with them. The existing Playwright tests only checked the href.
 *
 * These tests click the real controls and assert the file request carried the
 * headers and succeeded.
 */
import { test, expect, type Page, type Response } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(`Auth cache ${AUTH_CACHE} missing — run backend e2e first`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let tokens: { userId: string; companyId: string }

test.beforeAll(() => {
  tokens = readCachedTokens()
})

async function injectAuth(page: Page) {
  const { userId, companyId } = tokens
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
}

/** Wait for the file GET (any page of the context — a new tab counts too). */
function fileResponse(page: Page, fragment: string): Promise<Response> {
  return page.context().waitForEvent("response", {
    predicate: (r) => r.url().includes(fragment) && r.request().method() === "GET",
    timeout: 90_000,
  })
}

async function expectAuthed(res: Response, what: string) {
  expect(res.status(), `${what}: status (401 = sent without auth headers)`).toBe(200)
  const headers = await res.request().allHeaders()
  expect(headers["x-user-id"], `${what}: x-user-id header`).toBe(tokens.userId)
}

test.describe("Tier 389 — authenticated downloads", () => {
  test.setTimeout(180_000)

  test("Anlage N PDF link (target=_blank)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    const link = page.getByTestId("anlage-n-pdf-link")
    await expect(link).toHaveAttribute("href", /anlage-n\.pdf/, { timeout: 60_000 })
    const res = fileResponse(page, "/api/v1/accounting/anlage-n.pdf")
    await link.click()
    await expectAuthed(await res, "anlage-n.pdf")
  })

  test("GoBD archive ZIP link downloads the file", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/accounting")
    const link = page.getByTestId("gobd-zip-link")
    await expect(link).toHaveAttribute("href", /gobd-archive/, { timeout: 60_000 })
    const res = fileResponse(page, "/api/v1/accounting/gobd-archive")
    const download = page.waitForEvent("download", { timeout: 90_000 })
    await link.click()
    await expectAuthed(await res, "gobd-archive")
    expect((await download).suggestedFilename()).toMatch(/\.zip$/)
  })

  test("activity CSV export link", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/activity")
    const link = page.getByTestId("activity-export-csv")
    await expect(link).toBeVisible({ timeout: 60_000 })
    const res = fileResponse(page, "/api/v1/audit-logs/activity.csv")
    const download = page.waitForEvent("download", { timeout: 60_000 })
    await link.click()
    await expectAuthed(await res, "activity.csv")
    expect((await download).suggestedFilename()).toMatch(/\.csv$/)
  })

  test("DATEV CSV button (was window.open)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/reports", { waitUntil: "domcontentloaded" })
    const datevTab = page.getByTestId("tab-datev")
    await expect(datevTab).toBeVisible({ timeout: 60_000 })
    await page.waitForFunction(() => document.readyState === "complete", { timeout: 60_000 })
    const btn = page.getByTestId("datev-download-csv-btn")
    // A click before hydration does not switch the tab (flaked once): retry.
    await expect(async () => {
      await datevTab.click()
      await expect(btn).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 60_000 })
    const res = fileResponse(page, "/api/v1/reports/datev-export?")
    const download = page.waitForEvent("download", { timeout: 60_000 })
    await btn.click()
    await expectAuthed(await res, "datev-export")
    expect((await download).suggestedFilename()).toMatch(/\.csv$/i)
  })
})
