/**
 * Tier 728f — the settings show what an invoice looks like with the company's
 * details: „Speichern und Rechnungsvorschau“ saves the form, then renders a
 * sample invoice in the company's default template.
 * (What the PDF contains: backend spec 441.)
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("company details: save and preview an invoice", async ({ page, request }) => {
  const tag = `t728f-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier728f-e2e", companyName: `${tag} Werkstatt` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  expect((await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { rechtsform: "GmbH", vatId: "DE123456789", address: { street: "Hauptstr. 5", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).status()).toBe(200)
  // the company's default template — the preview is in it
  expect((await request.post(`${API}/api/v1/invoice-templates?companyId=${companyId}`, {
    headers: H,
    data: { companyId, name: "Haus", isDefault: true, configJson: { footerText: `Danke ${tag}` } },
  })).status()).toBe(201)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-22T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  // the PDF opens in a new tab — recorded here (headless Chromium shows a blob PDF tab as „:“)
  await page.addInitScript(() => {
    const w = window as unknown as { open: (u?: string | URL) => null; __opened?: string }
    w.open = (u) => { w.__opened = String(u); return null }
  })
  await page.goto("/dashboard/settings")
  const legal = page.getByTestId("settings-legal-name")
  await expect(legal).toBeVisible({ timeout: 60_000 })
  await legal.fill(`${tag} Werkstatt Lederwaren GmbH`)

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/invoice-templates/preview") && r.request().method() === "POST", { timeout: 30_000 }),
    page.getByTestId("settings-invoice-preview").click(),
  ])
  expect(response.status()).toBe(200)
  expect(response.headers()["content-type"]).toContain("application/pdf")
  expect(response.request().postDataJSON().configJson.footerText).toBe(`Danke ${tag}`)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: string }).__opened || "")).toMatch(/^blob:/)
  // saved first — the preview shows what was typed
  const company = await (await request.get(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, { headers: H })).json()
  expect(company.legalName).toBe(`${tag} Werkstatt Lederwaren GmbH`)
})
