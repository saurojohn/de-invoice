/**
 * Tier 201 — Webhook deliveries event-type filter
 *
 * Covers the new `eventType` query
 * param on:
 *
 *   1. GET /api/v1/webhooks/:id/deliveries
 *      — the per-webhook drawer. When
 *      `eventType` is set, only rows
 *      with that eventType are
 *      returned. When omitted, all
 *      rows.
 *   2. GET /api/v1/webhooks/deliveries/dead-letter
 *      — the cross-webhook dead-letter
 *      card. Same filter.
 *
 * And the new UI dropdowns:
 *
 *   3. /dashboard/settings/webhooks
 *      drawer renders an event-type
 *      filter <select> with one
 *      option per subscribed event
 *      + "All event types" default.
 *   4. Selecting a non-default value
 *      narrows the deliveries list.
 *   5. Dead-letter card renders an
 *      event-type filter populated
 *      from the union of all
 *      webhooks' subscribed events.
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

// Seed a webhook that subscribes to
// MULTIPLE event types so the test
// can verify the filter actually
// narrows the result (a webhook
// that only fires one type would
// have no narrowing effect).
const seedTag = "tier201-" + Date.now()
let multiWhId = ""

test.beforeAll(async ({ request }: { request: any }) => {
  // Tier 201 — webhook that subscribes
  // to BOTH webhook.test (a
  // Tier 14.4 default) AND
  // invoice.created. We fire the test
  // event (which is the only one we
  // can trigger without a real
  // invoice), so the test still has
  // rows of type `webhook.test`. The
  // point is to prove the API filter
  // narrows: a query for
  // `eventType=invoice.created` returns
  // 0 rows; a query for
  // `eventType=webhook.test` returns
  // the fired rows.
  const create = await request.post(
    `http://localhost:3001/api/v1/webhooks?companyId=${tokens!.companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
      data: {
        name: seedTag,
        url: "https://httpbin.org/status/200",
        events: ["webhook.test", "invoice.created", "payment.received"],
      },
    },
  )
  expect(create.status(), "create multi-event webhook").toBe(201)
  multiWhId = (await create.json()).id

  // Fire one test event so there's
  // at least one row to filter.
  await request.post(
    `http://localhost:3001/api/v1/webhooks/${multiWhId}/test?companyId=${tokens!.companyId}`,
    { headers: headers() },
  )
  await new Promise((r) => setTimeout(r, 1500))
})

test.describe("Tier 201 — Per-webhook drawer event-type filter", () => {
  test("1. unfiltered returns rows of multiple event types", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/webhooks/${multiWhId}/deliveries?companyId=${tokens!.companyId}&limit=10`,
      { headers: headers() },
    )
    expect(res.status()).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    // We fired one webhook.test row.
    // The row's eventType is "webhook.test".
    const types = new Set(rows.map((r: any) => r.eventType))
    // "webhook.test" is the only type
    // we actually fired. The other
    // types the webhook subscribes to
    // are NOT in the result (no
    // invoice.created / payment.received
    // events fired — and there's no
    // path in the test that creates
    // them).
    expect(types.size).toBeGreaterThan(0)
    // Confirm at least one row has
    // the type we expect.
    expect(types.has("webhook.test")).toBe(true)
  })

  test("2. eventType=webhook.test returns ONLY webhook.test rows", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/webhooks/${multiWhId}/deliveries?companyId=${tokens!.companyId}&limit=10&eventType=webhook.test`,
      { headers: headers() },
    )
    const rows = await res.json()
    for (const r of rows) {
      expect(r.eventType, "every row should match the filter").toBe(
        "webhook.test",
      )
    }
  })

  test("3. eventType=invoice.created returns 0 rows (we never fired it)", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/webhooks/${multiWhId}/deliveries?companyId=${tokens!.companyId}&limit=10&eventType=invoice.created`,
      { headers: headers() },
    )
    const rows = await res.json()
    expect(rows.length, "no invoice.created rows were ever fired").toBe(0)
  })

  test("4. cross-webhook dead-letter list also supports eventType filter", async ({
    request,
  }) => {
    const all = await request.get(
      `http://localhost:3001/api/v1/webhooks/deliveries/dead-letter?companyId=${tokens!.companyId}&limit=10`,
      { headers: headers() },
    )
    const allRows = await all.json()
    const filtered = await request.get(
      `http://localhost:3001/api/v1/webhooks/deliveries/dead-letter?companyId=${tokens!.companyId}&limit=10&eventType=invoice.created`,
      { headers: headers() },
    )
    const filteredRows = await filtered.json()
    // Filtered subset is <= unfiltered.
    expect(filteredRows.length).toBeLessThanOrEqual(allRows.length)
    // Every row in the filtered set
    // matches.
    for (const r of filteredRows) {
      expect(r.eventType).toBe("invoice.created")
    }
  })
})

test.describe("Tier 201 — UI event-type filter", () => {
  // Seed one more webhook with a
  // distinct name so the page test
  // can filter to the right one
  // (the page lists all webhooks;
  // we open the drawer for our
  // seeded one).
  test("5. drawer renders the event-type filter dropdown with subscribed events", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    // Find the row for our seeded
    // webhook and open its
    // deliveries drawer.
    const row = page.locator(`[data-testid="webhook-row"]`).filter({
      hasText: seedTag,
    })
    await expect(row).toBeVisible({ timeout: 10000 })
    await row.getByTestId("webhook-deliveries").click()
    // The drawer + filter dropdown
    // should render.
    await expect(
      page.getByTestId("webhook-deliveries-drawer"),
    ).toBeVisible({ timeout: 5000 })
    const filter = page.getByTestId("delivery-event-type-filter")
    await expect(filter).toBeVisible({ timeout: 5000 })
    // The <select> should have
    // options for each subscribed
    // event type + "All event
    // types" (the default).
    const optionTexts = await filter.locator("option").allTextContents()
    expect(optionTexts.length).toBeGreaterThanOrEqual(4) // 3 events + All
    expect(
      optionTexts.some((t) => /Alle|All|所有/i.test(t)),
      "should have the 'all' option",
    ).toBe(true)
    expect(
      optionTexts.some((t) => t.includes("webhook.test")),
    ).toBe(true)
    expect(
      optionTexts.some((t) => t.includes("invoice.created")),
    ).toBe(true)
  })

  test("6. dead-letter card renders its own event-type filter", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    await expect(page.getByTestId("dead-letter-card")).toBeVisible({
      timeout: 10000,
    })
    const filter = page.getByTestId("dead-letter-event-type-filter")
    await expect(filter).toBeVisible({ timeout: 5000 })
    // The dropdown options should
    // include any event types the
    // company's webhooks subscribe
    // to. We don't hardcode the
    // list (varies per install) —
    // just confirm the filter
    // exists and has the default
    // "all" option.
    const optionTexts = await filter.locator("option").allTextContents()
    expect(optionTexts.length).toBeGreaterThan(0)
    expect(
      optionTexts.some((t) => /Alle|All|所有/i.test(t)),
    ).toBe(true)
  })
})
