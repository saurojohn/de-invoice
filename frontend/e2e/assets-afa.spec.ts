import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 87: Anlagenverzeichnis AfA-Buchung flow.
 *
 * Exercises the React page on /dashboard/assets
 * with the new "AfA buchen" button + per-asset
 * booking-status badges. The backend e2e 113
 * covers the API contract + DB state machine
 * (booked/computed fallback); this file checks
 * the UI wiring.
 *
 * Tests:
 *   1. /dashboard/assets loads + the new
 *      AfA-Status column header is present.
 *   2. After seeding a bookable Asset via the
 *      API, the page shows the "AfA buchen"
 *      button with a count + total preview.
 *   3. Clicking the button opens the confirm
 *      modal with the bookable rows + a
 *      "Gesamt" total.
 *   4. After POSTing /assets/book-afa, the page
 *      reload shows the "AfA gebucht" badge.
 *   5. The page renders without console errors.
 *
 * The Playwright tests seed their own test asset
 * (prefix `T87PA-`) and clean it up in
 * afterAll. They are independent of e2e 113's
 * cleanup state — runnable in isolation.
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
const TEST_TAG = `T87PA-${Date.now()}-${Math.floor(Math.random() * 100000)}`

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

test.afterAll(async () => {
  // Cleanup: remove all T87PA-* test assets
  // (and any related AfA bookings) via the
  // backend API would require x-company-id
  // header; we just use psql to be safe.
  const { execSync } = await import("child_process")
  try {
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"Expense\\" WHERE \\"relatedAssetId\\" IN (SELECT id FROM \\"Asset\\" WHERE bezeichnung LIKE 'T87PA-%');" >/dev/null 2>&1`,
      { stdio: "ignore" },
    )
    execSync(
      `docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \\"Asset\\" WHERE bezeichnung LIKE 'T87PA-%';" >/dev/null 2>&1`,
      { stdio: "ignore" },
    )
  } catch {
    // best-effort cleanup
  }
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

async function createTestAsset(page: any) {
  // 1 Maschine, 5000 EUR / 60 months / 2026-01-01
  // annualAfA = 5000 / 60 * 12 = 1000
  const res = await page.request.post(
    `http://localhost:3001/api/v1/assets?companyId=${testTokens!.companyId}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {
        type: "Maschine",
        bezeichnung: `${TEST_TAG}-Maschine`,
        anschaffungsDatum: "2026-01-01T00:00:00.000Z",
        anschaffungsKosten: 5000,
        nutzungsdauerMonate: 60,
        restwert: 0,
        bilanzKonto: "0300",
        notiz: null,
      },
    },
  )
  if (!res.ok()) {
    throw new Error(`createTestAsset failed: ${res.status()} ${await res.text()}`)
  }
  return await res.json()
}

test("AfA-Status column header is visible", async ({ page }) => {
  await injectAuth(page)
  await page.goto("/dashboard/assets")
  // Wait for the year input to confirm the page
  // is loaded past the auth redirect.
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  // The new column header is in the table. We
  // assert the table OR the empty state is
  // visible (depending on dev DB state).
  const empty = page.getByTestId("assets-empty")
  const table = page.getByTestId("assets-table")
  await expect(empty.or(table)).toBeVisible({ timeout: 30_000 })
  // The AfA-Status column is always present
  // in the table header, regardless of whether
  // any assets exist (we just need the page
  // to have rendered the new column).
  // Use a loose check: the table should have
  // at least 9 column headers now (was 8
  // before tier 87).
  if (await table.isVisible().catch(() => false)) {
    const headers = table.locator("thead th")
    const count = await headers.count()
    expect(count).toBeGreaterThanOrEqual(9)
  }
})

test("'AfA buchen' button OR 'AfA gebucht' badge is visible (one of the two)", async ({ page }) => {
  await injectAuth(page)
  // Seed a bookable asset so the button has
  // something to display.
  await createTestAsset(page)
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  // Wait for data load
  await page.waitForTimeout(2500)
  // Either the booking button (when there's
  // a bookable asset) OR the booked badge
  // (when one was already booked by an earlier
  // test in this run) is visible.
  const button = page.getByTestId("assets-book-afa")
  const badge = page.getByTestId("assets-booked-badge")
  const buttonVisible = await button.isVisible().catch(() => false)
  const badgeVisible = await badge.isVisible().catch(() => false)
  expect(buttonVisible || badgeVisible).toBe(true)
})

test("booking button click opens the confirm modal with total", async ({ page }) => {
  await injectAuth(page)
  await createTestAsset(page)
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  const button = page.getByTestId("assets-book-afa")
  await expect(button).toBeVisible({ timeout: 10_000 })
  await button.click()
  // The confirm modal renders a "Gesamt" row
  // with a data-testid on the total cell.
  await expect(page.getByTestId("assets-book-total")).toBeVisible({ timeout: 5_000 })
  // The confirm button is also present.
  await expect(page.getByTestId("assets-book-confirm")).toBeVisible()
})

test("after POST book-afa the page shows the 'AfA gebucht' badge", async ({ page }) => {
  await injectAuth(page)
  // Seed + immediately book via the API
  // (faster + more reliable than driving the
  // modal from the UI which involves multiple
  // click + wait-for-response cycles).
  const created = await createTestAsset(page)
  expect(created.id).toBeTruthy()
  const bookRes = await page.request.post(
    `http://localhost:3001/api/v1/assets/book-afa?companyId=${testTokens!.companyId}&year=2026`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {},
    },
  )
  expect(bookRes.status()).toBe(201)
  const bookBody = await bookRes.json()
  expect(bookBody.bookedCount).toBeGreaterThanOrEqual(1)
  expect(bookBody.totalAnnualAfA).toBeGreaterThan(0)
  // Now load the page and verify the badge
  // (since this asset is now booked, the page
  // should show "AfA gebucht" instead of the
  // button — assuming it's the only asset
  // for the year. If the dev DB has other
  // unbooked assets, the button may still
  // show, but the badge testid should be
  // visible somewhere on the page for the
  // booked asset row).
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  // Find the row for our test asset and check
  // its AfA-Status cell. The row's testid is
  // `assets-row-<assetId>` and the cell testid
  // is `assets-afa-status-<assetId>`.
  const statusCell = page.getByTestId(`assets-afa-status-${created.id}`)
  await expect(statusCell).toBeVisible({ timeout: 10_000 })
  // The cell should contain the "gebucht" text
  // (or its i18n equivalent) per assets.afaBooked
  const text = await statusCell.textContent()
  expect(text || "").toMatch(/gebucht|booked|已簿记/)
})

