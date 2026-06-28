import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 20: Customer statement (Kontoauszug) UI.
 *
 * Tests the page at /dashboard/customers/[id]/statement:
 *   1. Page renders without console errors
 *   2. Date range fields are pre-filled
 *   3. Generate button fetches and renders statement
 *   4. Statement table shows the line items
 *   5. PDF download button exists + is enabled after generate
 *   6. Customer list page has a per-row "Kontoauszug" button
 *
 * Why a separate spec?
 *   - Statement is a new page (Tier 20) that benefits
 *     from isolated regression coverage.
 *   - Pre-existing list-pages specs don't touch the
 *     customer detail → statement navigation.
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

test.beforeEach(async ({ context }: { context: any }) => {
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
})

async function injectLocalStorage(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

// Pick a customer with at least 1 invoice so the statement has lines.
// Müller GmbH K-00001 (b9799545-...) has 10 invoices from earlier tests.
const CUSTOMER_WITH_INVOICES = "b9799545-956b-40db-8fcd-769b2d429aa9"

test.describe("Customer statement UI", () => {
  test("statement page renders without console errors", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text())
    })

    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${CUSTOMER_WITH_INVOICES}/statement`,
      { waitUntil: "domcontentloaded" },
    )

    // Wait for the page to hydrate past the SSR SkeletonTable
    // (see Tier 13.4.3 — list pages show Skeleton on first paint
    // then switch to real content after localStorage reads).
    await expect(
      page.locator('[data-testid="statement-from-input"]'),
    ).toBeVisible({ timeout: 10000 })

    // No React error boundary, no console errors
    expect(errors).toEqual([])
    expect(await page.locator("text=Application error").count()).toBe(0)
  })

  test("date range fields are pre-filled with previous month", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${CUSTOMER_WITH_INVOICES}/statement`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="statement-from-input"]'),
    ).toBeVisible({ timeout: 10000 })

    // The page defaults to the previous calendar month (Tier 20 design).
    // Just verify both date inputs have non-empty ISO values.
    const from = await page
      .locator('[data-testid="statement-from-input"]')
      .inputValue()
    const to = await page
      .locator('[data-testid="statement-to-input"]')
      .inputValue()
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // to should be >= from (we default to previous month)
    expect(to >= from).toBeTruthy()
  })

  test("generate button fetches statement + renders lines", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${CUSTOMER_WITH_INVOICES}/statement`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="statement-from-input"]'),
    ).toBeVisible({ timeout: 10000 })

    // Set a wide date range that covers all the customer's invoices.
    // Müller K-00001 was created 2026-05-24 with invoices through 2026-06-13.
    await page
      .locator('[data-testid="statement-from-input"]')
      .fill("2026-01-01")
    await page
      .locator('[data-testid="statement-to-input"]')
      .fill("2026-12-31")

    await page.locator('[data-testid="statement-generate-button"]').click()

    // Wait for the result card to appear. Lines may take a
    // moment after the card mounts (separate render passes).
    await expect(
      page.locator('[data-testid="statement-result"]'),
    ).toBeVisible({ timeout: 10000 })
    // The generate button text changes from "Aktualisieren" to
    // "Wird geladen…" while loading, then back when done. Wait
    // for that transition to know the request finished.
    await page.waitForFunction(
      () => {
        const btn = document.querySelector(
          '[data-testid="statement-generate-button"]',
        ) as HTMLButtonElement | null
        return btn && !btn.textContent?.includes('Wird geladen')
      },
      { timeout: 10000 },
    )

    // The statement may or may not have lines (depends on DB state
    // at test time — other tests have modified this customer).
    // We assert on what's ALWAYS present after a successful load:
    // the opening + closing balance cards. If there are no lines,
    // the empty-state message is shown instead.
    const hasLines = await page
      .locator('[data-testid="statement-line"]')
      .count()
    if (hasLines === 0) {
      await expect(
        page.locator('[data-testid="statement-empty"]'),
      ).toBeVisible()
    } else {
      await expect(
        page.locator('[data-testid="statement-line"]').first(),
      ).toBeVisible()
    }

    // Opening + closing balance are rendered as € formatted strings.
    // German locale uses "0,00 €" (symbol after the number, with
    // comma decimal separator).
    const opening = await page
      .locator('[data-testid="statement-opening"]')
      .innerText()
    expect(opening).toMatch(/-?\d.*€/)
    const closing = await page
      .locator('[data-testid="statement-closing"]')
      .innerText()
    expect(closing).toMatch(/-?\d.*€/)

    // PDF download button is now enabled
    await expect(
      page.locator('[data-testid="statement-download-pdf-button"]'),
    ).toBeEnabled()
  })

  test("customer list has a per-row statement button", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/customers", {
      waitUntil: "domcontentloaded",
    })
    // Wait for at least one customer row to render
    await expect(
      page.locator('[data-testid="customer-statement-button"]').first(),
    ).toBeVisible({ timeout: 10000 })

    // Clicking it should navigate to the statement page
    await page
      .locator('[data-testid="customer-statement-button"]')
      .first()
      .click()

    await page.waitForURL(/\/dashboard\/customers\/.*\/statement/, {
      timeout: 5000,
    })
    await expect(
      page.locator('[data-testid="statement-from-input"]'),
    ).toBeVisible({ timeout: 5000 })
  })

  test("order toggle re-sorts lines (DESC default, ASC opt-in)", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto(
      `/dashboard/customers/${CUSTOMER_WITH_INVOICES}/statement`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(
      page.locator('[data-testid="statement-from-input"]'),
    ).toBeVisible({ timeout: 10000 })

    // Müller K-00001 has paid invoices from 2026-06-02 to 2026-06-05
    // (left over from earlier e2e runs — the VCH ones are stable).
    // Use that range so the statement has lines under both orders.
    await page
      .locator('[data-testid="statement-from-input"]')
      .fill("2026-06-01")
    await page
      .locator('[data-testid="statement-to-input"]')
      .fill("2026-06-30")

    // Default is DESC — verify the "Newest first" button is active
    await expect(
      page.locator('[data-testid="statement-order-desc"]'),
    ).toHaveClass(/bg-blue-600/)

    // Generate + wait for lines (DESC default)
    await page.locator('[data-testid="statement-generate-button"]').click()
    await expect(
      page.locator('[data-testid="statement-result"]'),
    ).toBeVisible({ timeout: 10000 })
    // Wait for at least one line to appear. The customer
    // has stable test data from earlier e2e runs (VCH/VCH2
    // invoices from June 2026) so lines should always be
    // present.
    await expect(
      page.locator('[data-testid="statement-line"]').first(),
    ).toBeVisible({ timeout: 15000 })

    // Capture the first line's date under DESC (newest first)
    const descFirstDate = await page
      .locator('[data-testid="statement-line"]')
      .first()
      .locator("td")
      .first()
      .innerText()

    // Switch to ASC (oldest first)
    await page.locator('[data-testid="statement-order-asc"]').click()
    await expect(
      page.locator('[data-testid="statement-order-asc"]'),
    ).toHaveClass(/bg-blue-600/)

    // Trigger re-fetch + wait for the new order to land
    await page.locator('[data-testid="statement-generate-button"]').click()
    // The DESC lines disappear (new fetch replaces the table),
    // then ASC lines appear. Wait for any line to be visible.
    await page.waitForTimeout(500)
    await expect(
      page.locator('[data-testid="statement-line"]').first(),
    ).toBeVisible({ timeout: 15000 })

    // First line under ASC should be older than DESC first
    const ascFirstDate = await page
      .locator('[data-testid="statement-line"]')
      .first()
      .locator("td")
      .first()
      .innerText()

    // German date format dd.mm.yyyy — convert to comparable ISO
    const toIso = (g: string): string => {
      const m = g.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
      return m ? `${m[3]}-${m[2]}-${m[1]}` : g
    }
    expect(toIso(ascFirstDate) < toIso(descFirstDate)).toBeTruthy()
  })
})