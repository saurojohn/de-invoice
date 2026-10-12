/**
 * Tier 673 — Anlage V: a loan's repayment is no Werbungskosten, the
 * administration is no insurance.
 *
 * Before: „Darlehenstilgung“ stood under Schuldzinsen and „Hausverwaltung“
 * under Gebäudeversicherung. (Tier 677: a repayment is refused when it is
 * entered; the note on the form is for rows from before — spec 400.)
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
  const expense = (n: number, category: string, gross: number) =>
    request.post(`${API}/api/v1/expenses?${q}`, {
      headers: H,
      data: {
        supplierId: sup.id, invoiceNumber: `V-${n}`, description: category, invoiceDate: `${Y}-05-10`, paidAt: `${Y}-05-12`, category,
        netAmount: gross, vatRate: 0, vatAmount: 0, grossAmount: gross, confirmDuplicate: true,
      },
    })
  expect((await expense(1, "Schuldzinsen", 2400)).status()).toBe(201)
  // Tier 677: the repayment is not taken as an expense at all
  const refused = await expense(2, "Darlehenstilgung", 9000)
  expect(refused.status()).toBe(400)
  expect((await refused.json()).message).toContain("Die Tilgung eines Darlehens ist keine Ausgabe")
  expect((await expense(3, "Hausverwaltung", 1200)).status()).toBe(201)
  expect((await expense(4, "Wohngebäudeversicherung", 450)).status()).toBe(201)

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
  await expect(page.getByTestId("anlage-v-note-8620")).toHaveCount(0)
  await expect(page.getByTestId("anlage-v-exp-8640")).toContainText("450,00")
  await expect(page.getByTestId("anlage-v-exp-8650")).toContainText("1.200,00")
})
