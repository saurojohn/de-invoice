/**
 * Tier 748 — the company's Verfahrensdokumentation, from the GoBD section of
 * the accounting page. (The contents: backend spec 467.)
 */
import { test, expect } from "@playwright/test"
import * as fs from "fs"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the accounting page hands out the company's Verfahrensdokumentation as a Word file", async ({ page, request }) => {
  const tag = `t748-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier748-e2e", companyName: `${tag} GmbH` },
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
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-30T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/accounting")
  const link = page.getByTestId("gobd-verfahrensdoku-link")
  await expect(link).toBeVisible({ timeout: 120_000 })
  // Tier 836: the link names the Word file's endpoint before it is clicked (it was "#"
  // until an effect ran — a click then opened the page itself in a new tab)
  await expect(link).toHaveAttribute("href", new RegExp(`/api/v1/accounting/verfahrensdokumentation\\?companyId=${companyId}$`))
  await page.waitForLoadState("networkidle")
  await link.scrollIntoViewIfNeeded()

  // The link opens a new tab (target=_blank): Chromium reports the download on
  // this page or on the new one — whichever comes (Tier 833: once on CI it was
  // the new tab, and the wait on this page ran out after 60 s).
  const download = Promise.any([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.waitForEvent("popup", { timeout: 60_000 }).then((p) => p.waitForEvent("download", { timeout: 60_000 })),
  ])
  // (a tab that shows a page instead of handing out the file names it here)
  page.on("popup", (p) => { p.waitForLoadState().then(() => console.log(`verfahrensdoku: the new tab shows ${p.url()}`), () => {}) })
  await link.click()
  const file = await download
  expect(decodeURIComponent(file.suggestedFilename())).toMatch(new RegExp(`^Verfahrensdokumentation-${tag}_GmbH-\\d{4}-\\d{2}-\\d{2}\\.docx$`))
  // a .docx is a ZIP
  const bytes = fs.readFileSync(await file.path())
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK")
  expect(bytes.length).toBeGreaterThan(5000)
})
