/**
 * Tier 837 — the loss carried forward in the KSt 1 section.
 *
 * Measured before: a GmbH's loss of one year was not deducted the year after
 * (Kz 50 a placeholder, the full profit taxed). Now the section shows the loss
 * account — carried in, deducted, carried on — for KSt and GewSt, and the
 * figure of the Verlustfeststellungsbescheid can be entered over the app's own.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
test("the loss of the year before is deducted, and the Bescheid's figure can be entered", async ({ page, request }) => {
  const tag = `t837-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier837-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H,
    data: { rechtsform: "GmbH", address: { street: "Teststr. 1", postalCode: "10115", city: "Berlin", country: "DE" }, taxId: "12/345/67890" },
  })
  // The section opens on the previous year: a loss of 5 000 € the year before it, 8 000 € profit in it.
  const year = new Date().getFullYear() - 1
  expect((await request.post(`${API}/api/v1/expenses?${q}`, {
    headers: H,
    data: { description: "Werbung", invoiceNumber: `${tag}-W`, invoiceDate: `${year - 1}-06-01`, netAmount: 5000, vatRate: 0.19, vatAmount: 950, grossAmount: 5950, category: "Werbung" },
  })).status()).toBe(201)
  const cust = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde`, type: "business", address: { street: "Teststr. 9", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H,
    data: { customerId: cust.id, issueDate: `${year}-05-01`, items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 8000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

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
  await page.goto("/dashboard/accounting")
  const box = page.getByTestId("kst1-verlustvortrag")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")

  // the app's own year before: 5 000 carried in, all of it deducted
  await expect(box.getByTestId("kst1-verlust-kst-abzug")).toContainText("5.000,00")
  await expect(box.getByTestId("kst1-verlust-kst-quelle")).toContainText("Vorjahren")
  await expect(box.getByTestId("kst1-verlust-gewst-abzug")).toContainText("5.000,00")
  await expect(page.getByTestId("kst1-zve")).toContainText("3.000,00")

  // the Bescheid says 2 000 for the KSt
  await box.getByTestId("kst1-vv-kst").fill("2000")
  await box.getByTestId("kst1-vv-save").click()
  await expect(box.getByTestId("kst1-verlust-kst-quelle")).toContainText("Feststellungsbescheid", { timeout: 30_000 })
  await expect(box.getByTestId("kst1-verlust-kst-abzug")).toContainText("2.000,00")
  await expect(page.getByTestId("kst1-zve")).toContainText("6.000,00")
  // the GewSt keeps the app's own figure
  await expect(box.getByTestId("kst1-verlust-gewst-abzug")).toContainText("5.000,00")

  const k = await (await request.get(`${API}/api/v1/accounting/kst1?${q}&year=${year}`, { headers: H })).json()
  expect(k.totals.zve).toBe(6000)
  expect(k.verlustvortrag.kst.quelle).toBe("bescheid")
  expect(k.verlustvortrag.gewst.quelle).toBe("berechnet")
})
