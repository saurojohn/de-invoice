/**
 * Tier 728 — the settings' company details: the full legal name is labelled
 * as what it is (it said „Rechtsform“), the mandatory details are checked as
 * you type, and the postcode field leaves room for the city.
 * (What the PDF prints: backend spec 439.)
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("company details: the legal name's label, the mandatory details, postcode and city", async ({ page, request }) => {
  const tag = `t728-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier728-e2e", companyName: `${tag} Werkstatt` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  // a GmbH whose letterhead name does not say so; no register entry, no directors yet
  expect((await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { rechtsform: "GmbH", vatId: "DE123456789", address: { street: "Hauptstr. 5", postalCode: "10115", city: "Berlin", country: "DE" } },
  })).status()).toBe(200)

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
  await page.goto("/dashboard/settings")
  const box = page.getByTestId("company-mandatory")
  await expect(box).toBeVisible({ timeout: 60_000 })
  await expect(box).toContainText("Pflichtangaben auf Rechnungen: 3 fehlen")
  const item = (key: string) => page.getByTestId(`company-mandatory-${key}`)
  await expect(item("address")).toHaveAttribute("data-ok", "true")
  await expect(item("taxNumber")).toHaveAttribute("data-ok", "true")
  await expect(item("legalForm")).toHaveAttribute("data-ok", "false")
  await expect(item("register")).toHaveAttribute("data-ok", "false")
  await expect(item("directors")).toHaveAttribute("data-ok", "false")
  // Tier 728h: what an XRechnung needs besides — the seller's phone and e-mail
  await expect(page.getByTestId("company-einvoice-phone")).toHaveAttribute("data-ok", "false")
  await expect(page.getByTestId("company-einvoice-email")).toHaveAttribute("data-ok", "false")

  // the field is the full name — labelled so (it said „Rechtsform“)
  const legal = page.getByTestId("settings-legal-name")
  await expect(page.locator("label", { hasText: "Vollständiger Firmenname (laut Handelsregister)" })).toBeVisible()
  await legal.fill(`${tag} Werkstatt Lederwaren GmbH`)
  await page.getByTestId("settings-register-entry").fill("Amtsgericht Berlin-Charlottenburg, HRB 123456 B")
  await page.getByTestId("settings-managing-director").fill("Anna Beispiel")
  await expect(box).toContainText("Pflichtangaben auf Rechnungen: vollständig")
  await expect(item("legalForm")).toHaveAttribute("data-ok", "true")

  // postcode narrow, the city the rest (the city was a stub beside a full-width postcode)
  const pc = await page.getByTestId("settings-postal-code").boundingBox()
  const city = await page.getByTestId("settings-city").boundingBox()
  expect(pc!.width).toBeLessThan(130)
  expect(city!.width).toBeGreaterThan(pc!.width)
})
