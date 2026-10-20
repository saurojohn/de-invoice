/**
 * Tier 718 — the invoice list at 1 280 px in dark mode: the number on one
 * line (it broke after „INV-2026-“, „Per E-Mail“ took three lines), the table
 * in its box, every status badge a box of its own (a draft was a grey-800
 * box on the grey-800 table).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test.use({ colorScheme: "dark", viewport: { width: 1280, height: 800 } })

test("the invoice list fits 1 280 px; the status badges show in dark mode", async ({ page, request }) => {
  const tag = `t718-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier718-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: "Muster Kunde AG", type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const draft = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: "2026-10-01", items: [{ description: "Leistung", quantity: 1, unit: "Stk", unitPrice: 100, vatRate: 0.19 }] },
  })).json()

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-20T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/invoices")
  const row = page.locator(`[data-testid="invoice-row"][data-invoice-number="${draft.invoiceNumber}"]`)
  await expect(row).toBeVisible({ timeout: 60_000 })

  const look = await row.evaluate((tr) => {
    const cells = tr.querySelectorAll("td")
    const numberCell = cells[1] as HTMLElement
    const badge = cells[7].querySelector("span") as HTMLElement
    const table = tr.closest("table") as HTMLElement
    const box = table.parentElement as HTMLElement
    const lineHeight = parseFloat(getComputedStyle(numberCell).lineHeight) || 20
    const bgOf = (el: HTMLElement | null): string => {
      while (el) { const c = getComputedStyle(el).backgroundColor; if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c; el = el.parentElement }
      return ""
    }
    const buttons = [...cells[cells.length - 1].querySelectorAll("button")].map((b) => b.getBoundingClientRect().height)
    return {
      numberLines: Math.round((numberCell.querySelector("span:last-child") as HTMLElement).getBoundingClientRect().height / lineHeight),
      buttonHeights: buttons,
      tableWidth: table.scrollWidth,
      boxWidth: box.clientWidth,
      badgeBg: getComputedStyle(badge).backgroundColor,
      underBadge: bgOf(badge.parentElement),
    }
  })
  expect(look.numberLines).toBe(1)
  for (const h of look.buttonHeights) expect(h).toBeLessThan(40) // one line of text (was three)
  expect(look.tableWidth).toBeLessThanOrEqual(look.boxWidth)
  expect(look.badgeBg).not.toBe(look.underBadge) // the draft's badge is a box of its own
  await expect(page.getByTestId("invoice-sort-issueDate")).toContainText("Datum")
})
