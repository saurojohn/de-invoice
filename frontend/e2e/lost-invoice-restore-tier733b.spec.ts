/**
 * Tier 733b — an invoice a restore lost, entered again from its kept copy.
 *
 * After a restore from a dump older than an invoice, its kept copy is back
 * with the files, its row is not; Tier 733 retires the number. The invoice
 * list says so and offers „Aus der Kopie wiederherstellen“: the invoice is
 * in the books again under its number, with the copy's amounts.
 * (The rules: backend specs 451, 452.)
 */
import { test, expect } from "@playwright/test"
import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { PG_CONTAINER } from "./fixtures/test-env"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const STORE = process.env.STORAGE_PATH || ""
const psql = (sql: string) =>
  execSync(`docker exec ${PG_CONTAINER} psql -U de_invoice -d de_invoice -qAtc ${JSON.stringify(sql)}`).toString().trim()

test("a lost invoice is listed and restored from its copy", async ({ page, request }) => {
  test.skip(!STORE || STORE.includes("/data/"), "needs the backend's throwaway STORAGE_PATH")
  const tag = `t733b-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier733b-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", phone: "+49 30 1", email: "info@t733b.example.test", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `Kunde ${tag} GmbH`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" }, contact: { email: `ap@${tag}.example.test` } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: new Date().toISOString().slice(0, 10), items: [{ description: "Beratung", quantity: 2, unit: "Std", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

  // what a restore leaves: the copy of the next invoice, its row gone with the dump
  const lost = inv.invoiceNumber.replace(/\d+$/, (n: string) => String(Number(n) + 1).padStart(n.length, "0"))
  const kept = psql(`select "pdfPath" from "Invoice" where id = '${inv.id}'`)
  const dir = path.join(STORE, path.dirname(kept))
  const base = path.join(dir, `${Date.now() + 1}_${lost}`)
  fs.copyFileSync(path.join(STORE, kept), `${base}.pdf`)
  const xml = fs.readFileSync(path.join(STORE, kept.replace(/\.pdf$/, ".xrechnung.xml")), "utf8")
  fs.writeFileSync(`${base}.xrechnung.xml`, xml.split(inv.invoiceNumber).join(lost))
  psql(`insert into "RetiredInvoiceNumber" (id, "companyId", "invoiceNumber", reason, "pdfPath") values (gen_random_uuid()::text, '${companyId}', '${lost}', 'restore', '${path.relative(STORE, `${base}.pdf`)}')`)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-28T00:00:00.000Z" }))
    },
    { userId, companyId },
  )

  await page.goto("/dashboard/invoices")
  const notice = page.getByTestId("lost-invoices")
  await expect(notice).toBeVisible({ timeout: 60_000 })
  await expect(notice).toContainText("1 ausgestellte Rechnung(en) fehlen in den Büchern")
  await expect(notice.getByTestId("lost-invoice")).toContainText(lost)

  await notice.getByTestId("lost-invoice-restore").click()
  await page.waitForURL(/\/dashboard\/invoices\/[0-9a-f-]{36}$/, { timeout: 60_000 })
  await expect(page.getByText(lost).first()).toBeVisible({ timeout: 60_000 })
  const restored = psql(`select status || '|' || (total = 238)::text from "Invoice" where "companyId" = '${companyId}' and "invoiceNumber" = '${lost}'`)
  expect(restored).toBe("sent|true")

  await page.goto("/dashboard/invoices")
  await expect(page.getByTestId("invoices-title")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("lost-invoices")).toHaveCount(0)
})
