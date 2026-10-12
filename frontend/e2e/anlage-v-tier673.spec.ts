/**
 * Tier 673 — Anlage V: a loan's repayment is no Werbungskosten, the
 * administration is no insurance.
 *
 * Before: „Darlehenstilgung“ stood under Schuldzinsen and „Hausverwaltung“
 * under Gebäudeversicherung.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
// the form opens on last year
const Y = new Date().getFullYear() - 1

test("interest, repayment, administration: each where it belongs", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  test.setTimeout(240_000)
  const tag = `t673-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier673-e2e", companyName: `${tag} Einzelunternehmen` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const sup = await (await request.post(`${API}/api/v1/suppliers?${q}`, {
    headers: H,
    data: { name: `${tag} Bank`, address: { street: "a", city: "b", postalCode: "1", country: "DE" } },
  })).json()
  const expense = async (n: number, category: string, gross: number) => {
    const r = await request.post(`${API}/api/v1/expenses?${q}`, {
      headers: H,
      data: {
        supplierId: sup.id, invoiceNumber: `V-${n}`, description: category, invoiceDate: `${Y}-05-10`, paidAt: `${Y}-05-12`, category,
        netAmount: gross, vatRate: 0, vatAmount: 0, grossAmount: gross, confirmDuplicate: true,
      },
    })
    expect(r.status(), category).toBe(201)
  }
  await expense(1, "Schuldzinsen", 2400)
  await expense(2, "Darlehenstilgung", 9000)
  await expense(3, "Hausverwaltung", 1200)
  await expense(4, "Wohngebäudeversicherung", 450)

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
  const interest = page.getByTestId("anlage-v-exp-8620")
  await expect(interest).toBeVisible({ timeout: 120_000 })
  await expect(interest).toContainText("2.400,00")
  await expect(page.getByTestId("anlage-v-note-8620")).toContainText("1 Ausgabe(n) für Darlehen oder Tilgung (9.000,00 EUR) sind nicht angesetzt")
  await expect(page.getByTestId("anlage-v-exp-8640")).toContainText("450,00")
  await expect(page.getByTestId("anlage-v-exp-8650")).toContainText("1.200,00")
})
