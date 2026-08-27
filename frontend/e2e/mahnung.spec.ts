import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 37: Mahnung multi-level flow (Mahnhistorie + fees-config).
 *
 * Tests:
 *   1. /dashboard/mahnungen renders the page chrome (title +
 *      filter tabs + empty state OR table — depends on seed).
 *   2. /dashboard/mahnungen/settings renders the fees form
 *      (verzugszins + 3 mahngebuehr inputs) and saves to backend.
 *   3. The link from /dashboard/reminders lands on /dashboard/mahnungen.
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
    throw new Error(`Auth cache ${AUTH_CACHE} missing`)
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

async function setupAuth(context: any, page: any) {
  if (!testTokens) return
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
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

test.describe("Tier 37 — Mahnung multi-level flow", () => {
  test("Mahnhistorie page renders + filter tabs work", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/mahnungen", {
      waitUntil: "domcontentloaded",
    })

    await expect(
      page.locator('[data-testid="mahnhistorie-title"]'),
    ).toBeVisible({ timeout: 15_000 })

    // Filter tabs: all 3 visible.
    const tabs = page.locator('[data-testid="mahnung-filter-tabs"]')
    await expect(tabs).toBeVisible({ timeout: 10_000 })
    expect(await tabs.locator('[data-testid^="mahnung-filter-"]').count()).toBe(
      3,
    )

    // Either the card or the empty-state should appear — both are valid.
    const card = page.locator('[data-testid="mahnhistorie-card"]')
    const empty = page.locator('[data-testid="mahnhistorie-empty"]')
    await expect(card.or(empty)).toBeVisible({ timeout: 10_000 })

    // Settings link is in the header.
    const settingsLink = page.locator(
      '[data-testid="mahnung-settings-button"]',
    )
    await expect(settingsLink).toBeVisible()

    // Click on "All" tab to verify the filter actually re-fetches.
    await page.locator('[data-testid="mahnung-filter-all"]').click()
    // We don't assert row count (depends on seed) — just that the
    // page didn't break.
    await page.waitForTimeout(500)
  })

  test("Mahnhistorie Settings: save fees-config", async ({ page, context }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/mahnungen/settings", {
      waitUntil: "domcontentloaded",
    })

    await expect(
      page.locator('[data-testid="mahnung-settings-title"]'),
    ).toBeVisible({ timeout: 15_000 })

    // 4 inputs: verzugszins + first + second + final.
    // The dev DB has Company.settings.dunning = {
    // level1Fee: 0, level2Fee: 7.5, level3Fee: 10
    // } (seeded by ci-seed.sh). Assert the
    // current state is truthy, then save new
    // values — don't pin specific defaults
    // because the seed may evolve.
    const verzugInput = page.locator(
      '[data-testid="mahnung-verzugszins-input"]',
    )
    await expect(verzugInput).toBeVisible({ timeout: 10_000 })
    const verzugVal = await verzugInput.inputValue()
    expect(verzugVal).toMatch(/^\d/)
    await expect(
      page.locator('[data-testid="mahnung-first-input"]'),
    ).toHaveValue(/^\d/)
    await expect(
      page.locator('[data-testid="mahnung-second-input"]'),
    ).toHaveValue(/^\d/)
    await expect(
      page.locator('[data-testid="mahnung-final-input"]'),
    ).toHaveValue(/^\d/)

    // Edit verzugszins to 11.5 and save.
    await page
      .locator('[data-testid="mahnung-verzugszins-input"]')
      .fill("11.5")
    await page.locator('[data-testid="mahnung-second-input"]').fill("3.0")
    await page.locator('[data-testid="mahnung-settings-save"]').click()

    // Saved banner appears.
    await expect(
      page.locator('[data-testid="mahnung-settings-saved"]'),
    ).toBeVisible({ timeout: 10_000 })
  })

  test("Legacy /reminders page links to Mahnhistorie", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/reminders", {
      waitUntil: "domcontentloaded",
    })
    // Same hydration wait as other Tier 185 / 49 / 183
    // fixes — the legacy /reminders page cold-compiles
    // in 10-15s, and a click before React hydrates
    // silently does nothing.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)

    // The "Mahnhistorie" link in the header.
    const link = page.locator(
      '[data-testid="reminders-mahnhistorie-link"]',
    )
    await expect(link).toBeVisible({ timeout: 15_000 })
    await link.click()
    await page.waitForURL(/\/dashboard\/mahnungen/, { timeout: 15_000 })
  })
})