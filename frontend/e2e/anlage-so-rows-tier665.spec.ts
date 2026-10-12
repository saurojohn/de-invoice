/**
 * Tier 665 — Anlage SO: what is entered stays in the form.
 *
 * Before: a row without a sale date, or sold in another year, was saved and
 * then no longer shown — the form's next save deleted it. Nothing said what
 * a row counted as. "Aus Ausgaben übernehmen" took every expense whatever
 * was ticked, and made a sale of each.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
// the form opens on last year
const Y = new Date().getFullYear() - 1

async function company(page: Page, request: APIRequestContext) {
  const tag = `t665-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier665-e2e", companyName: `${tag} Einzelunternehmen` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
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
  return { tag, companyId, H: { "x-user-id": userId, "x-company-id": companyId } }
}
async function open(page: Page) {
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("anlage-so-vordruck-table")).toBeVisible({ timeout: 120_000 })
}
const saved = (page: Page) =>
  page.waitForResponse((r) => r.url().includes("/accounting/anlage-so/settings") && r.request().method() === "PUT" && r.ok())

test("rows that are not counted stay in the form, with the reason", async ({ page, request }) => {
  test.setTimeout(240_000)
  const { companyId, H } = await company(page, request)
  const put = await request.put(`${API}/api/v1/accounting/anlage-so/settings?companyId=${companyId}`, {
    headers: H,
    data: {
      year: Y, wiederkehrendeBezuege: 0, werbungskosten: 0,
      transactions: [
        { type: "krypto", description: "BTC", acquisitionDate: `${Y}-01-10`, acquisitionCost: 1000, saleDate: `${Y}-06-10`, salePrice: 5000 },
        { type: "sonstige", description: "Gold, noch nicht verkauft", acquisitionDate: `${Y}-02-01`, acquisitionCost: 2000, saleDate: "", salePrice: 0 },
        { type: "krypto", description: "ETH im Vorjahr verkauft", acquisitionDate: `${Y - 2}-11-01`, acquisitionCost: 1000, saleDate: `${Y - 1}-03-01`, salePrice: 4000 },
      ],
    },
  })
  expect(put.ok()).toBe(true)

  await open(page)
  const status = page.getByTestId("anlage-so-transactions-editor").getByTestId("anlage-so-row-status")
  await expect(status).toHaveCount(3)
  await expect(status.nth(0)).toHaveAttribute("data-status", "steuerpflichtig")
  await expect(status.nth(0)).toContainText("steuerpflichtig — innerhalb der Frist")
  await expect(status.nth(1)).toContainText("nicht angesetzt: Veräußerungsdatum fehlt")
  await expect(status.nth(2)).toContainText(`gehört in die Anlage SO ${Y - 1}`)
  await expect(page.getByTestId("anlage-so-summary-count")).toHaveText("1")
  await expect(page.getByTestId("anlage-so-summary-not-counted")).toContainText("2 Zeile(n) nicht angesetzt")

  // the form's own save keeps all three
  let done = saved(page)
  await page.getByTestId("anlage-so-save").click()
  await done
  await expect(status).toHaveCount(3)
  await page.reload()
  await expect(page.getByTestId("anlage-so-vordruck-table")).toBeVisible({ timeout: 120_000 })
  await expect(status).toHaveCount(3)

  // the gold is sold: the row says it is not decided until it is saved, then counts
  const gold = page.getByTestId("anlage-so-transactions-editor").locator("tbody tr").nth(1)
  await gold.locator('input[type="date"]').nth(1).fill(`${Y}-08-01`)
  await gold.locator('input[type="number"]').nth(1).fill("2600")
  await expect(status.nth(1)).toHaveAttribute("data-status", "unsaved")
  await expect(status.nth(1)).toContainText("wird beim Speichern bestimmt")
  done = saved(page)
  await page.getByTestId("anlage-so-save").click()
  await done
  await expect(status.nth(1)).toHaveAttribute("data-status", "steuerpflichtig")
  await expect(page.getByTestId("anlage-so-summary-count")).toHaveText("2")
  await expect(page.getByTestId("anlage-so-summary-not-counted")).toContainText("1 Zeile(n) nicht angesetzt")
})

test("from the expenses: the one that is ticked, as an acquisition", async ({ page, request }) => {
  test.setTimeout(240_000)
  const { tag, companyId, H } = await company(page, request)
  const q = `companyId=${companyId}`
  const sup = await (await request.post(`${API}/api/v1/suppliers?${q}`, {
    headers: H,
    data: { name: `${tag} Börse`, address: { street: "a", city: "b", postalCode: "1", country: "DE" } },
  })).json()
  const expense = async (invoiceNumber: string, description: string, gross: number) =>
    (await (await request.post(`${API}/api/v1/expenses?${q}`, {
      headers: H,
      data: {
        supplierId: sup.id, invoiceNumber, description, invoiceDate: `${Y}-03-15`, category: "Krypto",
        netAmount: gross, vatRate: 0, vatAmount: 0, grossAmount: gross, confirmDuplicate: true,
      },
    })).json()) as { id: string }
  const btc = await expense("K-1", "BTC Kauf", 5000)
  const eth = await expense("K-2", "ETH Kauf", 3000)
  expect(btc.id && eth.id).toBeTruthy()

  await open(page)
  await page.getByTestId("anlage-so-v2-expense-open").click()
  const modal = page.getByTestId("anlage-so-v2-expense-modal")
  await expect(modal).toBeVisible()
  // German headings (were "Date", "Category", "Gross (€)")
  await expect(modal.locator("thead")).toContainText("Datum")
  await expect(modal.locator("thead")).toContainText("Kategorie")
  await expect(modal.locator("thead")).not.toContainText("Category")
  await expect(page.getByTestId(`anlage-so-v2-expense-row-${eth.id}`)).toBeVisible()
  // nothing is ticked when the list opens (it was: everything)
  await expect(page.getByTestId(`anlage-so-v2-expense-check-${eth.id}`)).not.toBeChecked()
  await expect(page.getByTestId("anlage-so-v2-expense-import-selected")).toBeDisabled()
  await page.getByTestId(`anlage-so-v2-expense-check-${btc.id}`).check()
  const imported = page.waitForResponse((r) => r.url().includes("/anlage-so/import-from-expenses") && r.ok())
  await page.getByTestId("anlage-so-v2-expense-import-selected").click()
  expect((await (await imported).json()).importedCount).toBe(1)

  // one row: the purchase — date and cost of the expense, no sale, not counted
  const editor = page.getByTestId("anlage-so-transactions-editor")
  await expect(editor.locator("tbody tr")).toHaveCount(1)
  const row = editor.locator("tbody tr").first()
  await expect(row.locator('input[type="date"]').nth(0)).toHaveValue(`${Y}-03-15`)
  await expect(row.locator('input[type="number"]').nth(0)).toHaveValue("5000")
  await expect(row.locator('input[type="date"]').nth(1)).toHaveValue("")
  await expect(row.getByTestId("anlage-so-row-status")).toContainText("nicht angesetzt: Veräußerungsdatum fehlt")
  await expect(page.getByTestId("anlage-so-summary-count")).toHaveText("0")

  // saved by the form and offered again: the first is known as taken
  const done = saved(page)
  await page.getByTestId("anlage-so-save").click()
  await done
  await page.getByTestId("anlage-so-v2-expense-open").click()
  await expect(page.getByTestId(`anlage-so-v2-expense-check-${btc.id}`)).toBeDisabled()
  await expect(page.getByTestId(`anlage-so-v2-expense-check-${eth.id}`)).toBeEnabled()
})
