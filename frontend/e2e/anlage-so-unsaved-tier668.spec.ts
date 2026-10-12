/**
 * Tier 668 — Anlage SO: an import does not take what was typed.
 *
 * Before: "Aus Ausgaben übernehmen" and the CSV import reloaded the form
 * from the server — a row typed and not saved yet was gone. And after
 * "Speichern" the block with the set-off of losses kept the figures from
 * before the save.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
// the form opens on last year
const Y = new Date().getFullYear() - 1

async function company(page: Page, request: APIRequestContext) {
  const tag = `t668-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier668-e2e", companyName: `${tag} Einzelunternehmen` },
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

test("a row typed and not saved is still there after an import; the loss block follows the save", async ({ page, request }) => {
  test.setTimeout(240_000)
  const { tag, companyId, H } = await company(page, request)
  const q = `companyId=${companyId}`
  const sup = await (await request.post(`${API}/api/v1/suppliers?${q}`, {
    headers: H,
    data: { name: `${tag} Börse`, address: { street: "a", city: "b", postalCode: "1", country: "DE" } },
  })).json()
  const btc = (await (await request.post(`${API}/api/v1/expenses?${q}`, {
    headers: H,
    data: {
      supplierId: sup.id, invoiceNumber: "K-1", description: "BTC Kauf", invoiceDate: `${Y}-03-15`, category: "Krypto",
      netAmount: 5000, vatRate: 0, vatAmount: 0, grossAmount: 5000, confirmDuplicate: true,
    },
  })).json()) as { id: string }
  expect(btc.id).toBeTruthy()

  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("anlage-so-vordruck-table")).toBeVisible({ timeout: 120_000 })
  const editor = page.getByTestId("anlage-so-transactions-editor")
  await expect(page.getByTestId("anlage-so-empty-transactions")).toBeVisible()

  // typed, not saved: gold sold at a loss of 1 500 €
  await page.getByTestId("anlage-so-add-row").click()
  const typed = editor.locator("tbody tr").first()
  await typed.locator("select").selectOption("sonstige")
  await typed.locator('input[type="text"]').fill("Goldbarren")
  await typed.locator('input[type="date"]').nth(0).fill(`${Y}-02-01`)
  await typed.locator('input[type="number"]').nth(0).fill("4000")
  await typed.locator('input[type="date"]').nth(1).fill(`${Y}-09-01`)
  await typed.locator('input[type="number"]').nth(1).fill("2500")

  // the import: the row that was typed is saved with it, not dropped
  await page.getByTestId("anlage-so-v2-expense-open").click()
  await page.getByTestId(`anlage-so-v2-expense-check-${btc.id}`).check()
  const imported = page.waitForResponse((r) => r.url().includes("/anlage-so/import-from-expenses") && r.ok())
  await page.getByTestId("anlage-so-v2-expense-import-selected").click()
  await imported
  await expect(editor.locator("tbody tr")).toHaveCount(2)
  await expect(editor.locator("tbody tr").nth(0).locator('input[type="text"]')).toHaveValue("Goldbarren")
  await expect(editor.getByTestId("anlage-so-row-status").nth(0)).toHaveAttribute("data-status", "steuerpflichtig")
  await expect(editor.getByTestId("anlage-so-row-status").nth(1)).toHaveAttribute("data-status", "saleDate")
  await expect(page.getByTestId("anlage-so-v2-in-frist-loss")).toContainText("1.500,00")

  // the BTC is sold at a gain of 500 €: after "Speichern" the set-off shows it
  const bought = editor.locator("tbody tr").nth(1)
  await bought.locator('input[type="date"]').nth(1).fill(`${Y}-10-01`)
  await bought.locator('input[type="number"]').nth(1).fill("5500")
  const saved = page.waitForResponse((r) => r.url().includes("/accounting/anlage-so/settings") && r.request().method() === "PUT" && r.ok())
  await page.getByTestId("anlage-so-save").click()
  await saved
  await expect(page.getByTestId("anlage-so-v2-in-frist-gain")).toContainText("500,00")
  await expect(page.getByTestId("anlage-so-v2-carryforward")).toContainText("1.000,00")
})

test("a row typed and not saved is kept when the year is changed", async ({ page, request }) => {
  test.setTimeout(240_000)
  await company(page, request)
  await page.goto("/dashboard/accounting")
  await expect(page.getByTestId("anlage-so-vordruck-table")).toBeVisible({ timeout: 120_000 })
  const editor = page.getByTestId("anlage-so-transactions-editor")
  await expect(page.getByTestId("anlage-so-empty-transactions")).toBeVisible()
  await page.getByTestId("anlage-so-add-row").click()
  const typed = editor.locator("tbody tr").first()
  await typed.locator('input[type="text"]').fill("ETH")
  await typed.locator('input[type="date"]').nth(0).fill(`${Y}-02-01`)
  await typed.locator('input[type="number"]').nth(0).fill("1000")
  await typed.locator('input[type="date"]').nth(1).fill(`${Y}-09-01`)
  await typed.locator('input[type="number"]').nth(1).fill("1800")

  // to the year before — its list is empty — and back
  const saved = page.waitForResponse((r) => r.url().includes("/accounting/anlage-so/settings") && r.request().method() === "PUT" && r.ok())
  await page.getByTestId("anlage-so-year-input").fill(String(Y - 1))
  await saved
  await expect(page.getByTestId("anlage-so-empty-transactions")).toBeVisible()
  await page.getByTestId("anlage-so-year-input").fill(String(Y))
  await expect(editor.locator("tbody tr")).toHaveCount(1)
  await expect(editor.locator("tbody tr").first().locator('input[type="text"]')).toHaveValue("ETH")
  await expect(editor.getByTestId("anlage-so-row-status").first()).toHaveAttribute("data-status", "steuerpflichtig")
})
