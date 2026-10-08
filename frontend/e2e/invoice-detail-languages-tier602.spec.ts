/**
 * Tier 602 — the invoice page speaks the chosen language.
 *
 * 69 texts on /dashboard/invoices/[id] had no translation key — the section
 * headings, the column heads of the line items, the totals, the download
 * buttons, the payment form — and stayed German in Chinese and English.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the invoice page in German, Chinese and English", async ({ page, request }) => {
  const tag = `t602-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier602-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: new Date().toISOString().slice(0, 10), items: [{ description: "Beratung", quantity: 2, unit: "Std", unitPrice: 150, vatRate: 0.19 }] },
  })).json()
  expect(inv.id, "fixture: an invoice").toBeTruthy()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  const open = async (locale: string) => {
    await page.addInitScript(
      ({ userId, companyId, locale }: { userId: string; companyId: string; locale: string }) => {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
        localStorage.setItem("locale", locale)
        localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
      },
      { userId, companyId, locale },
    )
    await page.goto(`/dashboard/invoices/${inv.id}`)
    await expect(page.locator("body")).toContainText(inv.invoiceNumber, { timeout: 60_000 })
    await page.waitForLoadState("networkidle")
    return (await page.locator("body").innerText()).replace(/\s+/g, " ")
  }
  const GERMAN = ["Rechnungsinformationen", "Positionen", "Einzelpreis", "Zwischensumme (Netto):", "PDF herunterladen", "Fälligkeitsdatum"]
  const de = await open("de")
  for (const s of GERMAN) expect(de, `German: ${s}`).toContain(s)
  const zh = await open("zh")
  for (const s of ["发票信息", "明细", "单价", "小计（净额）：", "下载 PDF", "到期日"]) expect(zh, `Chinese: ${s}`).toContain(s)
  for (const s of GERMAN) expect(zh, `Chinese page still says ${s}`).not.toContain(s)
  const en = await open("en")
  for (const s of ["Invoice details", "Line items", "Unit price", "Subtotal (net):", "Download PDF", "Due date"]) expect(en, `English: ${s}`).toContain(s)
  for (const s of GERMAN) expect(en, `English page still says ${s}`).not.toContain(s)
  for (const text of [de, zh, en]) expect(text).not.toMatch(/invoicePage\.[a-zA-Z0-9]+/)
})
