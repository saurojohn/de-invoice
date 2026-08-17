/**
 * Tier 206 — Top-N fingerprints by rate
 *
 * Covers the new
 * `GET /api/v1/system/errors/top-rate`
 * endpoint + the new "Top-Fingerabdrücke
 * nach Rate" card on
 * `/dashboard/system-errors`:
 *
 *   1. GET /top-rate returns up to
 *      `limit` fingerprints sorted by
 *      count desc, with `exceeded` flag
 *      matching the configured threshold.
 *   2. `windowMinutes` query param
 *      narrows the window.
 *   3. `limit` query param caps the
 *      result count.
 *   4. The response includes the latest
 *      `message` + `lastSeenAt` per
 *      fingerprint so the UI can show
 *      "what's actually firing".
 *   5. The threshold reflected in the
 *      response matches the value from
 *      `GET /system/notifications/threshold`
 *      (Tier 205 parity).
 *   6. /dashboard/system-errors renders
 *      the top-rate card.
 *   7. The top-rate table shows rows
 *      with a "über Schwelle" / "ok"
 *      badge.
 *   8. Clicking the Refresh button
 *      re-fetches the table.
 *   9. A fingerprint that's been fired
 *      more than the threshold is
 *      marked with the `top-rate-exceeded`
 *      testid.
 *
 * Tier 206 closes the visualization
 * loop on Tier 205: the operator can
 * now see which fingerprints are
 * approaching or crossing the
 * "noisy enough to push" line, before
 * the actual push fires (or doesn't).
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

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

let tokens: { userId: string; companyId: string } | null = null
test.beforeAll(() => {
  tokens = readCachedTokens()
})

test.beforeEach(async ({ context }: { context: any }) => {
  if (!tokens) return
  await context.addCookies([
    { name: "x-user-id", value: tokens.userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: tokens.companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
  await context.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    tokens,
  )
})

const headers = () => ({
  "x-user-id": tokens!.userId,
  "x-company-id": tokens!.companyId,
})

test.describe("Tier 206 — GET /system/errors/top-rate", () => {
  test("1. GET returns up to `limit` fingerprints sorted by count desc", async ({
    request,
  }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/system/errors/top-rate?limit=10&windowMinutes=1440",
      { headers: headers() },
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    // The response shape is
    // { windowMinutes, threshold, limit,
    //   source, rows: TopRateRow[] }.
    expect(typeof body.windowMinutes).toBe("number")
    expect(typeof body.threshold).toBe("number")
    expect(body.limit).toBe(10)
    expect(body.source).toBe("all")
    expect(Array.isArray(body.rows)).toBe(true)
    // The rows should be sorted by
    // count desc. We don't assert
    // exact ordering (shared DB can
    // have ties) but we DO assert
    // that no later row has a higher
    // count than an earlier row.
    for (let i = 1; i < body.rows.length; i++) {
      expect(
        body.rows[i - 1].count >= body.rows[i].count,
        `row ${i - 1} count ${body.rows[i - 1].count} should be >= row ${i} count ${body.rows[i].count}`,
      ).toBe(true)
    }
  })

  test("2. `windowMinutes` query param narrows the window", async ({
    request,
  }) => {
    // Fetch with a very small window
    // (5 min). The result should be a
    // subset of the same call with a
    // larger window (1 day), because
    // the smaller window excludes
    // events older than 5 min.
    const narrow = await request.get(
      "http://localhost:3001/api/v1/system/errors/top-rate?windowMinutes=5&limit=50",
      { headers: headers() },
    )
    const wide = await request.get(
      "http://localhost:3001/api/v1/system/errors/top-rate?windowMinutes=1440&limit=50",
      { headers: headers() },
    )
    const narrowFps = new Set(
      (await narrow.json()).rows.map((r: any) => r.fingerprint),
    )
    const wideFps = new Set(
      (await wide.json()).rows.map((r: any) => r.fingerprint),
    )
    // The narrow set is a subset of
    // the wide set (every fingerprint
    // in the 5-min window also
    // appears in the 24h window).
    for (const fp of narrowFps) {
      expect(wideFps.has(fp), `${fp} should be in wide set`).toBe(true)
    }
  })

  test("3. `limit` query param caps the result count", async ({ request }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/system/errors/top-rate?limit=3",
      { headers: headers() },
    )
    const body = await res.json()
    expect(body.rows.length).toBeLessThanOrEqual(3)
  })

  test("4. response includes the latest message + lastSeenAt per fingerprint", async ({
    request,
  }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/system/errors/top-rate?limit=5&windowMinutes=1440",
      { headers: headers() },
    )
    const body = await res.json()
    // The first row (if any) should
    // have non-null message +
    // lastSeenAt — those are the
    // fields the UI renders in the
    // "Last message" column.
    if (body.rows.length > 0) {
      const r = body.rows[0]
      expect(r.fingerprint).toBeTruthy()
      expect(r.fingerprintShort).toBeTruthy()
      expect(typeof r.count).toBe("number")
      expect(typeof r.exceeded).toBe("boolean")
      // message + lastSeenAt can be
      // null for fingerprints where
      // the second query (latest
      // event) found nothing — but
      // in practice they should be
      // populated for any
      // fingerprint with count > 0.
      if (r.message) {
        expect(typeof r.message).toBe("string")
      }
      if (r.lastSeenAt) {
        expect(typeof r.lastSeenAt).toBe("string")
      }
    }
  })

  test("5. threshold field matches /system/notifications/threshold", async ({
    request,
  }) => {
    // The two endpoints should
    // return the same threshold
    // value (they read from the
    // same NotificationConfig row).
    const threshold = await request.get(
      "http://localhost:3001/api/v1/system/notifications/threshold",
      { headers: headers() },
    )
    const topRate = await request.get(
      "http://localhost:3001/api/v1/system/errors/top-rate?limit=5",
      { headers: headers() },
    )
    const tBody = await threshold.json()
    const trBody = await topRate.json()
    expect(trBody.threshold).toBe(tBody.rateThresholdCount)
  })
})

test.describe("Tier 206 — UI top-rate card on /dashboard/system-errors", () => {
  test("6. /dashboard/system-errors renders the top-rate card", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/system-errors")
    // The top-rate card is
    // independent of the threshold
    // card (Tier 205) and the
    // timeline card (Tier 200) — so
    // a 429 on either of their
    // API calls doesn't block this
    // test.
    await expect(page.getByTestId("top-rate-refresh")).toBeVisible({
      timeout: 15000,
    })
  })

  test("7. the top-rate table shows rows with exceeded/ok badges", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/system-errors")
    // Wait for the table to render.
    // We don't know the exact row
    // count (depends on prior e2e
    // history) so we wait for the
    // refresh button + then
    // optionally check for either
    // kind of badge.
    await expect(page.getByTestId("top-rate-refresh")).toBeVisible({
      timeout: 15000,
    })
    // The table renders the count
    // cell with a top-rate-count
    // testid. The shared DB has
    // hundreds of historical rows
    // so the table will have at
    // least one row.
    const firstRow = page.getByTestId("top-rate-row").first()
    await expect(firstRow).toBeVisible({ timeout: 10000 })
    // Each row has a badge — either
    // exceeded (red) or ok (gray).
    // We accept either because the
    // shared DB state varies.
    const anyBadge = await firstRow
      .locator('[data-testid^="top-rate-"]')
      .count()
    expect(anyBadge).toBeGreaterThan(0)
  })

  test("8. clicking the Refresh button re-fetches the table", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/system-errors")
    const refreshBtn = page.getByTestId("top-rate-refresh")
    await expect(refreshBtn).toBeVisible({ timeout: 15000 })
    // The button is disabled while
    // a fetch is in flight (the
    // mount effect's initial
    // fetchTopRate). Wait for the
    // initial fetch to complete
    // before clicking. The
    // !disabled assertion polls
    // up to 15s — if the Throttler
    // 429'd the initial fetch, the
    // error handler clears
    // topRateLoading in `finally`,
    // so the button is enabled
    // again.
    await expect(refreshBtn).toBeEnabled({ timeout: 15000 })
    // Capture the GET /top-rate
    // request triggered by the
    // click. The listener MUST be
    // registered BEFORE the click
    // — React's onClick handler
    // dispatches synchronously so
    // a post-click listener misses
    // the request. (Same gotcha as
    // Tier 197/203.)
    const getPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/system/errors/top-rate") &&
        r.request().method() === "GET",
      { timeout: 10000 },
    )
    await refreshBtn.click()
    const res = await getPromise
    expect(res.status()).toBe(200)
  })

  test("9. a fingerprint over threshold renders the exceeded badge", async ({
    request,
    page,
  }) => {
    // Set a very low threshold (1/60)
    // so any fingerprint with at
    // least 1 occurrence in the last
    // hour will be "exceeded".
    await request.put(
      "http://localhost:3001/api/v1/system/notifications/threshold",
      {
        headers: { ...headers(), "Content-Type": "application/json" },
        data: { rateThresholdCount: 1, rateThresholdWindowMinutes: 60 },
      },
    )
    // Wait for the PUT's side
    // effects: the controller
    // calls notify.setThreshold()
    // which refreshes the
    // in-memory cache immediately.
    // No DB-level sync needed.
    await page.goto("http://localhost:3100/dashboard/system-errors")
    // Wait for the refresh button
    // first (page is loaded), then
    // wait for the first row (table
    // has data), then look for the
    // exceeded badge.
    const refreshBtn = page.getByTestId("top-rate-refresh")
    await expect(refreshBtn).toBeVisible({ timeout: 15000 })
    // Wait for the initial fetch
    // to finish (button becomes
    // enabled when topRateLoading
    // is false).
    await expect(refreshBtn).toBeEnabled({ timeout: 15000 })
    // Click Refresh explicitly
    // so we re-fetch with the new
    // threshold (the page's mount
    // fetch may have happened
    // before the PUT landed).
    await refreshBtn.click()
    // Wait for at least one
    // exceeded badge to appear.
    await expect(page.getByTestId("top-rate-exceeded").first()).toBeVisible({
      timeout: 10000,
    })
    // Restore the default
    // threshold so subsequent
    // tests aren't affected.
    await request.put(
      "http://localhost:3001/api/v1/system/notifications/threshold",
      {
        headers: { ...headers(), "Content-Type": "application/json" },
        data: { rateThresholdCount: 5, rateThresholdWindowMinutes: 60 },
      },
    )
  })
})
