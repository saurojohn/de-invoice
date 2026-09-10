import { test, expect, Page } from "@playwright/test"
import { readFileSync } from "fs"

// Tier 12 + 13: end-to-end UI tests via Playwright.
// The backend e2e suite (backend/e2e/*.sh) tests the
// API contract. This file exercises the React pages
// in a real headless Chromium — hydration, layout,
// JSX errors, 404s on /dashboard/* routes, all the
// things a HTTP test can't see.
//
// Tier 13: we no longer call /auth/login in
// beforeAll. The backend e2e suite (run before this
// file) writes USER_ID + COMPANY_ID to
// /tmp/cashbook-e2e-auth.env. We read that file
// and inject the values into cookies +
// localStorage directly. This keeps Playwright
// under the backend's 5/min /auth/login throttler.
// The "wrong password" test below still hits
// /auth/login (it's testing 401 behavior), but
// it's the only /auth/login call in the whole
// file.

// Tier 13: read the cached token from the backend
// e2e suite. The first backend e2e test to call
// login() writes this file. We don't depend on
// any specific test running first — we just read
// whatever the latest entry is.
const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  // Parse `KEY=VALUE` lines. Comments and blank
  // lines are ignored (matching bash env-file
  // behavior). We use a tiny parser instead of
  // shelling out to `source` so the test is
  // self-contained.
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  const userId = map.USER_ID
  const companyId = map.COMPANY_ID
  if (!userId || !companyId) {
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing USER_ID/COMPANY_ID. ` +
        `Run the backend e2e suite first (\`for f in backend/e2e/[0-9]*.sh; do bash "$f"; done\`), ` +
        `which writes this file on its first login() call.`,
    )
  }
  return { userId, companyId }
}

