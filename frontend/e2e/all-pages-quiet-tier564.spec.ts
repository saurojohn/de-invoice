/**
 * Tier 564 — every page, opened once, behaves: it does not ask for the same
 * thing over and over, it does not call an API route that does not exist,
 * nothing it calls answers 5xx, and it throws nothing.
 *
 * Tier 562 found three pages fetching in a loop and one calling a route that
 * was never there — by opening pages one by one against the production stack.
 * No spec looked at a page from that side; each one tests its own feature.
 * This one opens them all.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = "http://localhost:3001"

const ROUTES = [
  "/dashboard", "/dashboard/accounting", "/dashboard/accounting/journal", "/dashboard/accounting/ustva",
  "/dashboard/activity", "/dashboard/assets", "/dashboard/audit", "/dashboard/backups",
  "/dashboard/bank-import", "/dashboard/banking", "/dashboard/banking/transfers", "/dashboard/berater",
  "/dashboard/cashbook", "/dashboard/cashflow", "/dashboard/cost-center-budgets", "/dashboard/cost-center-report",
  "/dashboard/customers", "/dashboard/email", "/dashboard/expenses", "/dashboard/import", "/dashboard/inventory",
  "/dashboard/invoice-templates", "/dashboard/invoices", "/dashboard/invoices/create", "/dashboard/mahnungen",
  "/dashboard/mahnungen/settings", "/dashboard/mahnungen/templates", "/dashboard/payments",
  "/dashboard/payments/direct-debit", "/dashboard/products", "/dashboard/recurring-invoices", "/dashboard/reminders",
  "/dashboard/reminders/templates", "/dashboard/reports", "/dashboard/reports/aging", "/dashboard/security",
  "/dashboard/settings", "/dashboard/settings/note-templates", "/dashboard/settings/users",
  "/dashboard/settings/webhooks", "/dashboard/suppliers", "/dashboard/system-errors", "/dashboard/system-health",
  "/dashboard/v2",
]

// A 404 that is an answer, not a missing route.
const EXPECTED_404 = [
  /^GET \/api\/v1\/cashbook\/close$/, // "no close for today"
]

let userId = ""
let companyId = ""
// Tier 567: the pages with a parameter, filled in beforeAll.
const dynamicRoutes: string[] = []

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  const tag = `t564-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier564-e2e", companyName: `${tag} GmbH` },
  })).json()
  userId = reg.user.id
  companyId = reg.user.companyId || reg.company.id

  // Something to open: a customer, an issued invoice, its voucher.
  const H = { "x-user-id": userId, "x-company-id": companyId }
  await request.put(`${API}/api/v1/companies/${companyId}`, {
    headers: H,
    data: { name: `${tag} GmbH`, taxId: "12/345/67890", address: { street: "Teststr. 1", postalCode: "10115", city: "Berlin", country: "DE" } },
  })
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: "Tier 564 Kunde", type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
  const invoice = await (await request.post(`${API}/api/v1/invoices?companyId=${companyId}`, {
    headers: H,
    data: { customerId: customer.id, issueDate: today, items: [{ description: "Beratung", quantity: 1, unit: "Std", unitPrice: 100, vatRate: 0.19, costCenter: "Allgemein" }] },
  })).json()
  await request.put(`${API}/api/v1/invoices/${invoice.id}/status?companyId=${companyId}`, { headers: H, data: { status: "sent" } })
  const [y, m] = today.split("-")
  dynamicRoutes.push(
    `/dashboard/customers/${customer.id}`,
    `/dashboard/customers/${customer.id}/credit`,
    `/dashboard/customers/${customer.id}/statement`,
    `/dashboard/invoices/${invoice.id}`,
    `/dashboard/cost-center-report/${y}/${Number(m)}`,
    `/dashboard/cost-center-report/${y}/${Number(m)}/Allgemein`,
    "/dashboard/system-health/recurring-invoices",
  )
  const vouchers = await (await request.get(`${API}/api/v1/accounting/vouchers?companyId=${companyId}`, { headers: H })).json()
  const voucherId = (Array.isArray(vouchers) ? vouchers : vouchers?.data || vouchers?.items || [])[0]?.id
  if (voucherId) dynamicRoutes.push(`/dashboard/accounting/vouchers/${voucherId}`, `/dashboard/accounting/${voucherId}`)
})

async function signIn(page: Page) {
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
}

async function expectQuiet(page: Page, route: string) {
    await signIn(page)
    const counts: Record<string, number> = {}
    const bad: string[] = []
    const thrown: string[] = []
    const key = (method: string, url: string) =>
      `${method} ${new URL(url).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`
    page.on("request", (r) => {
      if (!new URL(r.url()).pathname.startsWith("/api/v1/")) return
      const k = key(r.method(), r.url())
      counts[k] = (counts[k] || 0) + 1
    })
    page.on("response", (r) => {
      if (!new URL(r.url()).pathname.startsWith("/api/v1/")) return
      const k = key(r.request().method(), r.url())
      const s = r.status()
      if (s >= 500) bad.push(`${s} ${k}`)
      if (s === 404 && !EXPECTED_404.some((re) => re.test(k))) bad.push(`404 ${k}`)
    })
    page.on("pageerror", (e) => thrown.push(String(e?.message || e).slice(0, 200)))

    await page.goto(route, { waitUntil: "load" })
    await page.waitForTimeout(5000)

    const repeated = Object.entries(counts).filter(([, n]) => n > 6).map(([k, n]) => `${k} ×${n}`)
    expect.soft(repeated, `asked again and again on ${route}`).toEqual([])
    expect.soft([...new Set(bad)], `missing route or server error on ${route}`).toEqual([])
    expect.soft([...new Set(thrown)], `uncaught error on ${route}`).toEqual([])
    await expect.soft(page.locator("body"), `error screen on ${route}`).not.toContainText(/Application error|Unhandled Runtime Error/)
}

for (const route of ROUTES) {
  test(`${route} is quiet`, async ({ page }) => {
    await expectQuiet(page, route)
  })
}

// Tier 567: the pages with a parameter. Their ids exist only after
// beforeAll, so they share one test (the names of tests are fixed at load).
test("the pages with a parameter are quiet", async ({ page }) => {
  test.setTimeout(180_000)
  expect(dynamicRoutes.length, "fixtures for the parameter pages").toBeGreaterThanOrEqual(7)
  for (const route of dynamicRoutes) {
    await expectQuiet(page, route)
  }
})
