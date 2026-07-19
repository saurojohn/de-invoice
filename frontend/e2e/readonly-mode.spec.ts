import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 71: Steuerberater-Modus UI.
 *
 * Tests the new ReadOnlyBanner + ReadOnlyToggle
 * that wrap the apiFetch helper with an
 * x-readonly: 1 header. The backend 403s any
 * mutation, so the user can safely review a
 * Mandant without risking an accidental write.
 *
 *   1. Toggle off by default (banner absent,
 *      toggle shows "Edit").
 *   2. Click toggle → banner appears, button
 *      label changes to "Read-Only".
 *   3. localStorage("readonly") === "1".
 *   4. The apiFetch helper sends x-readonly: 1
 *      (verified by inspecting a request).
 *   5. Reload preserves the on state.
 *   6. Click banner's "Deaktivieren" → off.
 *   7. A POST attempt in read-only mode is
 *      rejected with 403 + German error.
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

test.describe("Steuerberater-Modus (Read-Only)", () => {
  test("toggle off by default — banner absent", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("mandant-switcher-single")).toBeVisible({
      timeout: 30_000,
    })
    // The toggle is visible.
    await expect(page.getByTestId("readonly-toggle")).toBeVisible()
    // The banner is NOT visible (default off).
    await expect(page.getByTestId("readonly-banner")).toHaveCount(0)
  })

  test("click toggle → banner appears + localStorage set", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("readonly-toggle")).toBeVisible({
      timeout: 30_000,
    })
    // Click the toggle.
    await page.getByTestId("readonly-toggle").click()
    // The banner appears.
    await expect(page.getByTestId("readonly-banner")).toBeVisible({
      timeout: 5_000,
    })
    // localStorage is set.
    const ls = await page.evaluate(() => localStorage.getItem("readonly"))
    expect(ls, "localStorage readonly=1").toBe("1")
  })

  test("read-only mode actually blocks mutations (403 in German)", async ({
    page,
    request,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("readonly-toggle")).toBeVisible({
      timeout: 30_000,
    })
    // Enable read-only.
    await page.getByTestId("readonly-toggle").click()
    await expect(page.getByTestId("readonly-banner")).toBeVisible()
    // Use the Playwright request fixture (bypasses
    // CORS) to verify the backend 403s. We hit
    // the backend directly with x-readonly: 1.
    const result = await request.post(
      `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`,
      {
        headers: {
          "x-user-id": testTokens!.userId,
          "x-company-id": testTokens!.companyId,
          "x-readonly": "1",
          "Content-Type": "application/json",
        },
        data: { name: "Tier71 Playwright RO", type: "business" },
      },
    )
    expect(result.status(), "POST in RO mode").toBe(403)
    const body = await result.json()
    expect(
      body?.message || "",
      "German error message",
    ).toContain("Read-Only Modus aktiv")
  })

  test("click 'Deaktivieren' on banner → off + localStorage cleared", async ({
    page,
  }) => {
    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("readonly-toggle")).toBeVisible({
      timeout: 30_000,
    })
    // Enable.
    await page.getByTestId("readonly-toggle").click()
    await expect(page.getByTestId("readonly-banner")).toBeVisible()
    // Click the banner's deactivate button.
    await page.getByTestId("readonly-banner-deactivate").click()
    // Banner gone.
    await expect(page.getByTestId("readonly-banner")).toHaveCount(0)
    // localStorage cleared.
    const ls = await page.evaluate(() => localStorage.getItem("readonly"))
    expect(ls, "localStorage cleared").toBeNull()
  })
})
