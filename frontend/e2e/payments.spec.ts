import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[m.length - 1]
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

async function injectAuth(page: Page) {
  if (!testTokens) return
  const { userId, companyId } = testTokens
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
}

test.describe("SEPA pain.001 batch payments — /dashboard/payments", () => {
  test("payments page loads with title + subtitle", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments")
    await expect(page.getByTestId("payments-page")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("payments-title")).toBeVisible()
  })

  test("shows the unpaid expenses table or the empty hint", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments")
    await expect(page.getByTestId("payments-page")).toBeVisible({ timeout: 30_000 })
    // Either the table is visible (when unpaid expenses exist) OR the
    // empty hint is shown. The e2e 134 setup may have left data behind.
    const table = page.getByTestId("payments-unpaid-table")
    const empty = page.getByTestId("payments-empty")
    // One of them should be present
    await expect(table.or(empty)).toBeVisible({ timeout: 15_000 })
  })

  test("create-batch form is visible when unpaid expenses exist", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments")
    await expect(page.getByTestId("payments-page")).toBeVisible({ timeout: 30_000 })
    // Conditional: if no unpaid expenses, the form doesn't render.
    const form = page.getByTestId("payments-create-form")
    const empty = page.getByTestId("payments-empty")
    await expect(form.or(empty)).toBeVisible({ timeout: 15_000 })
    // If the form is visible, the date input + create button must be too.
    if (await form.isVisible().catch(() => false)) {
      await expect(page.getByTestId("execution-date-input")).toBeVisible()
      await expect(page.getByTestId("create-batch-button")).toBeVisible()
    }
  })

  test("batches table or empty hint is rendered", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/payments")
    await expect(page.getByTestId("payments-page")).toBeVisible({ timeout: 30_000 })
    const table = page.getByTestId("payments-batches-table")
    const empty = page.getByTestId("payments-no-batches")
    await expect(table.or(empty)).toBeVisible({ timeout: 15_000 })
  })

  test("dashboard card for SEPA-Sammelzahlung links to /dashboard/payments", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("dashboard-card-payments")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("dashboard-card-payments").click()
    await page.waitForURL("**/dashboard/payments", { timeout: 15_000 })
    await expect(page.getByTestId("payments-page")).toBeVisible({ timeout: 15_000 })
  })
})
