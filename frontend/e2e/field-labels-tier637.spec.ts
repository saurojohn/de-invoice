/**
 * Tier 637 — a field has a name.
 *
 * Measured before, on the 45 dashboard pages as they load: 143 visible form
 * fields had no label — the word in front of them was a <label> with no
 * `for`, the field had no `id` — and 54 of those had no placeholder or title
 * either: a screen reader announced "edit text". A click on the word did not
 * reach the field. <html lang> said "en" on a German page.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

// Visible fields without a label: [all, those without placeholder or title too].
const unnamed = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = []
    let bare = 0
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement>("input,select,textarea"))) {
      if (el.type === "hidden") continue
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) continue
      const named =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        el.closest("label") ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
      if (named) continue
      const weak = el.getAttribute("placeholder") || el.getAttribute("title")
      if (!weak) bare++
      out.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") || weak || "?"}]`)
    }
    return { fields: out, bare }
  })

test("the fields of the forms have names, and the label's word reaches its field", async ({ page, request }) => {
  test.setTimeout(300_000)
  const tag = `t637-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier637-e2e", companyName: `${tag} GmbH` },
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
      if (!localStorage.getItem("locale")) localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )

  // the settings form: 60 fields behind words
  await page.goto("/dashboard/settings")
  const name = page.getByLabel("Firmenname *")
  await expect(name).toBeVisible({ timeout: 60_000 })
  await expect(name).toHaveValue(`${tag} GmbH`)
  await page.getByText("Firmenname *", { exact: true }).click()
  await expect(name).toBeFocused()
  await expect(page.getByLabel("IBAN", { exact: true })).toHaveCount(1)
  await expect(page.locator("html")).toHaveAttribute("lang", "de")
  let found = await unnamed(page)
  expect(found.bare, found.fields.join(" ")).toBe(0)
  expect(found.fields.length, found.fields.join(" ")).toBeLessThanOrEqual(1)

  // the invoice form, the lines included
  await page.goto("/dashboard/invoices/create")
  await expect(page.getByLabel("Menge").first()).toBeVisible({ timeout: 60_000 })
  for (const label of ["Artikelnr.", "Beschreibung", "Einheit", "Einzelpreis", "MwSt-Satz"]) {
    await expect(page.getByLabel(label, { exact: true }).first(), label).toBeVisible()
  }
  await expect(page.getByLabel("Ausstellungsdatum *")).toHaveAttribute("type", "date")
  // Tier 757c: the template picker comes with the templates, after the form, and
  // stands between the word and its field; the word took the picker for its field
  await expect(page.getByTestId("invoice-notes-template-select")).toHaveAttribute("aria-label", "+ Vorlage einfügen")
  await page.locator("label", { hasText: /^Bemerkungen$/ }).click()
  await expect(page.getByTestId("invoice-notes-input")).toBeFocused()
  found = await unnamed(page)
  expect(found.fields, found.fields.join(" ")).toEqual([])
  // a word over a group of choices names no one field: the group carries it
  await expect(page.getByRole("radiogroup", { name: "USt-Behandlung" }).getByTestId("invoice-tax-standard")).toBeVisible()
  await expect(page.getByRole("group", { name: "Rechnungsart" }).getByTestId("invoice-type-INV")).toBeVisible()

  // a form that appears later: the customer dialog
  await page.goto("/dashboard/customers")
  await page.getByRole("button", { name: "Kunde hinzufügen" }).or(page.getByRole("button", { name: "Neuer Kunde" })).first().click({ timeout: 60_000 })
  await expect.poll(async () => (await unnamed(page)).bare, { timeout: 30_000 }).toBe(0)
  const dialog = await unnamed(page)
  // the list's search field has a placeholder; no field of the dialog is without a label
  expect(dialog.fields.filter((f) => !f.includes("customer-search-input")), dialog.fields.join(" ")).toEqual([])

  await page.goto("/dashboard/payments/direct-debit")
  await page.getByTestId("add-mandate-button").click()
  await expect(page.getByRole("radiogroup", { name: "Typ" }).getByTestId("mandate-type-core")).toBeVisible({ timeout: 30_000 })
  await page.goto("/dashboard/settings/webhooks")
  await page.locator("button", { hasText: /Webhook hinzufügen/ }).first().click({ timeout: 30_000 })
  await expect(page.getByRole("group", { name: "Ereignisse" }).getByTestId("webhook-event-invoiceCreated")).toBeVisible({ timeout: 30_000 })
  await page.goto("/dashboard/audit")
  await expect(page.getByRole("group", { name: "Aktion (Präfix)" })).toBeVisible({ timeout: 30_000 })

  // the pages whose fields had nothing at all
  for (const path of ["/dashboard/accounting", "/dashboard/expenses", "/dashboard/email", "/dashboard/cost-center-report", "/dashboard/cost-center-budgets", "/dashboard/mahnungen/templates", "/dashboard/settings/webhooks", "/dashboard/reports", "/dashboard/audit", "/dashboard/assets", "/dashboard/accounting/ustva"]) {
    await page.goto(path, { waitUntil: "networkidle" })
    await expect.poll(async () => (await unnamed(page)).bare, { timeout: 30_000, message: path }).toBe(0)
  }

  // the document says which language it is in
  await page.evaluate(() => localStorage.setItem("locale", "zh"))
  await page.goto("/dashboard/settings")
  await expect(page.locator("html")).toHaveAttribute("lang", "zh", { timeout: 60_000 })
})
