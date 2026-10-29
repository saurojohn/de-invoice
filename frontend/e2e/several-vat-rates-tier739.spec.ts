/**
 * Tier 739 — an invoice with 19 % and 7 %, through the CSV import and the
 * OCR scan.
 *
 * The CSV import books the rows of one invoice (a row per rate) as one
 * expense and says so; the scan's preview shows a line per rate and creates
 * one expense with those lines. (The OCR engine of the test stack is the
 * mock, so the scan's answer is the extractor's on a two-rate receipt —
 * GET /ocr/extract — handed to the page in place of the mock's.)
 * (The rules: backend spec 459.)
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64")

async function as(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-29T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("two VAT rates: the CSV rows of one invoice and a scanned receipt become one expense each", async ({ page, request }) => {
  const tag = `t739-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier739-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const expenses = async () =>
    ((await (await request.get(`${API}/api/v1/expenses?companyId=${companyId}`, { headers: H })).json()).data) as Array<{
      invoiceNumber: string; grossAmount: string; taxLines?: Array<{ vatRate: string; netAmount: string; vatAmount: string }>
    }>
  await as(page, userId, companyId)

  // the CSV: two rows, one invoice
  await page.goto("/dashboard/import?entity=expense")
  await expect(page.locator('input[type="file"]')).toBeAttached({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  const csv = [
    "description;invoiceDate;invoiceNumber;supplierName;supplierVatId;netAmount;vatRate;vatAmount;grossAmount;category;notes",
    `Lebensmittel;12.10.2026;K-${tag};${tag} Markt;;100.00;0.07;7.00;107.00;Bewirtung;`,
    `Getränke;12.10.2026;K-${tag};${tag} Markt;;50.00;0.19;9.50;59.50;Bewirtung;`,
  ].join("\n")
  await page.locator('input[type="file"]').setInputFiles({ name: "zwei-saetze.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") })
  await page.getByRole("button", { name: /2 Zeilen importieren/ }).click()
  await expect(page.getByTestId("import-merged")).toContainText(`Rechnung K-${tag}: Zeilen 2, 3 — eine Ausgabe mit 19 % / 7 %`, { timeout: 60_000 })
  const fromCsv = (await expenses()).filter((e) => e.invoiceNumber === `K-${tag}`)
  expect(fromCsv).toHaveLength(1)
  expect(Number(fromCsv[0].grossAmount)).toBe(166.5)
  expect(fromCsv[0].taxLines?.map((l) => [Number(l.vatRate), Number(l.netAmount), Number(l.vatAmount)])).toEqual([[0.19, 50, 9.5], [0.07, 100, 7]])

  // the scan: a receipt with two rates
  const text = `${tag} Laden\nRechnung Nr. S-${tag}\nDatum: 14.10.2026\nMwSt 19% auf 100,00 EUR 19,00 EUR\nMwSt 7% auf 12,00 EUR 0,84 EUR\nGesamtbetrag: 131,84 EUR`
  const extracted = await (await request.get(`${API}/api/v1/ocr/extract?text=${encodeURIComponent(text)}`, { headers: H })).json()
  expect(extracted.taxLines).toHaveLength(2)
  await page.route("**/api/v1/ocr/scan**", (route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(extracted) }))
  await page.goto("/dashboard/expenses")
  await expect(page.getByTestId("expense-ocr-upload-button")).toBeVisible({ timeout: 90_000 })
  await page.waitForLoadState("networkidle")
  await page.getByTestId("expense-ocr-file-input").setInputFiles({ name: "beleg.png", mimeType: "image/png", buffer: PNG })
  await expect(page.getByTestId("ocr-preview")).toBeVisible({ timeout: 30_000 })
  const lines = page.getByTestId("ocr-tax-line")
  await expect(lines).toHaveCount(2)
  await expect(lines.nth(0)).toContainText("19 %")
  await expect(lines.nth(1)).toContainText("7 %")
  await expect(page.getByTestId("ocr-field-net")).toHaveCount(0)
  await expect(page.getByTestId("ocr-field-gross")).toHaveValue("131.84")
  await page.getByTestId("ocr-confirm-button").click()
  await expect(page.getByTestId("ocr-modal")).toBeHidden({ timeout: 30_000 })
  await expect(page.getByTestId("expense-row").filter({ hasText: `S-${tag}` })).toHaveCount(1, { timeout: 30_000 })
  const scanned = (await expenses()).filter((e) => e.invoiceNumber === `S-${tag}`)
  expect(scanned).toHaveLength(1)
  expect(Number(scanned[0].grossAmount)).toBe(131.84)
  expect(scanned[0].taxLines?.map((l) => [Number(l.vatRate), Number(l.netAmount), Number(l.vatAmount)])).toEqual([[0.19, 100, 19], [0.07, 12, 0.84]])
})
