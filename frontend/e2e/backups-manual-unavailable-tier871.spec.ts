/**
 * Tier 871 — an installation without manual backups (the production image)
 * shows no „Backup erstellen“ and no red „noch nie“, but a note pointing to
 * the automatic backups. The backend says so in GET /admin/backups
 * (`manualAvailable`); here the answer is set to false on purpose.
 */
import { test, expect, type Page } from "@playwright/test"

import { getTestEnv } from "./fixtures/test-env"

// the operator: the seeded admin of the first company (as backups.spec.ts)
async function signIn(page: Page) {
  const { userId, companyId } = getTestEnv()
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
}

test("without manual backups: no button, no red „noch nie“, a note", async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  await page.route(/\/api\/v1\/admin\/backups(\?|$)/, async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, items: [], newest: null, health: "grey", manualAvailable: false } })
  })
  await page.goto("/dashboard/backups")
  await expect(page.getByTestId("backup-manual-unavailable")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("backup-trigger")).toHaveCount(0)
  await expect(page.getByTestId("backup-health")).toHaveCount(0)
})

test("with manual backups (here): the button and the list are there", async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  await page.goto("/dashboard/backups")
  await expect(page.getByTestId("backup-trigger")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("backup-manual-unavailable")).toHaveCount(0)
})
