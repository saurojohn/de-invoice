/**
 * Tier 573 — an incoming e-invoice on the expenses page.
 *
 * An XRechnung (or a ZUGFeRD PDF) picked on the page is read, shown — seller,
 * lines, VAT, what will be booked — and imported; the expense then carries the
 * invoice, and "E-Rechnung anzeigen" shows it readable again. Before this
 * tier an XML could not be uploaded at all.
 */
import { test, expect, type Page } from "@playwright/test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const API = process.env.E2E_API_URL || "http://localhost:3001"

function xrechnung(number: string, buyer: string): string {
  const tax = (net: string, vat: string, pct: string) =>
    `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${net}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${vat}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${pct}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`
  const line = (id: string, name: string, net: string, pct: string) =>
    `<cac:InvoiceLine><cbc:ID>${id}</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">${net}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${name}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${pct}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${net}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
<cbc:ID>${number}</cbc:ID><cbc:IssueDate>2026-09-14</cbc:IssueDate><cbc:DueDate>2026-10-14</cbc:DueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cac:AccountingSupplierParty><cac:Party><cac:PostalAddress><cbc:StreetName>Lindenallee 12</cbc:StreetName><cbc:CityName>Leipzig</cbc:CityName><cbc:PostalZone>04109</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>DE811907980</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Papier Müller GmbH</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cac:PostalAddress><cbc:CityName>Berlin</cbc:CityName><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyLegalEntity><cbc:RegistrationName>${buyer}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>DE89370400440532013000</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">45.00</cbc:TaxAmount>${tax("200.00", "38.00", "19")}${tax("100.00", "7.00", "7")}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">300.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">300.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">345.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">345.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
${line("1", "Kopierpapier A4", "200.00", "19")}${line("2", "Fachbuch Buchführung", "100.00", "7")}
</Invoice>`
}

async function freshCompany(page: Page, request: Parameters<Parameters<typeof test>[2]>[0]["request"], tag: string) {
  const company = `${tag} GmbH`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier573-e2e", companyName: company },
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
    },
    { userId, companyId },
  )
  return { company, userId, companyId }
}

test("an XRechnung is read, shown, imported and can be looked at again", async ({ page, request }) => {
  const tag = `t573-${Date.now()}`
  const { company } = await freshCompany(page, request, tag)
  const dir = mkdtempSync(join(tmpdir(), "t573-"))
  const file = join(dir, "rechnung.xml")
  writeFileSync(file, xrechnung(`PM-${tag}`, company), "utf-8")

  await page.goto("/dashboard/expenses")
  await expect(page.getByTestId("expense-einvoice-upload-button")).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  await page.getByTestId("expense-einvoice-file-input").setInputFiles(file)

  const dialog = page.getByTestId("einvoice-dialog")
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("einvoice-profile")).toContainText("XRechnung 3.0", { timeout: 30_000 })
  await expect(page.getByTestId("einvoice-seller")).toHaveText("Papier Müller GmbH")
  await expect(page.getByTestId("einvoice-lines").locator("tbody tr")).toHaveCount(2)
  // Tier 581: one expense, with a line per VAT rate (until then: two expenses)
  await expect(page.getByTestId("einvoice-planned")).toHaveCount(1)
  await expect(page.getByTestId("einvoice-planned-line")).toHaveCount(2)
  await expect(page.getByTestId("einvoice-blocking")).toHaveCount(0)

  // Tier 578: the official validator on request — where it is installed it
  // gives its verdict (this hand-made file is not a complete XRechnung), where
  // it is not, the dialog says so. Either way the import stays possible.
  await page.getByTestId("einvoice-check-button").click()
  const verdict = page.getByTestId("einvoice-check-result")
  await expect(verdict).toBeVisible({ timeout: 90_000 })
  expect(["0", "1"]).toContain(await verdict.getAttribute("data-available"))
  if ((await verdict.getAttribute("data-available")) === "1") {
    await expect(verdict).toContainText(/KoSIT/)
  }

  await page.getByTestId("einvoice-import-button").click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  const rows = page.getByTestId("expense-row").filter({ hasText: `PM-${tag}` })
  await expect(rows).toHaveCount(1, { timeout: 30_000 })
  await expect(rows.first().getByTestId("expense-rates")).toHaveText("19 % / 7 %")

  // the same file again: recognised, and only imported after saying so
  await page.getByTestId("expense-einvoice-file-input").setInputFiles(file)
  await expect(page.getByTestId("einvoice-confirm-duplicate")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("einvoice-import-button")).toBeDisabled()
  await page.getByRole("button", { name: /Abbrechen|Cancel|取消/ }).click()
  await expect(dialog).toBeHidden()

  // the kept invoice, readable from the expense
  await rows.first().locator('[data-testid^="expense-open-"]').click()
  const view = page.getByTestId("expense-einvoice-view-button")
  await expect(view).toBeVisible({ timeout: 30_000 })
  await view.click()
  await expect(page.getByTestId("einvoice-lines").locator("tbody tr")).toHaveCount(2, { timeout: 30_000 })
  await expect(page.getByTestId("einvoice-import-button")).toHaveCount(0) // looking, not importing
})

test("an XML picked through “Scan hochladen” is read as an invoice, not scanned", async ({ page, request }) => {
  const tag = `t573b-${Date.now()}`
  const { company } = await freshCompany(page, request, tag)
  const dir = mkdtempSync(join(tmpdir(), "t573-"))
  const file = join(dir, "eingang.xml")
  writeFileSync(file, xrechnung(`SC-${tag}`, company), "utf-8")
  await page.goto("/dashboard/expenses")
  await expect(page.getByTestId("expense-ocr-upload-button")).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  await page.getByTestId("expense-ocr-file-input").setInputFiles(file)
  await expect(page.getByTestId("einvoice-dialog")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("einvoice-gross")).toContainText("345,00")
  await expect(page.getByTestId("ocr-modal")).toHaveCount(0)
})
