import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 67: Audit-Trail UI (GoBD § 147 AO).
 *
 * The /dashboard/audit page is the read-only
 * "Wer hat wann was geändert?" view over the
 * AuditLog table. This spec covers the UI:
 *
 *   1. Page loads, shows stats cards, list table.
 *   2. Filters narrow the list (entityType, action,
 *      date range).
 *   3. Clicking a row opens the diff modal with
 *      oldData / newData JSON.
 *   4. CSV export button triggers a download.
 *
 * Backend e2e 94 covers the API contract for
 * each endpoint.
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

test.describe("Audit-Trail UI", () => {
  test("page loads, shows stats + table", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/audit")

    // The stats card has the total-actions label.
    await expect(page.getByTestId("audit-stat-total")).toBeVisible({
      timeout: 30_000,
    })
    // The table renders at least one row.
    await expect(page.getByTestId("audit-table")).toBeVisible()
    const rows = page.getByTestId("audit-row")
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })
  })

  test("filter by entityType narrows the list", async ({ page }) => {
    await injectAuth(page)
    await page.goto("/dashboard/audit")
    await expect(page.getByTestId("audit-table")).toBeVisible({
      timeout: 30_000,
    })

    // Read the total before filtering.
    const totalText = await page.getByTestId("audit-total").textContent()
    const totalBefore = parseInt((totalText || "0").replace(/[^\d]/g, ""), 10)

    // Apply the Invoice filter.
    await page.getByTestId("audit-filter-entityType").selectOption("Invoice")
    // Give the network request a moment to land.
    await page.waitForTimeout(1_000)
    const totalTextAfter = await page.getByTestId("audit-total").textContent()
    const totalAfter = parseInt(
      (totalTextAfter || "0").replace(/[^\d]/g, ""),
      10,
    )
    // Invoice-specific count must be ≤ unfiltered.
    expect(
      totalAfter,
      `Invoice total (${totalAfter}) should be ≤ unfiltered (${totalBefore})`,
    ).toBeLessThanOrEqual(totalBefore)
    // Every visible row must say "Invoice" in the
    // entityType column (3rd column, 0-indexed 2).
    const rows = page.getByTestId("audit-row")
    const count = await rows.count()
    for (let i = 0; i < Math.min(count, 5); i++) {
      const rowText = await rows.nth(i).textContent()
      expect(rowText, `row ${i}`).toContain("Invoice")
    }
  })

  test("clicking a row opens the diff modal with oldData + newData", async ({
    page,
  }) => {
    await injectAuth(page)
    // Throttler backoff: the previous tests in the
    // suite already spent some of the 600/60s
    // budget. Retry the goto + table-wait up to 3
    // times on any transient failure.
    let tableReady = false
    for (let attempt = 0; attempt < 3 && !tableReady; attempt++) {
      if (attempt > 0) {
        await page.waitForTimeout(3_000)
        await page.goto("/dashboard/audit", { waitUntil: "domcontentloaded" })
      } else {
        await page.goto("/dashboard/audit")
      }
      try {
        await expect(page.getByTestId("audit-table")).toBeVisible({
          timeout: 25_000,
        })
        tableReady = true
      } catch (e) {
        if (attempt === 2) throw e
      }
    }
    // Capture a stable ID for the first row, then
    // click via that selector. The row's
    // `data-audit-id` is unique to the row, so even
    // if the table re-renders we re-resolve to the
    // same logical row.
    const firstRowId = await page
      .getByTestId("audit-row")
      .first()
      .getAttribute("data-audit-id")
    expect(firstRowId, "first row has data-audit-id").toBeTruthy()
    const stableRow = page.locator(
      `[data-testid="audit-row"][data-audit-id="${firstRowId}"]`,
    )
    await expect(stableRow).toBeVisible({ timeout: 10_000 })
    // dispatchEvent fires the synthetic click without
    // actionability checks — the table re-renders
    // when the next /audit-logs fetch lands, which
    // races with a real .click() in suite context.
    // Same fix as tier 63 dashboard widget.
    await stableRow.dispatchEvent("click")
    // The detail modal fetches the row's full body
    // and mounts on success. Wait for it.
    await expect(page.getByTestId("audit-detail-modal")).toBeVisible({
      timeout: 15_000,
    })
    // Either oldData or newData must render (real
    // changes always have one; deletions have only
    // oldData).
    const oldData = page.getByTestId("audit-old-data")
    const newData = page.getByTestId("audit-new-data")
    await expect(oldData).toBeVisible()
    await expect(newData).toBeVisible()
    // Close the modal.
    await page.getByTestId("audit-detail-close").click()
    await expect(page.getByTestId("audit-detail-modal")).toHaveCount(0)
  })

  test("CSV export button triggers a download", async ({ page }) => {
    await injectAuth(page)
    // Throttler backoff: the previous tests already
    // spent some of the 600/60s budget. Retry the
    // initial GET up to 3 times on a 429 (or any
    // other transient failure that makes the table
    // not render in time).
    let tableVisible = false
    for (let attempt = 0; attempt < 3 && !tableVisible; attempt++) {
      if (attempt > 0) {
        await page.waitForTimeout(5_000)
        await page.goto("/dashboard/audit", { waitUntil: "domcontentloaded" })
      } else {
        await page.goto("/dashboard/audit")
      }
      try {
        await expect(page.getByTestId("audit-table")).toBeVisible({
          timeout: 30_000,
        })
        tableVisible = true
      } catch (e) {
        if (attempt === 2) throw e
      }
    }
    // Listen for the download.
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 })
    await page.getByTestId("audit-export-csv").click()
    const download = await downloadPromise
    // The filename starts with "audit-log-".
    expect(download.suggestedFilename()).toMatch(/^audit-log-/)
  })
})
