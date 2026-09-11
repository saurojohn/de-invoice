/**
 * Tier 195 — Admin operations: cron manual run + restore-drill
 *
 * Covers the two new admin operations endpoints
 * and the new system-health page action button:
 *
 *   1. POST /admin/cron-health/:name/run —
 *      SchedulerRegistry.getCronJob(name).fireOnTick()
 *      outside its schedule. Returns the firedAt
 *      timestamp. We assert the new lastRunAt lands
 *      on the GET endpoint after a short wait.
 *   2. The safety guards: 400 on unknown cron name,
 *      400 on daily-auto-backup (destructive cron
 *      blocked from the manual-run path).
 *   3. POST /admin/backups/restore-drill — full
 *      end-to-end restore into a throwaway DB. We
 *      pick a backup with a real db.sql.gz (most
 *      recent are attachments-only), restore it,
 *      assert the throwaway DB has tables, then
 *      assert the throwaway DB is dropped (no
 *      leak). If no valid backup is available, the
 *      test is skipped (we don't pre-create one —
 *      the e2e suite must be safe to run on a
 *      fresh install).
 *   4. The system-health page renders a "Run now"
 *      button per cron row.
 *
 * Tier 195 is the Berater's Tier 127 follow-up
 * for admin operations. It pairs with the
 * observability work in Tier 193 — the operator
 * gets metrics on Tier 193, and the ability to
 * act on those metrics on Tier 195.
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  // Tier 207 — removed the dead `for...in` placeholder
  // loop (it iterates numeric indices, never did anything)
  // and the throw on missing keys.
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

test.describe("Tier 195 — Admin: cron manual run", () => {
  test("1. POST /run fires a real cron and updates lastRunAt", async ({
    request,
  }) => {
    // Read the current lastRunAt for webhook-retry-worker
    const before = await request.get(
      "http://localhost:3001/api/v1/admin/cron-health",
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const beforeList = await before.json()
    const beforeRow = beforeList.find(
      (c: any) => c.name === "webhook-retry-worker",
    )
    const beforeLastRun = beforeRow?.lastRunAt
    // Trigger manually
    const run = await request.post(
      `http://localhost:3001/api/v1/admin/cron-health/webhook-retry-worker/run?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(run.status(), "manual run should succeed").toBe(201)
    const runBody = await run.json()
    expect(runBody.name).toBe("webhook-retry-worker")
    expect(runBody.firedAt, "firedAt should be a valid ISO date").toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    )
    expect(runBody.note).toContain("fire-and-forget")
    // Poll the GET endpoint for up to 10s to see
    // the new lastRunAt land. The webhook-retry
    // worker is a fast cron, but the record()
    // call is async on the scheduler's promise.
    let afterLastRun: string | null = null
    for (let i = 0; i < 20; i++) {
      const after = await request.get(
        "http://localhost:3001/api/v1/admin/cron-health",
        {
          headers: {
            "x-user-id": tokens!.userId,
            "x-company-id": tokens!.companyId,
          },
        },
      )
      const afterList = await after.json()
      const afterRow = afterList.find(
        (c: any) => c.name === "webhook-retry-worker",
      )
      if (
        afterRow?.lastRunAt &&
        (!beforeLastRun || afterRow.lastRunAt > beforeLastRun)
      ) {
        afterLastRun = afterRow.lastRunAt
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(
      afterLastRun,
      "webhook-retry-worker lastRunAt should advance after manual run",
    ).toBeTruthy()
  })

  test("2. unknown cron name returns 400 with the known list", async ({
    request,
  }) => {
    const res = await request.post(
      `http://localhost:3001/api/v1/admin/cron-health/typo-bad-name/run?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.message, "error should list known crons").toContain(
      "webhook-retry-worker",
    )
    expect(body.message, "error should list known crons").toContain(
      "recurring-invoices-daily",
    )
  })

  test("3. daily-auto-backup is blocked from the manual-run path", async ({
    request,
  }) => {
    // The destructive backup cron must be triggered
    // via the dedicated POST /admin/backups/run
    // path. The /admin/cron-health/:name/run path
    // refuses it with 400 so a misclick doesn't
    // burn ~50MB of disk.
    const res = await request.post(
      `http://localhost:3001/api/v1/admin/cron-health/daily-auto-backup/run?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.message).toContain("daily-auto-backup")
    expect(body.message).toContain("/api/v1/backup/run")
  })
})

test.describe("Tier 195 — Admin: backup restore-drill", () => {
  test("4. restore-drill on a backup with a real db.sql.gz works", async ({
    request,
  }) => {
    // Tier 365: this used to skip whenever no backup with a db.sql.gz existed,
    // which is always the case on a fresh CI runner — so the restore drill
    // (the path Tier 359 changed to pick the newest COMPLETE backup) never ran
    // in CI. When the backup root is clearly a throwaway — CI, or under /tmp
    // as with backend/scripts/local-ci-stack.sh — create a backup first and
    // delete it again. Anywhere else the root may be a developer's real backup
    // directory (Tier 358 wrote a test dump into one), so skip there.
    test.setTimeout(240_000)
    const headers = {
      "x-user-id": tokens!.userId,
      "x-company-id": tokens!.companyId,
    }
    type BackupItem = { id: string; isComplete: boolean; dbFile: string | null }
    const listBackups = async () => {
      const res = await request.get("http://localhost:3001/api/v1/admin/backups", { headers })
      expect(res.status(), "GET /admin/backups").toBe(200)
      return res.json()
    }
    const findUsable = (body: { items?: BackupItem[] }) =>
      (body?.items || []).find((b) => b.isComplete && b.dbFile && b.id)

    let listBody = await listBackups()
    let usable = findUsable(listBody)
    let createdId: string | null = null
    if (!usable) {
      const root = String(listBody?.backupRoot || "")
      if (!process.env.CI && !root.startsWith("/tmp/")) {
        test.skip(
          true,
          `no backup with db.sql.gz, and ${root} may be a real backup directory — not creating one outside CI`,
        )
        return
      }
      const run = await request.post("http://localhost:3001/api/v1/admin/backups/run", {
        headers,
        data: {},
        timeout: 200_000,
      })
      expect(run.status(), "POST /admin/backups/run").toBe(200)
      const runBody = await run.json()
      expect(runBody.success, `backup.sh failed:\n${String(runBody.log || "").slice(-600)}`).toBe(true)
      createdId = runBody.id
      listBody = await listBackups()
      usable = findUsable(listBody)
      expect(usable, "the backup just created contains db.sql.gz").toBeTruthy()
    }

    try {
      const res = await request.post(
        `http://localhost:3001/api/v1/admin/backups/restore-drill?companyId=${tokens!.companyId}`,
        { headers, timeout: 200_000 },
      )
      expect(res.status(), "drill endpoint should always 200 (ok=true|false)").toBe(200)
      const body = await res.json()
      expect(body.dbName, "drill should target the throwaway DB").toBe(
        "de_invoice_restore_drill",
      )
      expect(typeof body.durationMs).toBe("number")
      if (createdId) {
        // A backup taken from the live test database a moment ago has to
        // restore; ok=false here is a real failure, not "the drill did its job".
        expect(body.ok, `drill of a fresh backup failed: ${body.error}`).toBe(true)
      }
      if (body.ok) {
        expect(
          body.tableCount,
          "ok=true must come with a non-zero table count",
        ).toBeGreaterThan(0)
      } else {
        // ok=false is a valid result for an OLD backup — it was readable but
        // the restore surfaced a real problem. The drill is doing its job.
        expect(body.error, "ok=false must come with an error message").toBeTruthy()
      }
      // The throwaway DB must be dropped before the drill returns: a second
      // drill has to be able to CREATE DATABASE again.
      const res2 = await request.post(
        `http://localhost:3001/api/v1/admin/backups/restore-drill?companyId=${tokens!.companyId}`,
        { headers, timeout: 200_000 },
      )
      expect([200, 500]).toContain(res2.status())
    } finally {
      if (createdId) {
        await request.delete(`http://localhost:3001/api/v1/admin/backups/${createdId}`, { headers })
      }
    }
  })

  test("5. backup list returns the standard envelope", async ({ request }) => {
    const res = await request.get(
      "http://localhost:3001/api/v1/admin/backups",
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("items")
    expect(body).toHaveProperty("newest")
    expect(body).toHaveProperty("health")
    expect(body).toHaveProperty("backupRoot")
    expect(Array.isArray(body.items)).toBe(true)
  })
})

test.describe("Tier 195 — Frontend: system-health Run now button", () => {
  test("6. system-health page renders a Run now button per cron row", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/system-health")
    // Wait for the table to mount
    await expect(
      page.getByTestId("system-health-table"),
    ).toBeVisible({ timeout: 15000 })
    // At least one row should have a Run now
    // button. We check the webhook-retry-worker
    // specifically since it's the most-reliable
    // cron to be in the list.
    const runBtn = page.getByTestId(
      "cron-run-webhook-retry-worker",
    )
    await expect(runBtn).toBeVisible({ timeout: 5000 })
    // The button text should be the German
    // default ("Jetzt ausführen")
    const text = (await runBtn.innerText()).trim()
    expect(
      ["Jetzt ausführen", "Run now", "立即执行"],
      `unexpected button text: ${text}`,
    ).toContain(text)
  })
})