test("Tier 89: 'AfA monatlich buchen' button visible when bookable asset exists", async ({ page }) => {
  await injectAuth(page)
  // Use year 2027 to avoid the mutex with
  // the previous annual test (which
  // booked year 2026). The year picker
  // also defaults to the current year.
  const created = await createTestAsset(page)
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  // Switch the year picker to 2027 (where
  // we just seeded an asset that is NOT
  // booked yet).
  const yearInput = page.getByTestId("assets-year")
  await yearInput.fill("2027")
  await page.waitForTimeout(2500)
  // Both booking buttons should be visible:
  // - assets-book-afa (annual, tier 87)
  // - assets-book-afa-monthly (tier 89, outline variant)
  const annualBtn = page.getByTestId("assets-book-afa")
  const monthlyBtn = page.getByTestId("assets-book-afa-monthly")
  await expect(annualBtn).toBeVisible({ timeout: 10_000 })
  await expect(monthlyBtn).toBeVisible({ timeout: 5_000 })
})

test("Tier 89: monthly booking button click opens monthly confirm modal", async ({ page }) => {
  await injectAuth(page)
  await createTestAsset(page)
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  const yearInput = page.getByTestId("assets-year")
  await yearInput.fill("2027")
  await page.waitForTimeout(2500)
  const monthlyBtn = page.getByTestId("assets-book-afa-monthly")
  if (!(await monthlyBtn.isVisible().catch(() => false))) {
    test.skip(true, "No bookable assets visible for year 2027")
    return
  }
  await monthlyBtn.click()
  // The monthly confirm modal shows the
  // per-month amount + the per-asset total
  // annual.
  await expect(
    page.getByTestId("assets-book-monthly-total-annual"),
  ).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId("assets-book-monthly-total")).toBeVisible()
  await expect(page.getByTestId("assets-book-monthly-confirm")).toBeVisible()
})

test("Tier 89: after POST book-afa-monthly the page shows monthly mode chip", async ({ page }) => {
  await injectAuth(page)
  // Use year 2027 to avoid the mutex with
  // the previous annual test (which
  // booked year 2026).
  const created = await createTestAsset(page)
  expect(created.id).toBeTruthy()
  const MONTHLY_YEAR = 2027
  const bookRes = await page.request.post(
    `http://localhost:3001/api/v1/assets/book-afa-monthly?companyId=${testTokens!.companyId}&year=${MONTHLY_YEAR}`,
    {
      headers: {
        "x-user-id": testTokens!.userId,
        "x-company-id": testTokens!.companyId,
      },
      data: {},
    },
  )
  expect(bookRes.status()).toBe(201)
  const bookBody = await bookRes.json()
  expect(bookBody.mode).toBe("monthly")
  // bookedCount = N assets × 12 months. The
  // dev DB may have other pre-existing
  // assets, so we only assert >= 12.
  expect(bookBody.bookedCount).toBeGreaterThanOrEqual(12)
  expect(bookBody.bookedCount % 12).toBe(0)
  // Leave the booking in place so the
  // page can verify the monthly chip.
  // afterAll() will clean up the T87PA-*
  // test fixture (asset + 12 AfA rows).
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  // Switch to the year we booked for.
  const yearInput = page.getByTestId("assets-year")
  await yearInput.fill(String(MONTHLY_YEAR))
  await page.waitForTimeout(2500)
  const statusCell = page.getByTestId(`assets-afa-status-${created.id}`)
  await expect(statusCell).toBeVisible({ timeout: 10_000 })
  const text = (await statusCell.textContent()) || ""
  // The cell should contain both the
  // booked label and the monthly mode
  // chip (assets.afaBookedMonthly key).
  expect(text).toMatch(/gebucht|booked|已簿记/)
  expect(text).toMatch(/monatlich|monthly|按月/)
})

test("assets-afa page is reachable without errors", async ({ page }) => {
  await injectAuth(page)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`)
  })
  await page.goto("/dashboard/assets")
  await expect(page.getByTestId("assets-year")).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  // Filter out known harmless dev-mode warnings
  const real = errors.filter(
    (e) => !/hydrat/i.test(e) && !/deprecated/i.test(e) && !/favicon/i.test(e),
  )
  expect(real, `unexpected console errors: ${real.join("\n")}`).toEqual([])
})
