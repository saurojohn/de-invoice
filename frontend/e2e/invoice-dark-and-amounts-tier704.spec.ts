/**
 * Tier 704 — the invoice pages, read as a user reads them.
 *
 * Walked through in the browser (dark mode, German):
 *   - the choice of the VAT treatment on the invoice form (Standard / § 13b /
 *     igL) was light grey on a near-white box: the box sets `bg-gray-50` and
 *     no dark variant, its labels inherit the light text of the dark page
 *     (128 such boxes in 37 files; globals.css now gives them dark text);
 *   - the list and the invoice page wrote amounts as "€535.50" — the form,
 *     the reports and the PDF write 535,50 €;
 *   - the invoice page labelled the VAT ids "UST-IDNr.:" (the PDF says
 *     „USt-IdNr.“ since Tier 691).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test.use({ colorScheme: "dark" })

/** WCAG contrast of an element's text against the background it stands on. */
async function contrastOf(page: import("@playwright/test").Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")!
    const rgb = (css: string) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b]
    }
    let bgEl: HTMLElement | null = el
    let bg = "rgba(0, 0, 0, 0)"
    while (bgEl) {
      bg = getComputedStyle(bgEl).backgroundColor
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") break
      bgEl = bgEl.parentElement
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const a = lum(rgb(getComputedStyle(el).color))
    const b = lum(rgb(bg))
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }, selector)
}

test("dark mode, German: the VAT choice is readable, amounts and the USt-IdNr. are written as in German", async ({ page, request }) => {
  const tag = `t704-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier704-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  expect((await request.put(`${API}/api/v1/companies/${companyId}?companyId=${companyId}`, {
    headers: H,
    data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${tag} Kunde AG`, type: "business", vatId: "DE811907980", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const invoice = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: "2026-10-01", items: [{ description: "Montage", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${invoice.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)

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

  // the form: dark mode is on, and the VAT choice reads (was ≈ 1.1 : 1)
  await page.goto("/dashboard/invoices/create")
  const box = page.getByTestId("invoice-tax-treatment")
  await expect(box).toBeVisible({ timeout: 60_000 })
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true)
  const option = box.locator("label").filter({ hasText: "Standard" }).first()
  await expect(option).toBeVisible()
  await option.evaluate((el) => el.setAttribute("data-t704", "standard"))
  expect(await contrastOf(page, '[data-t704="standard"]')).toBeGreaterThanOrEqual(4.5)

  // the list (was "€1190.00")
  await page.goto("/dashboard/invoices")
  const row = page.locator(`[data-testid="invoice-row"][data-invoice-number="${invoice.invoiceNumber}"]`)
  await expect(row).toContainText("1.190,00 €", { timeout: 60_000 })
  await expect(row).not.toContainText("€1190.00")

  // the invoice page (was "€1000.00" and "UST-IDNr.:")
  await page.goto(`/dashboard/invoices/${invoice.id}`)
  await expect(page.getByText("USt-IdNr.: DE123456789")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("USt-IdNr.: DE811907980")).toBeVisible()
  await expect(page.locator("body")).not.toContainText("UST-IDNr")
  await expect(page.locator("body")).toContainText("1.190,00 €")
  await expect(page.locator("body")).not.toContainText("€1000.00")
  // the Ratenplan hint (was "über 1190.00 EUR … von 500 EUR")
  await expect(page.getByTestId("ratensplan-suggest-banner")).toContainText("1.190,00 €", { timeout: 30_000 })
})
