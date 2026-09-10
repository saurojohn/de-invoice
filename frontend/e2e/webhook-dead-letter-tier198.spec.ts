/**
 * Tier 198 — Webhook dead-letter requeue
 *
 * Covers the two new admin endpoints and the
 * new dashboard section:
 *
 *   1. GET /api/v1/webhooks/deliveries/dead-letter
 *      — cross-webhook view of every
 *      status='exhausted' delivery for the
 *      company. Returns rows with the webhook
 *      name/url joined in.
 *   2. POST /api/v1/webhooks/deliveries/:id/requeue
 *      — reset the same row back to
 *      status='failed' with nextRetryAt=now()
 *      and retryCount=0, so the cron worker
 *      picks it up on the next tick.
 *   3. 400 on requeue of a non-exhausted row
 *      (only dead-letters can be requeued).
 *   4. 404 on requeue of a nonexistent row.
 *   5. Frontend /dashboard/settings/webhooks
 *      renders the new "Dead-Letter Queue"
 *      card with the requeue button per row.
 *
 * Tier 198 is the fourth in the admin-ops
 * series (Tier 119 cron-health, Tier 193
 * metrics, Tier 195 manual-run +
 * restore-drill, Tier 197 push
 * notifications). It closes the loop on
 * webhook delivery resilience: the retry
 * budget is a stop-gap, not a permanent
 * dead-end — operators can requeue.
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

test.describe("Tier 198 — Dead-letter list + requeue", () => {
  // Seed a webhook + an exhausted delivery for
  // the requeue test. We use the Prisma
  // backend's direct SQL to flip an existing
  // delivery to 'exhausted' — the e2e
  // path doesn't expose a "force-fail"
  // endpoint (and we don't want one — it's
  // an internal feature).
  //
  // The seed creates a fresh webhook for
  // every run so we don't collide with
  // existing test webhooks.
  const seedTag = "tier198-" + Date.now()
  let webhookId: string = ""
  let deliveryId: string = ""

  test.beforeAll(async ({ request }: { request: any }) => {
    // Create a webhook using a valid public
    // URL (postman-echo). The URL may return
    // non-2xx but the create endpoint only
    // validates the URL shape + SSRF guard.
    // The create endpoint requires
    // 'company.update' (admin), so we pass
    // auth headers explicitly.
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
          url: "https://postman-echo.com/status/200",
          events: ["webhook.test"],
        },
      },
    )
    expect(create.status(), "create webhook").toBe(201)
    const created = await create.json()
    webhookId = created.id

    // Fire the test event so a delivery row
    // exists. Then we mutate it via raw psql
    // to status='exhausted' (we can't reach
    // 3 failed attempts in 1 minute of CI
    // without changing the retry budget).
    const fire = await request.post(
      `http://localhost:3001/api/v1/webhooks/${webhookId}/test?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    expect(fire.status(), "fire test event").toBe(201)
    // Wait for the delivery to land (the
    // emit() is fire-and-forget but
    // usually <1s in CI).
    // Tier 350: wait for the delivery to reach a TERMINAL state, not
    // merely to exist. The row is INSERTed with status='pending'
    // (webhook.service.ts:338) and the POST to postman-echo.com is
    // still in flight at that moment; when the response lands, the
    // service UPDATEs the same row with the final status
    // (webhook.service.ts:792). The old loop broke as soon as
    // `arr.length > 0`, i.e. on the pending row, so the seed UPDATE
    // below raced that write-back and was silently overwritten with
    // 'success' whenever postman-echo answered slowly. THAT is what
    // made tests 1/2/6/7 skip and flake -- not the cron, which only
    // ever selects `status='failed' AND nextRetryAt <= now()`
    // (webhook.service.ts:420) and so can never touch an 'exhausted'
    // row at all. Both in-file comments blaming the cron, and the one
    // blaming "requeue from test 2", were wrong.
    //
    // Budget is 80 x 250ms = 20s, deliberately more than the 10s
    // delivery HTTP timeout (webhook.service.ts:848): on a timeout the
    // catch branch still writes a terminal status, so the row always
    // leaves 'pending' -- but only just after the 10s mark, and a 10s
    // budget would race exactly that write.
    let attempts = 0
    let deliveryStatus = ""
    while (attempts < 80) {
      const list = await request.get(
        `http://localhost:3001/api/v1/webhooks/${webhookId}/deliveries?companyId=${tokens!.companyId}&limit=5`,
        { headers: headers() },
      )
      const arr = await list.json()
      if (Array.isArray(arr) && arr.length > 0 && arr[0].status !== "pending") {
        deliveryId = arr[0].id
        deliveryStatus = arr[0].status
        break
      }
      await new Promise((r) => setTimeout(r, 250))
      attempts++
    }
    expect(
      deliveryId,
      "delivery row reached a terminal status within 20s",
    ).toBeTruthy()
    expect(deliveryStatus, "delivery must not still be pending").not.toBe(
      "pending",
    )
    // Mutate to exhausted via direct SQL.
    // (Frontend e2e context lacks
    // @prisma/client so we shell out.)
    // We use a future nextRetryAt so the
    // cron worker (every 1 min, WHERE
    // status='failed' AND nextRetryAt
    // <= now()) cannot re-pick the row
    // even if a race flipped it back to
    // 'failed'.
    // Use the explicit ::timestamp cast
    // (PG would coerce anyway, but the
    // cast ensures the column type
    // matches what findDueRetries
    // compares against — without the
    // cast some clients pass the value
    // as text, which can fail the
    // comparison depending on PG
    // version).
    const updateOut = execFileSync(
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
        `UPDATE "WebhookDelivery" SET status='exhausted', "retryCount"=3, "nextRetryAt"='2099-12-31 23:59:59'::timestamp, "errorMessage"='tier198 seed: simulated' WHERE id='${deliveryId}' RETURNING id, status`,
      ],
      { encoding: "utf-8" },
    )
    // Fail fast if the UPDATE didn't match
    // any row (the row ID may have been
    // wrong, or the row may have been
    // deleted).
    expect(updateOut, "UPDATE should report 1 row changed").toMatch(
      /UPDATE 1/,
    )
  })

  test("1. GET /dead-letter surfaces the seeded exhausted row with webhook joined", async ({
    request,
  }) => {
    // Verify state at test start — the
    // seed should have set this to
    // 'exhausted'. If it's not, the
    // cron worker probably re-picked
    // the row despite the future
    // nextRetryAt. Skip the test in
    // that case (better than failing
    // on a race the test can't
    // control).
    const dbStatus = execFileSync(
      "docker",
      [
        "exec",
        PG_CONTAINER,
        "psql",
        "-U",
        "de_invoice",
        "-d",
        "de_invoice",
        "-tA",
        "-c",
        `SELECT status FROM "WebhookDelivery" WHERE id='${deliveryId}'`,
      ],
      { encoding: "utf-8" },
    ).trim()
    // Tier 350: was `test.skip(dbStatus !== "exhausted", "... cron race")`.
    // With the beforeAll now waiting for a terminal delivery status
    // before seeding, nothing can overwrite the row, so a non-exhausted
    // status here is a real defect and must fail.
    expect(dbStatus, "seeded row must still be exhausted").toBe("exhausted")
    const res = await request.get(
      `http://localhost:3001/api/v1/webhooks/deliveries/dead-letter?companyId=${tokens!.companyId}&limit=100`,
      { headers: headers() },
    )
    expect(res.status(), "dead-letter list should be 200").toBe(200)
    const items = await res.json()
    expect(Array.isArray(items)).toBe(true)
    // Race: other tests in the suite may
    // also have left exhausted rows. We
    // assert that OUR seeded row is in
    // the list, not the absolute count.
    const ourRow = items.find((d: any) => d.id === deliveryId)
    expect(ourRow, "our exhausted delivery should be in the list").toBeTruthy()
    expect(ourRow.status).toBe("exhausted")
    expect(ourRow.webhook, "joined-in webhook name/url").toBeTruthy()
    expect(ourRow.webhook.name).toBe(seedTag)
  })

  test("2. POST /requeue resets the row back to failed with retryCount=0", async ({
    request,
  }) => {
    const res = await request.post(
      `http://localhost:3001/api/v1/webhooks/deliveries/${deliveryId}/requeue?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    // Tier 350: was a test.skip() on any non-200, blamed on the cron
    // worker. The cron selects `status='failed' AND nextRetryAt <=
    // now()` only, so it never sees the seeded 'exhausted' row; the
    // real cause was the delivery write-back race the beforeAll now
    // waits out. Assert the status and surface the body on failure
    // instead of skipping.
    const requeueBody = await res.text()
    expect(
      res.status(),
      `requeue should be 200, got ${res.status()}: ${requeueBody.slice(0, 200)}`,
    ).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.delivery.id).toBe(deliveryId)
    expect(body.delivery.status, "status flipped to failed").toBe("failed")
    expect(body.delivery.retryCount, "retryCount reset to 0").toBe(0)
    expect(body.delivery.nextRetryAt, "nextRetryAt set to now").toBeTruthy()

    // After the requeue, the row should no
    // longer be in the dead-letter list
    // (it became 'failed', not 'exhausted').
    const after = await request.get(
      `http://localhost:3001/api/v1/webhooks/deliveries/dead-letter?companyId=${tokens!.companyId}&limit=100`,
      { headers: headers() },
    )
    const afterItems = await after.json()
    const stillExhausted = afterItems.find((d: any) => d.id === deliveryId)
    expect(
      stillExhausted,
      "our row should have left the dead-letter list",
    ).toBeUndefined()
  })

  test("3. requeue on a non-exhausted row returns 400", async ({
    request,
  }) => {
    // The previous test requeued our row to
    // status='failed'. Calling requeue
    // again should 400 — only exhausted
    // rows can be requeued.
    const res = await request.post(
      `http://localhost:3001/api/v1/webhooks/deliveries/${deliveryId}/requeue?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    expect(res.status(), "re-requeue should 400").toBe(400)
    const body = await res.json()
    expect(body.message, "error should mention status").toContain("failed")
  })

  test("4. requeue on a nonexistent row returns 404", async ({ request }) => {
    const res = await request.post(
      `http://localhost:3001/api/v1/webhooks/deliveries/nonexistent-${seedTag}/requeue?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    expect(res.status(), "nonexistent requeue should 404").toBe(404)
  })
})

test.describe("Tier 198 — Dead-Letter UI on webhooks page", () => {
  // Re-seed a fresh exhausted delivery for
  // the UI test. The previous suite already
  // requeued its row, so the dead-letter
  // list is now empty (or contains only
  // unrelated rows from parallel suites).
  const seedTag = "tier198-ui-" + Date.now()
  let webhookId: string = ""
  let deliveryId: string = ""

  test.beforeAll(async ({ request }: { request: any }) => {
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
          url: "https://postman-echo.com/status/200",
          events: ["webhook.test"],
        },
      },
    )
    expect(create.status()).toBe(201)
    webhookId = (await create.json()).id

    await request.post(
      `http://localhost:3001/api/v1/webhooks/${webhookId}/test?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )
    // Tier 350: same terminal-state wait as the first describe -- see
    // the long comment there. Breaking on the 'pending' row let the
    // in-flight delivery write-back clobber the seeded 'exhausted'
    // status, which is why tests 6 and 7 skipped and why 6 stayed
    // flaky after Tier 348 converted its skip to an assertion.
    let attempts = 0
    let deliveryStatus = ""
    while (attempts < 80) {
      const list = await request.get(
        `http://localhost:3001/api/v1/webhooks/${webhookId}/deliveries?companyId=${tokens!.companyId}&limit=5`,
        { headers: headers() },
      )
      const arr = await list.json()
      if (Array.isArray(arr) && arr.length > 0 && arr[0].status !== "pending") {
        deliveryId = arr[0].id
        deliveryStatus = arr[0].status
        break
      }
      await new Promise((r) => setTimeout(r, 250))
      attempts++
    }
    expect(deliveryId, "delivery reached a terminal status").toBeTruthy()
    expect(deliveryStatus).not.toBe("pending")
    // Same future-dated nextRetryAt trick
    // — protects against any cron race
    // that might flip the row back to
    // 'failed' between UPDATE and the
    // page render.
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
        `UPDATE "WebhookDelivery" SET status='exhausted', "retryCount"=3, "nextRetryAt"='2099-12-31 23:59:59', "errorMessage"='tier198-ui seed' WHERE id='${deliveryId}'`,
      ],
      { encoding: "utf-8" },
    )
  })

  test("5. /dashboard/settings/webhooks renders the Dead-Letter card", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    // The dead-letter card should render
    // even when empty. We assert on the
    // testid (rendered regardless of
    // empty/non-empty state).
    await expect(page.getByTestId("dead-letter-card")).toBeVisible({
      timeout: 10000,
    })
  })

  test("6. dead-letter card shows our seeded row + requeue button", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    // Wait for the dead-letter refresh to
    // land. The page calls fetchDeadLetter
    // on mount, but it races with the seed
    // (which happens in beforeAll BEFORE
    // the page navigates). The card shows
    // our row by testid+id attribute.
    await expect(page.getByTestId("dead-letter-card")).toBeVisible({
      timeout: 10000,
    })
    // The dead-letter list may contain rows
    // from previous e2e runs (the test DB
    // is shared). We filter by the unique
    // webhook name (seedTag) so we target
    // OUR row, not a leftover from a prior
    // run. The cron worker may have processed
    // (or our requeue from test 2 removed) the
    // row, in which case we skip — the spec's
    // intent is verified by tests 2/3 (the API
    // path).
    const row = page.locator(`[data-testid="dead-letter-row"]`).filter({
      hasText: seedTag,
    })
    await expect(row).toBeVisible({ timeout: 15000 })
    // The requeue button on that specific row.
    const requeueBtn = row.getByTestId("dead-letter-requeue")
    await expect(requeueBtn).toBeVisible()
  })

  test("7. clicking requeue removes the row from the dead-letter list", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/settings/webhooks")
    await expect(page.getByTestId("dead-letter-card")).toBeVisible({
      timeout: 10000,
    })
    // Wait for our row to render.
    const row = page.locator(`[data-testid="dead-letter-row"]`).filter({
      hasText: seedTag,
    })
    await expect(row).toBeVisible({ timeout: 15000 })
    // Click the requeue button on that row.
    // The button is inside the row.
    const requeueBtn = row.getByTestId("dead-letter-requeue")
    await requeueBtn.click()
    // The page re-fetches the dead-letter
    // list on success. Our row should
    // disappear. We allow up to 5s for
    // the network roundtrip + render.
    await expect(row).not.toBeVisible({ timeout: 5000 })
  })
})
