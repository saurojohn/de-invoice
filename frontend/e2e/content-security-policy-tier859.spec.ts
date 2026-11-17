/**
 * Tier 859 — every page has a Content-Security-Policy, and no page breaks it.
 *
 * Security audit (18.11.2026), item 5: no page had one. Now next.config.ts
 * sends it: scripts, styles, images, connections and frames from the app and
 * its API only; no plugin objects; no foreign <base>; forms post to the app;
 * no other site frames it.
 *
 * The walk records every `securitypolicyviolation` the browser reports — a
 * page that loads something the policy forbids shows up here, before a user
 * sees a blank chart or a PDF that does not open.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext) {
  const tag = `t859-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier859-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

/** collects the policy violations the page reports, from its first script on */
async function watchViolations(page: Page): Promise<string[]> {
  const seen: string[] = []
  await page.exposeFunction("__cspViolation", (v: string) => { seen.push(v) })
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      ;(window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(
        `${location.pathname}: ${e.violatedDirective} ${e.blockedURI}`,
      )
    })
  })
  return seen
}

test("every page sends the policy", async ({ request }) => {
  for (const path of ["/login", "/register", "/dashboard"]) {
    const res = await request.get(path, { maxRedirects: 0 })
    const csp = res.headers()["content-security-policy"] || ""
    expect(csp, path).toContain("default-src 'self'")
    expect(csp, path).toContain("object-src 'none'")
    expect(csp, path).toContain("base-uri 'self'")
    expect(csp, path).toContain("form-action 'self'")
    expect(csp, path).toContain("frame-ancestors 'self'")
  }
})

test("a walk through the main pages breaks no rule of the policy", async ({ page, request }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  await signIn(page, request)
  for (const path of [
    "/dashboard",
    "/dashboard/invoices",
    "/dashboard/invoices/create",
    "/dashboard/customers",
    "/dashboard/expenses",
    "/dashboard/accounting",
    "/dashboard/accounting/journal",
    "/dashboard/settings",
    "/dashboard/security",
    "/dashboard/audit",
  ]) {
    await page.goto(path)
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {})
    await expect(page.locator("body")).not.toBeEmpty()
  }
  expect(violations).toEqual([])
})
