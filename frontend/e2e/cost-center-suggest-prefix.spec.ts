import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 49: Joint Sachkonto+costCenter suggestion with
 * prefix filter.
 *
 * Tests the front-end datalist that fires per
 * keystroke. The page should:
 *   1. Re-fetch GET /cost-center-suggestion/list with
 *      the typed prefix when the user types into the
 *      cost-center input on a voucher line.
 *   2. Render the returned items as <option>s in the
 *      datalist with a count badge.
 *   3. Filter the list to only stamps matching the
 *      typed prefix.
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

test.describe("Tier 49 — Joint Sachkonto+costCenter prefix suggestion", () => {
test("typing in cc input fires prefix-filtered list call", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/accounting", {
      waitUntil: "domcontentloaded",
    })
    await expect(page).toHaveURL(/\/dashboard\/accounting$/, {
      timeout: 15_000,
    })
    // Same hydration wait as Tiers 185 / 183.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)

    // Open the create modal via the dedicated testid.
    await page.locator('[data-testid="accounting-new-voucher"]').click()
    await expect(
      page.locator('[data-testid="voucher-line-cost-center-0"]'),
    ).toBeVisible({ timeout: 10_000 })

    // Iterate the accountId dropdown until we land
    // on a Sachkonto that has at least one cost-center
    // stamp — BK-HIST-001 (VERTRIEB) lives on
    // Sachkonto 4960 in the seed. We avoid hard-coding
    // the account id and stay robust to chart-of-
    // accounts changes. If no account has any
    // stamps we skip rather than fail.
    const accountSelect = page
      .locator('[data-testid="voucher-line-cost-center-0"]')
      .locator("xpath=ancestor::tr")
      .locator("select")
      .first()
    const optionValues: string[] = await accountSelect
      .locator("option")
      .evaluateAll((els) =>
        (els as HTMLOptionElement[]).map((e) => e.value),
      )
    const realValues = optionValues.filter((v) => v && v.length > 0)
    // Tier 369: was a test.skip(). ci-seed creates the default SKR03 accounts
    // (1000/1200/1400/…), so an empty account select means the seed or the page
    // failed — not a reason to report green.
    expect(
      realValues.length,
      "the account select must offer the seeded accounts",
    ).toBeGreaterThan(0)

    let picked = false
    for (const accId of realValues) {
      await accountSelect.selectOption(accId)
      const firstListCall = await page
        .waitForResponse(
          (r) =>
            r
              .url()
              .includes(
                "/api/v1/accounting/vouchers/cost-center-suggestion/list",
              ),
          { timeout: 5_000 },
        )
        .catch(() => null)
      if (!firstListCall) continue
      const items = await firstListCall.json().catch(() => null)
      if (items && Array.isArray(items.items) && items.items.length > 0) {
        picked = true
        break
      }
    }
    // Tier 369: was a test.skip(). ci-seed.sh stamps a VoucherLine with
    // costCenter='VERTRIEB' on account 4960, so at least one account does have
    // a suggestion. If the loop finds none, either the suggestion API or the
    // seed is broken — and every datalist assertion below would be vacuous.
    expect(
      picked,
      "at least one seeded account must have a cost-center suggestion",
    ).toBe(true)

    // Now type a partial cost-center in line 0 — the
    // datalist effect should re-fire the API with
    // the typed prefix.
    const promise = page.waitForRequest(
      (req) =>
        req.method() === "GET" &&
        req
          .url()
          .includes("/api/v1/accounting/vouchers/cost-center-suggestion/list") &&
        req.url().includes("prefix="),
      { timeout: 10_000 },
    )

    await page
      .locator('[data-testid="voucher-line-cost-center-0"]')
      .fill("VER")

    const req = await promise
    // The URL should contain "prefix=VER".
    expect(req.url()).toContain("prefix=VER")

    // Allow the response to land + state to settle.
    await page.waitForResponse((r) =>
      r
        .url()
        .includes("/api/v1/accounting/vouchers/cost-center-suggestion/list"),
    )

    // The datalist should render ≥1 option for the
    // VERT-prefixed query (BK-HIST-001 has VERTRIEB
    // stamps on Sachkonto 4960).
    await page.waitForTimeout(300)
    const options = page.locator('[data-testid="tier49-cc-option"]')
    const optCount = await options.count()
    expect(optCount).toBeGreaterThanOrEqual(1)
  })

  test("datalist options include the count badge", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    await page.goto("/dashboard/accounting", {
      waitUntil: "domcontentloaded",
    })
    // Same hydration wait as test 1.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)

    await page.locator('[data-testid="accounting-new-voucher"]').click()
    await expect(
      page.locator('[data-testid="voucher-line-cost-center-0"]'),
    ).toBeVisible({ timeout: 10_000 })

    // Pick an account that has stamps — same logic
    // as test 1.
    const accountSelect = page
      .locator('[data-testid="voucher-line-cost-center-0"]')
      .locator("xpath=ancestor::tr")
      .locator("select")
      .first()
    const optionValues: string[] = await accountSelect
      .locator("option")
      .evaluateAll((els) =>
        (els as HTMLOptionElement[]).map((e) => e.value),
      )
    const realValues = optionValues.filter((v) => v && v.length > 0)
    // Tier 369: was a test.skip(). ci-seed creates the default SKR03 accounts
    // (1000/1200/1400/…), so an empty account select means the seed or the page
    // failed — not a reason to report green.
    expect(
      realValues.length,
      "the account select must offer the seeded accounts",
    ).toBeGreaterThan(0)

    let picked = false
    for (const accId of realValues) {
      await accountSelect.selectOption(accId)
      const firstListCall = await page
        .waitForResponse(
          (r) =>
            r
              .url()
              .includes(
                "/api/v1/accounting/vouchers/cost-center-suggestion/list",
              ),
          { timeout: 5_000 },
        )
        .catch(() => null)
      if (!firstListCall) continue
      const items = await firstListCall.json().catch(() => null)
      if (items && Array.isArray(items.items) && items.items.length > 0) {
        picked = true
        break
      }
    }
    // Tier 369: was a test.skip(). ci-seed.sh stamps a VoucherLine with
    // costCenter='VERTRIEB' on account 4960, so at least one account does have
    // a suggestion. If the loop finds none, either the suggestion API or the
    // seed is broken — and every datalist assertion below would be vacuous.
    expect(
      picked,
      "at least one seeded account must have a cost-center suggestion",
    ).toBe(true)

    // Allow React to flush.
    await page.waitForTimeout(300)

    // The datalist should have at least one option
    // with a count badge (the format is "<cc> (Nx)"
    // or "<cc> · <co> (Nx)" when costObject is set).
    const options = page.locator('[data-testid="tier49-cc-option"]')
    const firstOpt = await options.first().textContent()
    expect(firstOpt || "").toMatch(/\(\d+×\)/)
  })
})