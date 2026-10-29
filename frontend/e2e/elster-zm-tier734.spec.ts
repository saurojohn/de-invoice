/**
 * Tier 734 — the files for ELSTER and the BZSt, as the pages hand them out.
 *
 * The settings name the Land of the Finanzamt; with it the UStVA's XML
 * carries the 13-digit Steuernummer in ELSTER's <Anmeldungssteuern>, without
 * it the page says what is missing. The ZM card's CSV is the BZSt import's
 * version 3.0. (The rules: backend specs 454, 455, 49.)
 */
import { test, expect, type Page } from "@playwright/test"
import * as fs from "fs"

const API = process.env.E2E_API_URL || "http://localhost:3001"

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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-29T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("the Land of the Finanzamt, the UStVA's ELSTER XML and the ZM's CSV", async ({ page, request }) => {
  const tag = `t734-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier734-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { address: { street: "Teststr. 1", postalCode: "80331", city: "München", country: "DE" }, taxId: "181/815/08155", vatId: "DE811111111" },
  })).status()).toBe(200)
  const fr = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} FR`, type: "business", vatId: "FR12345678901", address: { street: "Rue 1", postalCode: "75001", city: "Paris", country: "FR" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: fr.id, issueDate: "2026-07-10", euTransaction: true, items: [{ description: "Ware", quantity: 1, unit: "Stk", unitPrice: 1234, vatRate: 0 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  const data = await (await request.get(`${API}/api/v1/ustva/compute?${q}&year=2026&month=7`, { headers: H })).json()
  const saved = await request.post(`${API}/api/v1/ustva/filings?${q}`, { headers: H, data: { ...data, status: "draft" } })
  expect(saved.status(), "July's draft").toBe(201)
  const filing = await saved.json()

  await as(page, userId, companyId)

  // without the Land: the page says what the XML needs
  await page.goto("/dashboard/accounting/ustva")
  const xmlButton = page.getByTestId(`ustva-elster-xml-${filing.id}`)
  await expect(xmlButton).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await xmlButton.click()
  await expect(page.getByTestId("ustva-download-error")).toContainText("Bundesland des Finanzamts", { timeout: 30_000 })

  // the settings: Bayern chosen, saved, kept
  await page.goto("/dashboard/settings")
  const land = page.getByTestId("settings-bundesland")
  await expect(land).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await expect(page.getByLabel("Bundesland des Finanzamts")).toHaveValue("")
  await land.selectOption("BY")
  const put = page.waitForResponse((r) => r.url().includes(`/api/v1/companies/${companyId}`) && r.request().method() === "PUT", { timeout: 60_000 })
  await page.getByTestId("settings-save").click()
  expect((await put).status()).toBe(200)
  await page.reload()
  await expect(page.getByTestId("settings-bundesland")).toHaveValue("BY", { timeout: 90_000 })
  const company = await (await request.get(`${API}/api/v1/companies/${companyId}?${q}`, { headers: H })).json()
  expect(company.bundesland).toBe("BY")

  // with it: the XML in ELSTER's structure, the 13-digit number
  await page.goto("/dashboard/accounting/ustva")
  await expect(page.getByTestId(`ustva-elster-xml-${filing.id}`)).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  const xmlDownload = page.waitForEvent("download", { timeout: 60_000 })
  await page.getByTestId(`ustva-elster-xml-${filing.id}`).click()
  const xml = fs.readFileSync(await (await xmlDownload).path(), "utf8")
  expect(xml).toContain('<Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v2026" version="2026">')
  expect(xml).toContain("<Steuernummer>9181081508155</Steuernummer>")
  expect(xml).toContain("<Zeitraum>07</Zeitraum>")
  expect(xml).toContain("<Kz41>1234</Kz41>")

  // the ZM card's CSV: version 3.0 of the BZSt import
  await page.getByTestId("zm-year").fill("2026")
  await page.getByTestId("zm-quarter").selectOption("3")
  await expect(page.getByTestId("zm-row").first()).toContainText("12345678901", { timeout: 30_000 })
  const csvDownload = page.waitForEvent("download", { timeout: 60_000 })
  await page.getByTestId("zm-csv").click()
  const csv = fs.readFileSync(await (await csvDownload).path(), "utf8")
  expect(csv.split("\r\n")).toEqual([
    "#v3.0",
    "#ve3.2.1",
    "Umsatzsteuer-Identifikationsnummer (USt-IdNr.),Summe (Euro),Art der Leistung",
    "FR12345678901,1234,L",
    "",
  ])
})
