/**
 * Tier 880 — a Mahnung as a letter by post: „Als Brief (PDF)“ on the
 * reminders page records the Mahnung and downloads its letter. A customer
 * without an e-mail address could not be dunned at all.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("„Als Brief (PDF)“: the Mahnung is recorded and its letter downloaded", async ({ page, request }) => {
  const tag = `t880-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier880-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Briefkunde ${tag} GmbH`, type: "business", address: { street: "Hafenstr. 3", postalCode: "28195", city: "Bremen", country: "DE" } },
  })).json()
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: day(-60), dueDate: day(-30), items: [{ description: "Montage", quantity: 1, unit: "Stk", unitPrice: 500, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-11-20T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/reminders")
  const letter = page.getByTestId("reminder-letter")
  await expect(letter).toBeVisible({ timeout: 60_000 })
  await expect(letter).toHaveText("Als Brief (PDF)")

  const download = page.waitForEvent("download", { timeout: 30_000 })
  await letter.click()
  expect((await download).suggestedFilename()).toMatch(/^Mahnung-.*\.pdf$/)
  await expect(page.getByText("Mahnung als Brief erstellt — bitte drucken und versenden")).toBeVisible()

  const list = await (await request.get(`${API}/api/v1/reminders/mahnungen?${q}`, { headers: H })).json()
  expect(list.mahnungen.length).toBe(1)
  expect(list.mahnungen[0].recipientEmail).toBe("")

  await page.goto("/dashboard/mahnungen")
  await expect(page.getByTestId("mahnung-by-post")).toHaveText("per Brief", { timeout: 60_000 })
})
