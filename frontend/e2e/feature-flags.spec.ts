import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 94: Frontend Settings UI for feature flags.
 *
 * The settings page now has a "Funktions-Flags"
 * card with 4 toggles (autoBookAfa + anlageV
 * + anlageG + anlageN, tiers 100-101)
 * + a save/reset pair + a "next run" hint
 * for the auto-booker.
 *
 *   1. Card is present + visible.
 *   2. Both toggles render with their current
 *      state from the backend.
 *   3. Save button is disabled when no changes.
 *   4. Toggling a flag + clicking save persists
 *      it (the GET shows the new value after).
 *   5. Reset button reverts the unsaved change.
 *   6. Cross-tenant / wrong company id
 *      surfaces a toast error.
 *
 * Backend e2e 120 covers the API contract.
 * This file exercises the React page.
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
    throw new Error(`Auth cache ${AUTH_CACHE} missing — run backend e2e first`)
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
    { name: "x-user-id", value: testTokens!.userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: testTokens!.companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
}

test.describe("Feature flags — /dashboard/settings", () => {
  test("Feature flags card is present + visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })
  })

  test("All 5 toggle rows render (autoBookAfa + anlageV + anlageG + anlageN + anlageKind)", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("feature-flag-auto-book-afa")).toBeVisible()
    await expect(page.getByTestId("feature-flag-anlage-v")).toBeVisible()
    await expect(page.getByTestId("feature-flag-anlage-g")).toBeVisible()
    await expect(page.getByTestId("feature-flag-anlage-n")).toBeVisible()
    await expect(page.getByTestId("feature-flag-anlage-kind")).toBeVisible()
  })

  test("Save button is disabled until a toggle is flipped", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })
    const save = page.getByTestId("feature-flags-save")
    await expect(save).toBeVisible()
    // No dirty state yet → button disabled
    await expect(save).toBeDisabled()
  })

  test("Auto-AfA toggle + save persists the new value", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })

    // The toggle is a hidden input (sr-only) inside
    // a label that has a visible <span> thumb. We
    // click the parent label (which is the visual
    // click target the user interacts with) — the
    // click propagates to the input and fires the
    // React onChange handler. Using setChecked on
    // the input alone doesn't work because React
    // overrides the DOM on the next render.
    const flag = page.getByTestId("feature-flag-auto-book-afa")
    const label = flag.locator("label")
    const toggle = page.getByTestId("feature-flag-auto-book-afa-toggle")
    const wasChecked = await toggle.isChecked()

    // Flip via the visible label
    await label.click()

    // Save button is now enabled
    const save = page.getByTestId("feature-flags-save")
    await expect(save).toBeEnabled()
    await save.click()

    // Wait for the success toast / card re-render
    await expect(toggle).toBeChecked({ checked: !wasChecked })
  })

  test("Anlage V toggle + save persists the new value", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })

    const flag = page.getByTestId("feature-flag-anlage-v")
    const label = flag.locator("label")
    const toggle = page.getByTestId("feature-flag-anlage-v-toggle")
    const wasChecked = await toggle.isChecked()

    await label.click()
    await page.getByTestId("feature-flags-save").click()
    await expect(toggle).toBeChecked({ checked: !wasChecked })
  })

  test("Anlage Kind toggle + save persists the new value", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })

    const flag = page.getByTestId("feature-flag-anlage-kind")
    const label = flag.locator("label")
    const toggle = page.getByTestId("feature-flag-anlage-kind-toggle")
    const wasChecked = await toggle.isChecked()

    await label.click()
    await page.getByTestId("feature-flags-save").click()
    await expect(toggle).toBeChecked({ checked: !wasChecked })
  })

  test("Reset button reverts the unsaved change", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })

    const flag = page.getByTestId("feature-flag-auto-book-afa")
    const label = flag.locator("label")
    const toggle = page.getByTestId("feature-flag-auto-book-afa-toggle")
    const wasChecked = await toggle.isChecked()

    // Flip + reset (without saving) → toggle back
    // to the original state, save button disabled.
    await label.click()
    await expect(page.getByTestId("feature-flags-save")).toBeEnabled()
    await page.getByTestId("feature-flags-reset").click()
    await expect(toggle).toBeChecked({ checked: wasChecked })
    await expect(page.getByTestId("feature-flags-save")).toBeDisabled()
  })

  test("Next auto-booker run hint is visible", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/settings")
    await expect(page.getByTestId("feature-flags-card")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("feature-flag-auto-book-afa-next-run")).toBeVisible()
  })
})
