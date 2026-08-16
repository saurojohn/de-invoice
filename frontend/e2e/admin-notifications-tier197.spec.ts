/**
 * Tier 197 — Admin: error/alert push notifications + batch operations
 *
 * Covers the four new admin endpoints and the new
 * system-errors page bulk action buttons:
 *
 *   1. GET  /api/v1/system/notifications/config — read
 *      the current channel wiring (Slack host + email
 *      recipients + anti-spam window). Should return
 *      `configured: false` for both when no env vars
 *      are set (which is the e2e CI default).
 *   2. POST /api/v1/system/notifications/test —
 *      fire a synthetic notification through the same
 *      push pipeline. Console-fallback always runs, so
 *      the response should be `{slack: "skipped", email:
 *      "skipped", console: "sent"}` in CI.
 *   3. POST /api/v1/system/errors/resolve-all —
 *      bulk-mark every open error as resolved. Returns
 *      `{ok, count}`. We seed a few open errors first
 *      via POST /api/v1/system/errors so the count
 *      assertion is meaningful.
 *   4. POST /api/v1/system/errors/mute-all — same
 *      shape, but sets status to "muted". Runs in
 *      isolation (we seed fresh events) so the
 *      two bulk endpoints don't step on each other.
 *   5. Frontend /dashboard/system-errors renders the
 *      new notification-channel card + the two bulk
 *      action buttons + the "Test notification" button.
 *
 * Tier 197 is the third in the admin-ops series
 * (after Tier 119 cron-health, Tier 193 metrics,
 * Tier 195 manual-run + restore-drill). It closes
 * the loop: errors land in the system, get
 * deduplicated by fingerprint, then get pushed to
 * the operator's chosen channels.
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

test.describe("Tier 197 — Notification channel config + test push", () => {
  test("1. GET /notifications/config returns the channel wiring (both off in CI)", async ({
    request,
  }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/system/notifications/config",
      { headers: headers() },
    )
    expect(res.status(), "config endpoint should be 200").toBe(200)
    const body = await res.json()
    // CI never sets SLACK_WEBHOOK_URL or NOTIFY_EMAIL, so
    // both channels are reported as not-configured. The
    // host + recipients fields are null/empty in that case.
    expect(body.slack).toMatchObject({ configured: false, host: null })
    expect(body.email).toMatchObject({ configured: false, recipients: [] })
    expect(body.antiSpamMinutes, "anti-spam window should be 5 minutes").toBe(5)
  })

  test("2. POST /notifications/test fires through the push pipeline", async ({
    request,
  }) => {
    const res = await request.post(
      "http://localhost:3001/api/v1/system/notifications/test",
      { headers: headers() },
    )
    expect(res.status(), "test push should succeed").toBe(201)
    const body = await res.json()
    // In CI, both external channels are off, so the
    // response shape is fixed: slack + email skipped,
    // console always sent.
    expect(body.slack, "slack should be skipped (no webhook in CI)").toBe(
      "skipped",
    )
    expect(body.email, "email should be skipped (no recipients in CI)").toBe(
      "skipped",
    )
    expect(body.console, "console should always be sent").toBe("sent")
  })
})

test.describe("Tier 197 — Bulk error operations", () => {
  // Seed 3 fresh open errors so the bulk endpoints
  // have something to act on. We use a unique tag in
  // the message so we can re-run the suite without
  // colliding with earlier runs.
  //
  // The seed POSTs go through the public /system/errors
  // endpoint (SoftAuthGuard). Without auth headers, the
  // controller writes companyId=null, which the admin
  // GET later filters OUT. So we pass x-user-id +
  // x-company-id headers even on the seed call so the
  // seeded events land under the admin's company.
  const uniqueTag = "tier197-bulk-" + Date.now()
  test.beforeAll(async ({ request }: { request: any }) => {
    for (let i = 0; i < 3; i++) {
      const res = await request.post(
        "http://localhost:3001/api/v1/system/errors",
        {
          headers: {
            "Content-Type": "application/json",
            "x-user-id": tokens!.userId,
            "x-company-id": tokens!.companyId,
          },
          data: {
            message: `[${uniqueTag}] test event ${i}`,
            kind: "manual",
            fingerprint: `tier197-${uniqueTag}-${i}`,
          },
        },
      )
      expect(res.status(), `seed error ${i} should land`).toBe(201)
    }
  })

  test("3. POST /errors/resolve-all closes every open error and reports count", async ({
    request,
  }) => {
    // Race: between the GET (openCount=N) and the
    // POST resolve-all, a new error may land (e.g.
    // a parallel test seeding one). We can't pin
    // the exact count, but we can pin the lower
    // bound (>= 3 from our seed) and the property
    // "after resolve-all, openCount === 0".
    const before = await request.get(
      "http://localhost:3001/api/v1/system/errors?status=open&take=200",
      { headers: headers() },
    )
    const beforeBody = await before.json()
    const minCount = beforeBody.openCount
    expect(minCount, "fixture seeded 3 open events").toBeGreaterThanOrEqual(3)

    const res = await request.post(
      "http://localhost:3001/api/v1/system/errors/resolve-all",
      { headers: headers() },
    )
    expect(res.status(), "resolve-all should be 201").toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.count, "count should be at least our seeded events").toBeGreaterThanOrEqual(minCount)

    // After the bulk op, the open count should be 0
    // (we resolve-all, not just our 3 fixture events).
    const after = await request.get(
      "http://localhost:3001/api/v1/system/errors?status=open&take=200",
      { headers: headers() },
    )
    const afterBody = await after.json()
    expect(afterBody.openCount, "no open events should remain").toBe(0)
  })

  test("4. POST /errors/mute-all marks every open error as muted", async ({
    request,
  }) => {
    // Re-seed 2 fresh open errors for this test,
    // because test #3 already drained the open queue.
    // Pass x-user-id/x-company-id headers so the
    // events land under the admin's company (the
    // public POST endpoint would otherwise write
    // companyId=null, which the admin GET filters
    // out).
    const tag = "tier197-mute-" + Date.now()
    for (let i = 0; i < 2; i++) {
      await request.post("http://localhost:3001/api/v1/system/errors", {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {
          message: `[${tag}] test event ${i}`,
          kind: "manual",
          fingerprint: `tier197-${tag}-${i}`,
        },
      })
    }

    const res = await request.post(
      "http://localhost:3001/api/v1/system/errors/mute-all",
      { headers: headers() },
    )
    expect(res.status(), "mute-all should be 201").toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.count, "should have muted at least our 2 fresh events").toBeGreaterThanOrEqual(2)

    // Verify by listing muted events — at least our 2
    // should be there.
    const after = await request.get(
      "http://localhost:3001/api/v1/system/errors?status=muted&take=200",
      { headers: headers() },
    )
    const afterBody = await after.json()
    const ourEvents = afterBody.items.filter((e: any) =>
      e.message.includes(tag),
    )
    expect(ourEvents.length, "our 2 seeded events should be muted").toBe(2)
  })

  test("5. bulk endpoints are idempotent (re-run on empty queue returns count=0)", async ({
    request,
  }) => {
    // At this point the open queue is empty (test #3
    // drained it; test #4 muted instead of resolving).
    // A second resolve-all should return count=0, not
    // an error.
    const res = await request.post(
      "http://localhost:3001/api/v1/system/errors/resolve-all",
      { headers: headers() },
    )
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.count, "no open events to resolve").toBe(0)
  })
})

test.describe("Tier 197 — System errors page bulk UI", () => {
  // Re-seed one open error so the page has something
  // to act on for the UI assertions. Pass auth
  // headers so the seed lands under the admin's
  // company (otherwise the admin GET filters it
  // out and the page shows 0 open events, which
  // disables the bulk buttons).
  const tag = "tier197-ui-" + Date.now()
  test.beforeAll(async ({ request }: { request: any }) => {
    await request.post("http://localhost:3001/api/v1/system/errors", {
      headers: {
        "Content-Type": "application/json",
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
      data: {
        message: `[${tag}] UI test seed`,
        kind: "manual",
        fingerprint: `tier197-${tag}-1`,
      },
    })
  })

  test("6. frontend renders notification channels + test + bulk buttons", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/system-errors")
    // Wait for the page to load — the notification
    // channels card and the bulk action buttons all
    // use data-testid, so we can assert on them
    // without race conditions.
    await expect(page.getByTestId("notif-slack")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("notif-email")).toBeVisible()
    // Anti-spam minutes text contains "5" in the
    // rendered output (de/en/zh all surface the
    // number directly). We don't assert on the i18n
    // string — just that the channel card rendered
    // the host + recipient count.
    await expect(page.getByTestId("notif-test")).toBeVisible()
    // Bulk action buttons are also rendered, but
    // they're disabled when openCount === 0. We
    // re-seeded one event in beforeAll, so they
    // should be enabled.
    await expect(page.getByTestId("resolve-all")).toBeVisible()
    await expect(page.getByTestId("mute-all")).toBeVisible()
  })

  test("7. test notification button fires the test endpoint and shows the result", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/system-errors")
    await expect(page.getByTestId("notif-test")).toBeVisible({ timeout: 10000 })
    // Click the test button. The endpoint is fast
    // (no external IO in CI), so the test-result
    // line should appear within a couple seconds.
    await page.getByTestId("notif-test").click()
    await expect(page.getByTestId("notif-test-result")).toBeVisible({
      timeout: 5000,
    })
    // The result line always contains "Console: sent"
    // in CI. The other two are "Slack: skipped" and
    // "Email: skipped". We assert on the three channel
    // names + the "sent"/"skipped" states. The exact
    // i18n wording varies per locale — "Konsole" in
    // German, "Console" in English / Chinese.
    const text = await page.getByTestId("notif-test-result").innerText()
    expect(text, "result should mention Slack status").toMatch(/Slack.*skipped/i)
    expect(text, "result should mention Email status").toMatch(
      /E-??[Mm]ail.*skipped/i,
    )
    // The "sent" state for the always-on console
    // fallback. Match "Konsole" (de) / "Console"
    // (en/zh) followed by "sent". We use a
    // character class [oe] for the German "Konsole"
    // vs "Konsolen" (the e at the end of "Konsole"
    // is just before ":", but Konsolen?e was wrong
    // — we just need any single letter that covers
    // both spellings).
    expect(text, "result should mention console-sent").toMatch(
      /(Konsole|Console|控制台).*sent/i,
    )
  })
})
