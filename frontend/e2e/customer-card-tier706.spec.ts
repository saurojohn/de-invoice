/**
 * Tier 706 — the customer cards say what is so.
 *
 * Walked through in the browser (dark mode): every customer card said "Inaktiv" — the
 * badge read `customer.status`, a field customers do not have; its own hint
 * says "Letzte Rechnung älter als 90 Tage oder nie beauftragt". A customer
 * without its own payment term showed "Zahlungsfrist (Tage): Tage", and the
 * name was cut to "Kund…" beside the two badges.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test.use({ colorScheme: "dark" })

/** WCAG contrast of an element's text against the background it stands on. */
async function contrastOf(page: import("@playwright/test").Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement
    const ctx = document.createElement("canvas").getContext("2d")!
    const rgb = (css: string) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
    }
    let bgEl: HTMLElement | null = el
    let bg = "rgba(0, 0, 0, 0)"
    while (bgEl) {
      bg = getComputedStyle(bgEl).backgroundColor
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") break
      bgEl = bgEl.parentElement
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(bg))
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }, selector)
}

test("the cards: Aktiv by the last invoice, the company's term, the whole name", async ({ page, request }) => {
  const tag = `t706-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier706-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  expect((await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { vatId: "DE123456789", defaultPaymentDays: 14, address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = async (name: string) =>
    (await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
      headers: H,
      data: { name, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
    })).json()) as { id: string }
  const busy = await customer("Kunde AG")
  await customer("Lange Firmenbezeichnung Handelsgesellschaft mbH") // never invoiced
  const inv = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: busy.id, issueDate: new Date().toISOString().slice(0, 10), items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-19T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto("/dashboard/customers")
  const card = (name: string) => page.locator('[data-testid="customer-activity"]').locator("xpath=ancestor::*[contains(@class,'rounded')][1]").filter({ hasText: name })
  await expect(page.getByTestId("customer-activity")).toHaveCount(2, { timeout: 60_000 })

  // invoiced today: Aktiv; never invoiced: Inaktiv (was: both Inaktiv)
  await expect(card("Kunde AG").getByTestId("customer-activity")).toHaveText("Aktiv")
  await expect(card("Lange Firmenbezeichnung").getByTestId("customer-activity")).toHaveText("Inaktiv")
  // the company's term (was "Zahlungsfrist (Tage): Tage")
  await expect(card("Kunde AG")).toContainText("Zahlungsfrist (Tage): 14 (Firmenstandard)")
  // the whole short name is there (was "Kund…")
  const fits = await page.getByText("Kunde AG", { exact: true }).first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  expect(fits).toBe(true)

  // the customer's page: its kind and term (was "business · Zahlungsfrist (Tage): Tage"), and the
  // invoice list's grey "Ausgangsrechnung" reads on the dark page (was dark grey on dark)
  await page.goto(`/dashboard/customers/${busy.id}`)
  await expect(page.locator("body")).toContainText("Geschäftskunde · Zahlungsfrist (Tage): Firmenstandard", { timeout: 60_000 })
  await page.getByTestId("tab-invoices").click()
  const kind = page.getByTestId("tab-invoices-row").first().locator("td").nth(3)
  await expect(kind).toHaveText("Ausgangsrechnung")
  await kind.evaluate((el) => el.setAttribute("data-t706", "kind"))
  expect(await contrastOf(page, '[data-t706="kind"]')).toBeGreaterThanOrEqual(4.5)
})
