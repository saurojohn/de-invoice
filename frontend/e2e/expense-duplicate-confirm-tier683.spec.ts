/**
 * Tier 683 — a second invoice under a number that is already entered can be
 * confirmed in the expense form.
 *
 * The backend refuses the same supplier's invoice number a second time (409,
 * Tier 489) unless the request says `confirmDuplicate`. The form showed the
 * refusal as an error and had no way to say so: a second invoice that really
 * is one could not be entered there at all — and the message told the person
 * to confirm "mit „confirmDuplicate“", the name of the API's field.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the same invoice number again: asked about, then entered or left", async ({ page, request }) => {
  const tag = `t683-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier683-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const supplier = await (await request.post(`${API}/api/v1/suppliers?companyId=${companyId}`, { headers: H, data: { name: "Papier Schmidt GmbH" } })).json()
  const number = `RE-${tag}`
  const first = await request.post(`${API}/api/v1/expenses?companyId=${companyId}`, {
    headers: H,
    data: { supplierId: supplier.id, invoiceNumber: number, description: "Kopierpapier", invoiceDate: "2026-10-02", netAmount: 100, vatRate: 0.19, vatAmount: 19, grossAmount: 119 },
  })
  expect(first.status()).toBe(201)
  const numbered = async () =>
    ((await (await request.get(`${API}/api/v1/expenses?companyId=${companyId}`, { headers: H })).json()).data as Array<{ invoiceNumber: string | null; description: string }>)
      .filter((e) => e.invoiceNumber === number)
      .map((e) => e.description)
      .sort()

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-13T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/expenses")
  await page.getByTestId("expense-create-button").click({ timeout: 60_000 })
  const form = page.getByTestId("expense-create")
  await expect(form).toBeVisible()
  await form.getByTestId("expense-edit-description").fill("Kopierpapier, Nachlieferung")
  await form.getByTestId("expense-edit-number").fill(number)
  await form.getByTestId("expense-edit-supplier").selectOption(supplier.id)
  await form.getByTestId("expense-edit-net").fill("50")

  // asked, and answered "no": nothing is entered, the form stays as filled in
  const asked: string[] = []
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss() })
  await form.getByTestId("expense-edit-save").click()
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(1)
  expect(asked[0]).toContain("bereits erfasst")
  expect(asked[0]).toContain("119,00")
  expect(asked[0]).not.toContain("confirmDuplicate") // was: „mit „confirmDuplicate“ bestätigen“
  await expect(form.getByTestId("expense-edit-save")).toBeEnabled()
  await expect(form.getByTestId("expense-edit-description")).toHaveValue("Kopierpapier, Nachlieferung")
  expect(await numbered()).toEqual(["Kopierpapier"])

  // answered "yes": the second invoice is entered (was: an error, and no way on)
  page.once("dialog", (d) => { void d.accept() })
  await form.getByTestId("expense-edit-save").click()
  await expect(page.getByTestId("expense-create-modal")).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId("expense-row").filter({ hasText: "Kopierpapier, Nachlieferung" })).toBeVisible()
  expect(await numbered()).toEqual(["Kopierpapier", "Kopierpapier, Nachlieferung"])
})
