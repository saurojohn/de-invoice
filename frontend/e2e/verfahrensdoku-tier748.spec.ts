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
  await page.waitForLoadState("networkidle")
  await link.scrollIntoViewIfNeeded()

  const download = page.waitForEvent("download", { timeout: 60_000 })
  await link.click()
  const file = await download
  expect(decodeURIComponent(file.suggestedFilename())).toMatch(new RegExp(`^Verfahrensdokumentation-${tag}_GmbH-\\d{4}-\\d{2}-\\d{2}\\.docx$`))
  // a .docx is a ZIP
  const bytes = fs.readFileSync(await file.path())
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK")
  expect(bytes.length).toBeGreaterThan(5000)
})
