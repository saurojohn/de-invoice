/**
 * Tier 882 — a CSV as German Excel saves it: „;“-separated, Windows-1252,
 * decimal commas. The customers page split on „,“ only (its own „;“
 * template: „Zeile 2: Name fehlt“), both pages read UTF-8 only („Müller“ →
 * „M�ller“), and the shared parser split on „,“ and „;“ alike — „1.500,00“
 * became two cells.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function company(page: Page, request: APIRequestContext, tag: string) {
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier882-e2e", companyName: `${tag} GmbH` },
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
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-11-20T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  return { H: { "x-user-id": userId, "x-company-id": companyId }, q: `companyId=${companyId}` }
}

/** The bytes German Excel writes: Windows-1252 (ä ö ü ß are single bytes) */
const cp1252 = (s: string) => Buffer.from(s, "latin1")

test("customers page: a German Excel file with „;“ and umlauts", async ({ page, request }) => {
  const { H, q } = await company(page, request, `t882a-${Date.now()}`)
  const csv = [
    "name;type;street;postalCode;city;country;email;paymentTerms;taxExempt",
    "Müller & Söhne GmbH;business;Hauptstraße 5;50667;Köln;DE;info@mueller882.example;14;false",
    "Jürgen Weiß;privat;Gartenweg 2;80331;München;DE;jw@weiss882.example;;nein",
  ].join("\r\n") + "\r\n"
  await page.goto("/dashboard/customers")
  await page.getByRole("button", { name: "📥 Import" }).first().click({ timeout: 60_000 })
  await page.locator('input[type="file"][accept=".csv,text/csv"]').setInputFiles({ name: "kunden.csv", mimeType: "text/csv", buffer: cp1252(csv) })
  await page.getByRole("button", { name: "Import starten" }).click()
  await expect(page.getByText(/2 importiert/)).toBeVisible({ timeout: 30_000 })

  const list = await (await request.get(`${API}/api/v1/customers?${q}&pageSize=50`, { headers: H })).json()
  const rows: Array<{ name: string; type: string; taxExempt: boolean; paymentTerms: number | null; address: { street: string; city: string } }> = list.data ?? list.items ?? list
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
  expect(Object.keys(byName).sort()).toEqual(["Jürgen Weiß", "Müller & Söhne GmbH"])
  expect(byName["Müller & Söhne GmbH"].address.city).toBe("Köln")
  expect(byName["Müller & Söhne GmbH"].taxExempt).toBe(false)
  expect(byName["Müller & Söhne GmbH"].paymentTerms).toBe(14)
  expect(byName["Jürgen Weiß"].type).toBe("individual")
  expect(byName["Jürgen Weiß"].paymentTerms).toBeNull()
})

test("import page: an expense of 1.500,00 from a German Excel file", async ({ page, request }) => {
  const { H, q } = await company(page, request, `t882b-${Date.now()}`)
  const csv = [
    "description;invoiceDate;invoiceNumber;supplierName;netAmount;vatRate;vatAmount;grossAmount;category",
    "Miete Büro November;02.11.2026;M-882;Hausverwaltung Bäumer GmbH;1.500,00;19%;285,00;1.785,00;Miete",
  ].join("\r\n") + "\r\n"
  await page.goto("/dashboard/import")
  await page.getByRole("button", { name: "Eingangsrechnungen" }).click({ timeout: 60_000 })
  await page.locator('input[type="file"]').setInputFiles({ name: "belege.csv", mimeType: "text/csv", buffer: cp1252(csv) })
  await expect(page.getByText("Hausverwaltung Bäumer GmbH").first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: /1 Zeilen importieren/ }).click()
  await expect(page.getByText(/Importiert/).first()).toBeVisible({ timeout: 30_000 })

  const list = await (await request.get(`${API}/api/v1/expenses?${q}&pageSize=50`, { headers: H })).json()
  const rows: Array<{ description: string; netAmount: string; vatAmount: string; grossAmount: string }> = list.data ?? list.items ?? list
  expect(rows.map((r) => r.description)).toEqual(["Miete Büro November"])
  expect([Number(rows[0].netAmount), Number(rows[0].vatAmount), Number(rows[0].grossAmount)]).toEqual([1500, 285, 1785])
})
