/**
 * Tier 609 — closing the books on the accounting page.
 *
 * A company closes its books up to a day; from then on nothing dated on or
 * before it can be written. The card shows the state, closes, and lifts the
 * closing again with a reason.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("closing the books and lifting the closing", async ({ page, request }) => {
  const tag = `t609-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier609-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const expense = (date: string, number: string) =>
    request.post(`${API}/api/v1/expenses?${q}`, {
      headers: H, data: { description: "Test", invoiceNumber: number, invoiceDate: date, netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119 },
    })
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/accounting")
  const card = page.getByTestId("books-closing-card")
  await expect(card.getByTestId("books-closing-state")).toHaveText("Die Bücher sind nicht abgeschlossen.", { timeout: 60_000 })
  await expect(card.getByTestId("books-closing-save")).toBeDisabled()

  // close up to 31.03.2026
  await card.getByTestId("books-closing-date").fill("2026-03-31")
  await card.getByTestId("books-closing-save").click()
  await expect(card.getByTestId("books-closing-state")).toHaveText("Abgeschlossen bis einschließlich 31.03.2026.")
  const refused = await expense("2026-03-15", "M-1")
  expect(refused.status(), "an expense dated into the closed period").toBe(400)
  expect((await refused.json()).message).toContain("Bücher sind bis einschließlich 31.03.2026 abgeschlossen")
  expect((await expense("2026-04-02", "A-1")).status(), "an expense in the open period").toBe(201)

  // lifting needs a reason
  await card.getByTestId("books-closing-lift").click()
  await expect(card.getByTestId("books-closing-lift-confirm")).toBeDisabled()
  await card.getByTestId("books-closing-lift-reason").fill("Nachbuchung laut Steuerberater")
  await card.getByTestId("books-closing-lift-confirm").click()
  await expect(card.getByTestId("books-closing-state")).toHaveText("Die Bücher sind nicht abgeschlossen.")
  expect((await expense("2026-03-15", "M-2")).status(), "March is open again").toBe(201)

  // the state survives a reload
  await card.getByTestId("books-closing-date").fill("2026-01-31")
  await card.getByTestId("books-closing-save").click()
  await expect(card.getByTestId("books-closing-state")).toHaveText("Abgeschlossen bis einschließlich 31.01.2026.")
  await page.reload()
  await expect(page.getByTestId("books-closing-state")).toHaveText("Abgeschlossen bis einschließlich 31.01.2026.", { timeout: 60_000 })
})
