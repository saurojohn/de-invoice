/**
 * Tier 562 — a page asks for each thing once, not in a loop.
 *
 * Found by running the production stack locally, where the rate limit is on
 * (it is off in dev and CI): the settings page's dunning card fetched its
 * config hundreds of times in a few seconds and the create-invoice page
 * reloaded its five lists on every render — `t` and `getDateLocale` from
 * useI18n were new functions on each render and sat in the dependency lists
 * of `useCallback(load)` + `useEffect(load)`. After ~600 requests in a minute
 * everything on the page answered 429. The customer page asked again forever
 * whenever a tab's request failed (null meant "not loaded yet").
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = "http://localhost:3001"

async function tenant(request: APIRequestContext) {
  const tag = `t562-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier562-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  return { userId, companyId, H: { "x-user-id": userId, "x-company-id": companyId } }
}

async function signIn(page: Page, userId: string, companyId: string) {
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

/** Open `path`, let it settle, and count the API requests per endpoint. */
async function countRequests(page: Page, path: string, settleMs = 6000): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  page.on("request", (r) => {
    const u = new URL(r.url())
    if (!u.pathname.startsWith("/api/v1/")) return
    const key = `${r.method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`
    counts[key] = (counts[key] || 0) + 1
  })
  await page.goto(path)
  await page.waitForTimeout(settleMs)
  return counts
}

for (const path of ["/dashboard/settings", "/dashboard/invoices/create"]) {
  test(`${path} asks for each thing a few times at most`, async ({ page, request }) => {
    const { userId, companyId } = await tenant(request)
    await signIn(page, userId, companyId)
    const counts = await countRequests(page, path)
    const repeated = Object.entries(counts).filter(([, n]) => n > 4)
    expect(repeated, `requests repeated on ${path}: ${JSON.stringify(repeated)}`).toEqual([])
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(total, `${total} API requests on ${path} (was hundreds)`).toBeLessThan(80)
  })
}

test("a customer tab whose request fails is not asked for again and again", async ({ page, request }) => {
  const { userId, companyId, H } = await tenant(request)
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: "Tier 562 Kunde", type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  await signIn(page, userId, companyId)
  let asked = 0
  // the invoices tab is the one open by default
  await page.route("**/api/v1/invoices?**", (route) => {
    asked++
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ statusCode: 500, message: "boom" }) })
  })
  await page.goto(`/dashboard/customers/${customer.id}`)
  await page.waitForTimeout(6000)
  expect(asked, "the failing request was made at least once").toBeGreaterThan(0)
  expect(asked, `the failing request was made ${asked} times (was: without end)`).toBeLessThan(5)
  // Tier 565: and the tab says that it failed — an empty list looked like
  // "this customer has no invoices" — and can be asked again.
  await expect(page.getByTestId("customer-tab-error")).toBeVisible()
  const before = asked
  await page.unroute("**/api/v1/invoices?**")
  await page.getByTestId("customer-tab-retry").click()
  await expect(page.getByTestId("customer-tab-error")).toHaveCount(0)
  await page.waitForTimeout(1500)
  expect(asked, "retry does not go through the failing stub again").toBe(before)
})
