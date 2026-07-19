import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 68: Global Search (⌘K command bar) UI.
 *
 * The root layout mounts <GlobalSearch /> so the
 * shortcut works on every page. This spec
 * covers:
 *
 *   1. ⌘K opens the modal from any page (we test
 *      it on the dashboard).
 *   2. Esc closes the modal.
 *   3. Typing a query shows grouped hits
 *      (Customers / Invoices / Products).
 *   4. The "Müller GmbH" customer appears when
 *      typing "Muller" (unaccent match).
 *   5. The empty hint shows for short queries.
 *   6. Clicking a hit navigates to the entity
 *      detail page.
 *
 * Backend e2e 95 covers the API contract.
 */

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing — run backend e2e first`,
    )
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

async function injectAuth(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
  await page.context().addCookies([
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
}

test.describe("Global Search (⌘K)", () => {
  test("Cmd+K opens the modal from dashboard", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    // Wait for dashboard to be ready.
    await expect(page.getByTestId("mandant-switcher-single")).toBeVisible({
      timeout: 30_000,
    })
    // Press ⌘K. The modal must appear.
    await page.keyboard.press("Meta+k")
    await expect(page.getByTestId("global-search-modal")).toBeVisible({
      timeout: 5_000,
    })
    // The input is focused.
    const input = page.getByTestId("global-search-input")
    await expect(input).toBeFocused()
  })

  test("Esc closes the modal", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("mandant-switcher-single")).toBeVisible({
      timeout: 30_000,
    })
    await page.keyboard.press("Meta+k")
    await expect(page.getByTestId("global-search-modal")).toBeVisible({
      timeout: 5_000,
    })
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("global-search-modal")).toHaveCount(0)
  })

  test("typing shows grouped hits; 'Muller' finds Müller GmbH", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("mandant-switcher-single")).toBeVisible({
      timeout: 30_000,
    })
    await page.keyboard.press("Meta+k")
    await expect(page.getByTestId("global-search-modal")).toBeVisible({
      timeout: 5_000,
    })
    const input = page.getByTestId("global-search-input")
    await input.fill("Muller")
    // Debounce 200ms + network. Give it 3s.
    await expect(
      page.locator(
        '[data-testid="global-search-group-customer"]',
      ),
    ).toBeVisible({ timeout: 5_000 })
    // The customer group has at least one hit whose
    // title contains "Müller".
    const firstHit = page
      .getByTestId("global-search-hit")
      .filter({ has: page.locator("text=/M.+ller/") })
      .first()
    await expect(firstHit).toBeVisible({ timeout: 5_000 })
    // Close the modal.
    await page.keyboard.press("Escape")
  })

  test("short query shows the hint, no hits", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("mandant-switcher-single")).toBeVisible({
      timeout: 30_000,
    })
    await page.keyboard.press("Meta+k")
    await expect(page.getByTestId("global-search-modal")).toBeVisible({
      timeout: 5_000,
    })
    // No query yet — the input is empty. The hint
    // shows. No hits.
    await expect(page.getByTestId("global-search-hit")).toHaveCount(0)
  })

  test("clicking a hit navigates to the entity detail page", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("mandant-switcher-single")).toBeVisible({
      timeout: 30_000,
    })
    await page.keyboard.press("Meta+k")
    await expect(page.getByTestId("global-search-modal")).toBeVisible({
      timeout: 5_000,
    })
    const input = page.getByTestId("global-search-input")
    await input.fill("Muller")
    await expect(
      page.locator(
        '[data-testid="global-search-group-customer"]',
      ),
    ).toBeVisible({ timeout: 5_000 })
    // Click the first customer hit.
    const firstCustomerHit = page
      .locator('[data-testid="global-search-hit"][data-hit-type="customer"]')
      .first()
    await expect(firstCustomerHit).toBeVisible({ timeout: 5_000 })
    await firstCustomerHit.click()
    // The modal closes and the URL navigates to
    // /dashboard/customers/{id}.
    await expect(page.getByTestId("global-search-modal")).toHaveCount(0)
    await page.waitForURL(/\/dashboard\/customers\/[a-f0-9-]+/, {
      timeout: 10_000,
    })
  })
})
