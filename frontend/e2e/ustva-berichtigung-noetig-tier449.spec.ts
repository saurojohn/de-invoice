/**
 * Tier 449 — a submitted UStVA the books no longer match is flagged.
 *
 * Measured before: an expense entered after the submission changed the
 * period's Vorsteuer, and the filings list showed nothing. Now the row carries
 * "Berichtigung nötig" until a corrected return is submitted.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("an expense entered after submission flags the filing until it is corrected", async ({ page, request }) => {
  const tag = `t449-${Date.now()}`
  const year = new Date().getFullYear()
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier449-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  // Submit the year as it is now (no bookings: all zero).
  const data = await (await request.get(`${API}/api/v1/ustva/compute?${q}&year=${year}`, { headers: H })).json()
  const sub = await request.post(`${API}/api/v1/ustva/filings?${q}`, { headers: H, data: { ...data, status: "submitted" } })
  expect(sub.status(), "submitted").toBe(201)
  const filing = await sub.json()
  // …then an expense of that year turns up.
  const exp = await request.post(`${API}/api/v1/ustva/expenses?${q}`, {
    headers: H,
    data: { description: tag, invoiceDate: `${year}-01-15`, netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119 },
  })
  expect(exp.status(), "expense").toBe(201)

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
  await page.goto("/dashboard/accounting/ustva")
  const badge = page.getByTestId(`ustva-berichtigung-${filing.id}`)
  await expect(badge).toBeVisible({ timeout: 90_000 })
  await expect(badge).toHaveAttribute("title", /-19,00/)
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)

  page.on("dialog", (d) => d.accept())
  const corrected = page.waitForResponse(
    (r) => r.url().includes("/api/v1/ustva/filings") && r.request().method() === "POST" && r.status() === 201,
    { timeout: 60_000 },
  )
  await page.getByTestId("ustva-submit").click()
  await corrected
  await expect(badge).toHaveCount(0, { timeout: 30_000 })
})
