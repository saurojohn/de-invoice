/**
 * Tier 867 — the search box shows a snippet's text and its <mark>s, nothing
 * else, whatever the server sends.
 *
 * The backend's fallback sent a product's raw name; a name like
 * `<b onmouseover=…>` became a live element in the search box of everyone in
 * the company. The backend escapes it now (e2e/559); the box itself also turns
 * every tag but <mark> back into text (lib/search-snippet.ts). This spec
 * answers the search with a raw tag on purpose.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext) {
  const tag = `t867-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier867-e2e", companyName: `${tag} GmbH` },
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

test("a snippet with a raw tag is shown as text; its <mark> stays a mark", async ({ page, request }) => {
  test.setTimeout(120_000)
  await signIn(page, request)
  await page.route("**/api/v1/search/global**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: "eiche",
        totalHits: 1,
        groups: [{ type: "product", count: 1, hits: [{ id: "p1", title: "x", subtitle: "", snippet: '<b id="t867-injected" onmouseover="window.__t867=1">X</b> <mark>Eiche</mark>', rank: 1 }] }],
      }),
    }),
  )
  await page.goto("/dashboard")
  await page.getByTestId("global-search-trigger").click()
  await page.getByTestId("global-search-input").fill("eiche")
  const hit = page.getByTestId("global-search-hit").first()
  await expect(hit).toBeVisible({ timeout: 30_000 })
  await expect(page.locator("#t867-injected")).toHaveCount(0)
  await expect(hit).toContainText('<b id="t867-injected"')
  await expect(hit.locator("mark")).toHaveText("Eiche")
})
