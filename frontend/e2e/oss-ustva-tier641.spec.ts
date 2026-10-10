/**
 * Tier 641 — the UStVA says which sales are declared through the OSS, and the
 * OSS tab shows the corrections of earlier quarters.
 *
 * Before: French tax on a sale to a consumer in France stood in the UStVA's
 * table as "USt 20%" and in its sum as German tax; a credit note for a sale
 * of an earlier quarter was in no OSS report.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("French tax is named apart on the UStVA page; a later credit note is a correction on the OSS tab", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t641-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier641-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { taxId: "12/345/67890", address: { street: "Teststr. 1", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).ok()).toBeTruthy()
  const customer = async (name: string, country: string) =>
    (await (await request.post(`${API}/api/v1/customers?${q}`, { headers: H, data: { name, type: "individual", address: { street: "Weg 1", postalCode: "1000", city: "Ort", country } } })).json()).id as string
  const fr = await customer("Marie Dupont", "FR")
  const de = await customer("Erika Privat", "DE")
  // today, and a day in the quarter before this one (German calendar)
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date())
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
  const quarter = Math.floor((m - 1) / 3) + 1
  const early = new Date(Date.UTC(y, 3 * (quarter - 1), 1) - 20 * 86_400_000).toISOString().slice(0, 10)
  const earlyQuarter = Math.floor((Number(early.slice(5, 7)) - 1) / 3) + 1
  const invoice = async (customerId: string, issueDate: string, net: number, vatRate: number) => {
    const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
      headers: H, data: { customerId, issueDate, dueDate: "2099-12-31", items: [{ description: "Ware", quantity: 1, unit: "Stk", unitPrice: net, vatRate }] },
    })).json()
    expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).ok()).toBeTruthy()
    return inv.id as string
  }
  await invoice(fr, today, 100, 0.2)
  await invoice(de, today, 300, 0.19)
  const old = await invoice(fr, early, 80, 0.2)
  expect((await request.post(`${API}/api/v1/invoices/${old}/credit-note?${q}`, { headers: H, data: { reason: "Retoure" } })).status()).toBe(201)

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

  // the UStVA: the German sale in the table, the French ones (less the credit note) in the note
  await page.goto("/dashboard/accounting/ustva")
  const sum = page.getByTestId("ustva-sales-vat-sum")
  await expect(sum).toBeVisible({ timeout: 60_000 })
  await expect(sum).toHaveText(/57,00/)
  const note = page.getByTestId("ustva-oss-note")
  await expect(note).toBeVisible()
  await expect(note).toContainText("OSS-Verfahren")
  // the page opens on the year: the sale of the quarter before is in it unless that was last year
  const sameYear = early.slice(0, 4) === String(y)
  await expect(note).toContainText(sameYear ? /netto 100,00\s*€, Steuer 20,00\s*€/ : /netto 20,00\s*€, Steuer 4,00\s*€/)
  await expect(page.locator("table").first()).not.toContainText("20%")

  // the OSS tab: this quarter's sale, and the credit note as a correction of the quarter before
  await page.goto("/dashboard/reports")
  await page.getByTestId("tab-oss").click({ timeout: 60_000 })
  await expect(page.getByTestId("oss-tab")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("oss-total-vat")).toHaveText(/20,00/, { timeout: 30_000 })
  const row = page.getByTestId("oss-correction-row")
  await expect(row).toHaveCount(1)
  await expect(row).toContainText("Frankreich")
  await expect(row).toContainText(`Q${earlyQuarter}/${early.slice(0, 4)}`)
  await expect(row).toContainText("-16,00")
  await expect(page.getByTestId("oss-vat-due")).toHaveText(/4,00/)

  // Tier 649: whether the company is in the OSS scheme is its own setting
  await expect(page.getByTestId("oss-setting-note")).toContainText("nicht angemeldet")
  await page.goto("/dashboard/settings")
  const setting = page.getByTestId("settings-oss-verfahren")
  await expect(setting).toHaveValue("nein", { timeout: 60_000 })
  await expect(page.getByLabel("OSS-Verfahren (§ 18j UStG)")).toHaveCount(1)
  await setting.selectOption("ja")
  await page.getByTestId("settings-save").click()
  // saved, and said so as a success — it was shown as an error
  const toast = page.getByText("Einstellungen erfolgreich gespeichert!")
  await expect(toast).toBeVisible({ timeout: 30_000 })
  const company = await (await request.get(`${API}/api/v1/companies/${companyId}?${q}`, { headers: H })).json()
  expect(company.ossVerfahren).toBe(true)
  await page.reload()
  await expect(page.getByTestId("settings-oss-verfahren")).toHaveValue("ja", { timeout: 60_000 })
  await page.goto("/dashboard/reports")
  await page.getByTestId("tab-oss").click({ timeout: 60_000 })
  await expect(page.getByTestId("oss-setting-note")).toContainText("OSS-Verfahren: angemeldet", { timeout: 30_000 })
})
