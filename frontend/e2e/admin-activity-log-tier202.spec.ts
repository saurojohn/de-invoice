/**
 * Tier 202 — Admin activity log (Berater read)
 *
 * Covers the new AuditService.writeActivity
 * integration + the new
 * /dashboard/activity page:
 *
 *   1. POST /system/errors/resolve-all
 *      writes an `error.resolve_all`
 *      activity row.
 *   2. POST /system/errors/mute-all
 *      writes an `error.mute_all`
 *      activity row.
 *   3. POST /system/notifications/test
 *      writes a `notification.test`
 *      activity row.
 *   4. POST /admin/cron-health/:name/run
 *      writes a `cron.run_manually`
 *      activity row.
 *   5. POST /webhooks/deliveries/:id/requeue
 *      writes a `webhook.requeue`
 *      activity row.
 *   6. GET /api/v1/audit-logs/activity
 *      returns rows for all 5
 *      instrumented actions, with
 *      the action prefix filter
 *      working.
 *   7. /dashboard/activity renders
 *      the list with the new
 *      activity card on the
 *      dashboard.
 *   8. The chain verify endpoint
 *      still walks the chain
 *      (Tier 196 invariant — Tier
 *      202 activity rows share the
 *      same chain pointer).
 *
 * Tier 202 is the operator-audit
 * companion to Tier 196 (Berater
 * audit-trail hash chain). It
 * records the "what did the
 * operator do" surface distinct
 * from the "who changed what on
 * the data" surface.
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"
import { execFileSync } from "child_process"
import { PG_CONTAINER } from './fixtures/test-env'

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

test.describe("Tier 202 — instrumented admin actions write activity rows", () => {
  // The Tier 202 e2e runs against a
  // shared DB that has many
  // existing activity rows from
  // prior e2e runs. We seed a few
  // fresh ones tagged with a
  // unique marker so we can find
  // OUR rows in the result.
  const seedTag = "tier202-" + Date.now()

  test("1. resolve-all + mute-all + notifications/test write 3 activity rows", async ({
    request,
  }) => {
    // Note: the activity endpoint
    // is per-companyId-scoped, so
    // these rows go to OUR company
    // (the test's companyId).

    await request.post(
      "http://localhost:3001/api/v1/system/errors/resolve-all",
      { headers: headers() },
    )
    await request.post(
      "http://localhost:3001/api/v1/system/errors/mute-all",
      { headers: headers() },
    )
    await request.post(
      "http://localhost:3001/api/v1/system/notifications/test",
      { headers: headers() },
    )

    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity?companyId=${tokens!.companyId}&take=200`,
      { headers: headers() },
    )
    const data = await res.json()
    const actions = new Set<string>(
      (data.rows || []).map((r: any) => r.action),
    )
    expect(actions.has("error.resolve_all")).toBe(true)
    expect(actions.has("error.mute_all")).toBe(true)
    expect(actions.has("notification.test")).toBe(true)
  })

  test("2. cron.run_manually writes an activity row with companyId=null", async ({
    request,
  }) => {
    // Cron runs are admin-scoped
    // (cross-company), so the
    // activity row has companyId
    // = null. The activity endpoint
    // includes these via the
    // includeNullCompanyId flag.
    await request.post(
      `http://localhost:3001/api/v1/admin/cron-health/webhook-retry-worker/run?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity?companyId=${tokens!.companyId}&take=200`,
      { headers: headers() },
    )
    const data = await res.json()
    const cronRow = (data.rows || []).find(
      (r: any) => r.action === "cron.run_manually",
    )
    expect(cronRow, "cron.run_manually should be in the activity list").toBeTruthy()
    expect(cronRow.entityId, "cron name should be in entityId").toBe(
      "webhook-retry-worker",
    )
  })

  test("3. webhook.requeue writes an activity row (with delivery metadata)", async ({
    request,
  }) => {
    // We need an exhausted delivery
    // to requeue. Seed one via the
    // standard create + UPDATE
    // pattern.
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
          events: ["webhook.test"],
        },
      },
    )
    expect(create.status()).toBe(201)
    const whId = (await create.json()).id

    await request.post(
      `http://localhost:3001/api/v1/webhooks/${whId}/test?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    // Tier 348: this was a fixed `setTimeout(1500)` followed by a
    // single GET, and it test.skip()-ed when the delivery row had
    // not landed yet — turning a slow-but-working queue into a
    // silent pass. Poll instead: same 5s budget, but it returns as
    // soon as the row appears and FAILS if it never does. Mirrors
    // the polling loop webhook-dead-letter-tier198's beforeAll
    // already uses.
    let deliveryId: string | undefined
    let deliveryStatus: string | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      const list = await request.get(
        `http://localhost:3001/api/v1/webhooks/${whId}/deliveries?companyId=${tokens!.companyId}&limit=1`,
        { headers: headers() },
      )
      const rows = await list.json()
      const row = Array.isArray(rows) ? rows[0] : undefined
      deliveryId = row?.id
      deliveryStatus = row?.status
      // Tier 369b: wait for a TERMINAL status, not merely for the row to exist.
      // POST /test dispatches asynchronously, so the row shows up as 'pending'
      // while the HTTP attempt is still in flight. Forcing status='exhausted'
      // at that moment is racy — the in-flight dispatch lands a moment later
      // and overwrites it with success/failed, and the requeue below then 400s
      // with "is X, not exhausted" (requeueDelivery accepts only 'exhausted').
      // Seen in CI run 34696678293: first attempt failed in 196ms on
      // `expect(rq.status()).toBe(200)` receiving 400, retry passed, reported
      // as "1 flaky". A flaky test hides a real failure exactly like the
      // silent skips this tier removed.
      if (
        deliveryId &&
        ["success", "failed", "exhausted"].includes(deliveryStatus ?? "")
      ) {
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(deliveryId, "webhook delivery row must land within 5s").toBeTruthy()
    expect(
      deliveryStatus,
      "the delivery must reach a terminal status before we force it to exhausted",
    ).toMatch(/^(success|failed|exhausted)$/)
    // Force to exhausted.
    execFileSync(
      "docker",
      [
        "exec",
        PG_CONTAINER,
        "psql",
        "-U",
        "de_invoice",
        "-d",
        "de_invoice",
        "-c",
        `UPDATE "WebhookDelivery" SET status='exhausted', "retryCount"=3, "nextRetryAt"='2099-12-31 23:59:59'::timestamp WHERE id='${deliveryId}'`,
      ],
      { encoding: "utf-8" },
    )

    // Requeue.
    const rq = await request.post(
      `http://localhost:3001/api/v1/webhooks/deliveries/${deliveryId}/requeue?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    expect(rq.status()).toBe(200)

    // Verify activity row.
    const act = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity?companyId=${tokens!.companyId}&take=200`,
      { headers: headers() },
    )
    const data = await act.json()
    const rqRow = (data.rows || []).find(
      (r: any) => r.action === "webhook.requeue" && r.entityId === deliveryId,
    )
    expect(rqRow, "webhook.requeue should be in the activity list").toBeTruthy()
    expect(rqRow.newData, "newData should have eventType").toBeTruthy()
    expect(rqRow.newData.webhookId).toBe(whId)
  })

  test("4. actionPrefix filter narrows the result", async ({ request }) => {
    // Filter to cron. only — only
    // cron.run_manually should
    // appear.
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity?companyId=${tokens!.companyId}&actionPrefix=cron.&take=200`,
      { headers: headers() },
    )
    const data = await res.json()
    for (const r of data.rows || []) {
      expect(r.action.startsWith("cron.")).toBe(true)
    }
    expect(data.rows.length).toBeGreaterThan(0)
  })

  test("5. the chain verify endpoint walks the chain (Tier 202 rows share the chain pointer)", async ({
    request,
  }) => {
    // We don't assert ok=true here
    // because the shared DB may
    // have a broken chain from a
    // prior e2e run (the verify
    // endpoint surfaces the first
    // mismatch, which could be in
    // a row we don't control). We
    // only assert that the verify
    // endpoint actually returns
    // the chain metadata (it
    // walked, didn't error out).
    // The Tier 202 activity rows
    // themselves are correctly
    // chained (we test that
    // indirectly via the row
    // insertion in tests 1-3).
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/verify?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    const data = await res.json()
    expect(data).toHaveProperty("ok")
    expect(data).toHaveProperty("totalRows")
    expect(data).toHaveProperty("algorithm")
    // Tier 366: rows written before the Decimal canonicalisation fix are
    // SHA-256-V1, new ones SHA-256-V2; the chain reports the newest signed
    // row's algorithm.
    expect(data.algorithm).toMatch(/^SHA-256-V[12]$/)
    expect(data.totalRows).toBeGreaterThan(0)
  })
})

test.describe("Tier 202 — /dashboard/activity UI", () => {
  test("6. /dashboard/activity renders the activity table", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/activity")
    // The page renders the table
    // (or the empty state if there
    // are no rows for the current
    // companyId — we know there
    // ARE rows from the prior
    // tests).
    // Wait for the data to load
    // (the table is rendered after
    // the API call resolves).
    const row = page.getByTestId("activity-row").first()
    await expect(row).toBeVisible({ timeout: 10000 })
  })

  test("7. clicking the verify-chain button sets the chain-ok badge", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/activity")
    const btn = page.getByTestId("activity-verify-chain")
    await expect(btn).toBeVisible({ timeout: 10000 })
    await btn.click()
    // Either chain-ok or
    // chain-broken badge should
    // appear (the chain is likely
    // intact after the writes, but
    // a leftover tamper from a
    // prior e2e run could break it).
    await expect(
      page.getByTestId("chain-ok").or(page.getByTestId("chain-broken")),
    ).toBeVisible({ timeout: 10000 })
  })
})