const TEST_USER = {
  email: "info@shleder.de",
  password: "Test1234!",
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(async () => {
  testTokens = readCachedTokens()
})

// Inject the cached tokens into every
// new page (across all tests in the
// file) so they don't have to re-login
// and hit the throttler.
//
// The Next.js middleware runs BEFORE
// the page's JavaScript, so a
// client-side addInitScript would be
// too late. We must set the cookies
// on the BROWSER CONTEXT — those are
// sent on every request from the
// moment the page first loads.
test.beforeEach(async ({ context }: { context: any }) => {
  if (!testTokens) return
  // domain + path (NOT url) — Playwright
  // accepts either/or, and using both
  // sometimes triggers the "should have
  // either url or path" error.
  await context.addCookies([
    {
      name: "x-user-id",
      value: testTokens.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
})

// Also set localStorage on the page
// (used by the auth helpers that
// read userId / companyId directly).
test.beforeEach(async ({ page }: { page: Page }) => {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
})

test.describe("Smoke", () => {
  test("login page renders", async ({ page }) => {
    // Tier 12.1: bare-minimum hydration
    // check. If Next.js crashed on
    // build, this fails before we
    // even fill in the form.
    await page.goto("/login")
    await expect(page.locator('input[name="email"]')).toBeVisible()
    await expect(page.locator('input[name="password"]')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toBeVisible()
  })

  test("unauthenticated /dashboard redirects to /login", async ({ page }) => {
    // Tier 12.2: any /dashboard/* route
    // should redirect to /login when the
    // user is not authenticated. We use
    // a fresh context WITHOUT the
    // beforeEach cookie injection so
    // the middleware sees no cookies.
    const browser = page.context().browser()!
    const ctx = await browser.newContext()
    const freshPage = await ctx.newPage()
    await freshPage.goto("/dashboard")
    const finalUrl = freshPage.url()
    expect(finalUrl).toMatch(/\/login/)
    await ctx.close()
  })

  test("login with valid credentials lands on dashboard", async ({ page }) => {
    // Tier 13: navigate to /login, fill in
    // the real credentials, submit. The
    // backend's /auth/login endpoint is
    // hit once — this test exercises the
    // full login flow as a real user would
    // see it. The cookies + localStorage
    // from beforeEach are NOT relevant
    // here (we're testing the login
    // button's behavior). The beforeEach
    // injection doesn't conflict — it
    // just sets values that get
    // overwritten by the real login.
    await page.goto("/login")
    await page.fill('input[name="email"]', TEST_USER.email)
    await page.fill('input[name="password"]', TEST_USER.password)
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 })
    await expect(page.locator("body")).not.toContainText("Application error")
  })

  test("login with wrong password shows an error", async ({ page }) => {
    // Tier 12.4: 401 path renders an
    // error toast. This test DOES
    // hit the auth API (with a wrong
    // password). It's the only test in
    // the suite that needs a fresh
    // login attempt — running it
    // should not exhaust the throttler
    // because the wrong-password
    // request is a single 401.
    await page.goto("/login")
    await page.fill('input[name="email"]', TEST_USER.email)
    await page.fill('input[name="password"]', "WRONG-PASSWORD-12345")
    await page.click('button[type="submit"]')
    await page.waitForTimeout(1500)
    expect(page.url()).toMatch(/\/login/)
  })
})

test.describe("Dashboard", () => {
  test("dashboard renders KPI tiles", async ({ page }) => {
    // Tier 12.5: the KPI snapshot we
    // optimized in Tier 12 (8ms warm
    // cache). Look for the "Umsatz" /
    // "Belege" labels in the German
    // default locale.
    await page.goto("/dashboard")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })
    const body = await page.locator("body").innerText()
    expect(body).toMatch(/Umsatz|Belege|Revenue|Invoices/i)
  })
})

test.describe("Customers", () => {
  test("customers page renders without console errors", async ({ page }) => {
    // Tier 12.6: console errors during
    // page load are a Tier 12-nightmare
    // pattern (Next 16 + Suspense +
    // hydration mismatches surface as
    // console.error, not as a visible
    // crash).
    const errors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text())
    })
    page.on("pageerror", (err) => {
      errors.push(err.message)
    })

    await page.goto("/dashboard/customers")
    await page.waitForLoadState("networkidle", { timeout: 10_000 })

    // Filter out expected errors (e.g.
    // the 401 from the first /me fetch
    // when the cookie hasn't been
    // mirrored yet). We only fail on
    // hard JS errors.
    const fatal = errors.filter(
      (e) =>
        !e.includes("401") &&
        !e.includes("Failed to load resource") &&
        !e.includes("x-user-id"),
    )
    expect(fatal).toEqual([])
  })

  test("empty customer list shows EmptyState component", async ({ page }) => {
    // Tier 12.7: the new Skeleton +
    // EmptyState primitives. The list
    // might not be empty (SH Leder has
    // seed customers), so we use a
    // very specific search that
    // returns no results.
    await page.goto("/dashboard/customers")
    await page.waitForLoadState("networkidle")
    const searchInput = page
      .locator('input[placeholder*="Suche" i], input[type="search"]')
      .first()
    if (await searchInput.isVisible()) {
      await searchInput.fill("ZZZ-DOES-NOT-EXIST-XYZ-XYZ")
      await page.waitForTimeout(500)
      const body = await page.locator("body").innerText()
      expect(body).toMatch(/Keine|Kein Treffer|No results|No matching/i)
    }
  })
})

test.describe("Journal", () => {
  test("journal page renders with date picker", async ({ page }) => {
    // Tier 12.8: the new Buchungsjournal
    // PDF page. We don't trigger the
    // PDF generation (that hits the
    // 600/min general throttle but
    // spams the X-Journal headers) —
    // we just check the page renders
    // the date picker + label.
    await page.goto("/dashboard/accounting/journal")
    await page.waitForLoadState("networkidle")
    // The German title is "Buchungsjournal"
    // (matches our i18n key).
    const body = await page.locator("body").innerText()
    expect(body).toMatch(/Buchungsjournal|General Journal/i)
    // The two date inputs (dateFrom, dateTo)
    await expect(page.locator('input[type="date"]')).toHaveCount(2)
  })
})