/**
 * Tier 199 — Admin: webhooks list "last successful delivery" badge
 *
 * Covers the new GET /webhooks enrichment
 * and the new badge column on
 * /dashboard/settings/webhooks:
 *
 *   1. GET /api/v1/webhooks now includes
 *      `lastSuccessAt` (Date | null) and
 *      `lastDeliveryAt` (Date | null) for
 *      every row.
 *   2. A webhook that has never fired
 *      returns lastSuccessAt=null AND
 *      lastDeliveryAt=null.
 *   3. A webhook that has fired (e.g.
 *      via the test endpoint) but never
 *      received 2xx returns
 *      lastSuccessAt=null but a real
 *      lastDeliveryAt.
 *   4. A webhook whose last delivery was
 *      successful (HTTP 200) returns
 *      lastSuccessAt=lastDeliveryAt.
 *   5. The /dashboard/settings/webhooks
 *      page renders a "last success" badge
 *      per row with the right color and
 *      label.
 *   6. A webhook with no successful
 *      delivery renders the red
 *      "Nie erfolgreich" / "Never
 *      successful" badge.
 *
 * Tier 199 is the fifth in the admin-ops
 * series (Tier 119 cron-health, Tier 193
 * metrics, Tier 195 manual-run, Tier 197
 * push, Tier 198 dead-letter requeue). It
 * closes the loop on delivery visibility:
 * the operator can now see "is this
 * webhook healthy" at a glance from the
 * webhooks list, without opening the
 * deliveries drawer.
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

// Two webhooks for the API tests:
//   1. success-wh: httpbin.org/status/200 (always 2xx → lastSuccessAt set)
//   2. fail-wh:    postman-echo.com/status/200 (returns 404 → lastSuccessAt null)
//
// We tag each by a unique name so the
// test never collides with a previous
// run's leftover rows.
const successTag = "tier199-ok-" + Date.now()
const failTag = "tier199-fail-" + Date.now()
let successWhId = ""
let failWhId = ""

test.beforeAll(async ({ request }: { request: any }) => {
  // Success webhook (httpbin.org/status/200 returns 200 OK)
  const ok = await request.post(
    `http://localhost:3001/api/v1/webhooks?companyId=${tokens!.companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
      data: {
        name: successTag,
        url: "https://httpbin.org/status/200",
        events: ["webhook.test"],
      },
    },
  )
  expect(ok.status(), "create success webhook").toBe(201)
  successWhId = (await ok.json()).id

  // Fail webhook (postman-echo.com/status/200 actually returns 404)
  const fail = await request.post(
    `http://localhost:3001/api/v1/webhooks?companyId=${tokens!.companyId}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
      data: {
        name: failTag,
        url: "https://postman-echo.com/status/200",
        events: ["webhook.test"],
      },
    },
  )
  expect(fail.status(), "create fail webhook").toBe(201)
  failWhId = (await fail.json()).id

  // Fire both so they have a recent delivery row.
  for (const whId of [successWhId, failWhId]) {
    await request.post(
      `http://localhost:3001/api/v1/webhooks/${whId}/test?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
  }
  // Wait for the deliveries to land
  // (the POST is fire-and-forget but
  // usually <1s).
  await new Promise((r) => setTimeout(r, 2000))
})

test.describe("Tier 199 — GET /webhooks enrichment", () => {
  test("1. every row includes lastSuccessAt and lastDeliveryAt fields", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/webhooks?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    expect(res.status()).toBe(200)
    const rows = await res.json()
    expect(Array.isArray(rows)).toBe(true)
    for (const row of rows) {
      // Both fields must be present (even
      // if null). The TypeScript interface
      // requires them; the test pins the
      // backend contract.
      expect(row).toHaveProperty("lastSuccessAt")
      expect(row).toHaveProperty("lastDeliveryAt")
    }
  })

  test("2. a successful webhook has lastSuccessAt === lastDeliveryAt", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/webhooks?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    const rows = await res.json()
    const okRow = rows.find((r: any) => r.id === successWhId)
    expect(okRow, "success webhook should be in list").toBeTruthy()
    expect(okRow.lastDeliveryAt, "should have a lastDeliveryAt").toBeTruthy()
    // A 2xx response means the row is
    // both the latest attempt AND the
    // latest success.
    expect(okRow.lastSuccessAt, "should have a lastSuccessAt").toBeTruthy()
    expect(okRow.lastSuccessAt).toBe(okRow.lastDeliveryAt)
  })

  test("3. a failing webhook has lastSuccessAt=null but lastDeliveryAt set", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/webhooks?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    const rows = await res.json()
    const failRow = rows.find((r: any) => r.id === failWhId)
    expect(failRow, "fail webhook should be in list").toBeTruthy()
    expect(failRow.lastDeliveryAt, "should have a lastDeliveryAt").toBeTruthy()
    expect(
      failRow.lastSuccessAt,
      "postman-echo returns 404 so no success yet",
    ).toBeNull()
  })
})

test.describe("Tier 199 — frontend last-success badge", () => {
  // Seed one more webhook that has
  // never fired (no lastDeliveryAt,
  // no lastSuccessAt) so the UI test
  // can verify the "never fired"
  // case.
  const neverFiredTag = "tier199-never-" + Date.now()
  test.beforeAll(async ({ request }: { request: any }) => {
    const res = await request.post(
      `http://localhost:3001/api/v1/webhooks?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {
          name: neverFiredTag,
          url: "https://httpbin.org/status/200",
          events: ["webhook.test"],
        },
      },
    )
    expect(res.status()).toBe(201)
    // Don't fire it — lastDeliveryAt must remain null.
  })

  test("4. /dashboard/settings/webhooks renders a last-success badge column", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    // Find at least one badge (any
    // webhook has a row).
    await expect(page.getByTestId("webhook-last-success").first()).toBeVisible({
      timeout: 10000,
    })
  })

  test("5. a successful webhook renders a green badge with 'min ago' / 'hr ago'", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    // Find the success webhook's row by
    // its unique name. The badge inside
    // should be green (emerald) and
    // include a relative-time label
    // matching /vor \d+ Min|vor \d+ Std|
    // \d+ min ago|\d+ hr ago|分钟前|
    // 小时前/i.
    const row = page.locator(`[data-testid="webhook-row"]`).filter({
      hasText: successTag,
    })
    const badge = row.getByTestId("webhook-last-success")
    await expect(badge).toBeVisible({ timeout: 5000 })
    const text = (await badge.innerText()).trim()
    // The text contains "✓" and a
    // locale-specific relative time.
    expect(text, "badge should include a checkmark").toContain("✓")
    // Locale-agnostic: just check it
    // contains a number + a time unit.
    // de: "vor 1 Min", en: "1 min ago",
    // zh: "1 分钟前".
    expect(
      text,
      `badge text should include a relative time — got "${text}"`,
    ).toMatch(
      /\d+\s+(Min|Std|min|hr|Tag|Tagen|day|days|分钟|小时|天)/i,
    )
  })

  test("6. a failing webhook renders a red 'never successful' badge", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    const row = page.locator(`[data-testid="webhook-row"]`).filter({
      hasText: failTag,
    })
    const badge = row.getByTestId("webhook-last-success")
    await expect(badge).toBeVisible({ timeout: 5000 })
    // Locale-agnostic — just check the
    // shape ("Nie erfolgreich" / "Never
    // successful" / "从未成功").
    const text = (await badge.innerText()).trim()
    expect(
      text,
      "fail badge should be one of the 'never successful' labels",
    ).toMatch(/Nie erfolgreich|Never successful|从未成功|Nie ausgelöst|Never fired|从未触发/i)
  })

  test("7. a never-fired webhook renders a gray 'never fired' badge", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    const row = page.locator(`[data-testid="webhook-row"]`).filter({
      hasText: neverFiredTag,
    })
    const badge = row.getByTestId("webhook-last-success")
    await expect(badge).toBeVisible({ timeout: 5000 })
    const text = (await badge.innerText()).trim()
    expect(
      text,
      "never-fired badge should be the 'never fired' label",
    ).toMatch(/Nie ausgelöst|Never fired|从未触发/i)
  })
})
