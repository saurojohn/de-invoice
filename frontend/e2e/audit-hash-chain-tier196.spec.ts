/**
 * Tier 196 — Berater audit-trail: hash chain + tamper detection
 *
 * Covers the new integrity-signature layer on
 * the AuditLog table:
 *
 *   1. POST /audit-logs/verify returns ok=true
 *      with a non-broken chain (after the
 *      Tier 196 rehashing step).
 *   2. GET /audit-logs/:id/verify returns
 *      verified=true on a clean row.
 *   3. Tamper detection: mutating a row's
 *      newData via raw SQL flips the chain
 *      status to ok=false with a brokenAt
 *      point that names the row id.
 *   4. The single-row verify endpoint reports
 *      verified=false for a tampered row.
 *   5. The /dashboard/audit page renders the
 *      "Audit-Kette verifizieren" button + a
 *      chain-status badge that flips red on
 *      tamper.
 *   6. The detail modal renders a "Verifizieren"
 *      button + a verified badge after one
 *      is fired.
 *
 * The tampered state is reset between tests so
 * we don't leave a broken chain for the next
 * tier's e2e to trip on.
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"
import { execFileSync } from "child_process"
// Tier 368: `path` was only needed to resolve the backend dir for the rehash
// beforeAll, which is gone.
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
    throw new Error(`Auth cache ${AUTH_CACHE} missing — run backend e2e first`)
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

// Tier 368: the rehash beforeAll is GONE.
//
// It used to run scripts/audit-rehash.ts before every test in this file,
// rewriting every hash and pointer to hand test 1 a clean baseline. That is
// exactly why the Tier 367 ordering defect hid here for ten tiers: the spec
// never exercised the order the application actually wrote, only the order the
// rehash imposed, so it stayed green while a freshly seeded database reported
// previous_hash_mismatch.
//
// Two changes make it unnecessary. Tier 367 made the application write a chain
// that verifies on its own (backend/e2e/170 asserts exactly that, with no
// re-hash and under concurrent writes), and test 3 below now restores the row
// it tampers with instead of leaving the chain broken for the next run.

// Raw psql helper (same pattern as the cashbook
// tier 194 spec).
function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      PG_CONTAINER,
      "psql",
      "-U",
      "de_invoice",
      "-d",
      "de_invoice",
      "-tA",
      "-c",
      sql,
    ],
    { encoding: "utf-8" },
  ).trim()
}

test.describe("Tier 196 — Audit hash chain", () => {
  test("1. verify endpoint reports ok=true for a clean chain", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    // Tier 366: rows written before the Decimal canonicalisation fix are
    // SHA-256-V1, new ones SHA-256-V2; the chain reports the newest signed
    // row's algorithm.
    expect(body.algorithm).toMatch(/^SHA-256-V[12]$/)
    expect(typeof body.totalRows).toBe("number")
    // The chain was re-hashed by the Tier 196
    // setup. We don't assert exact row counts
    // because other tier suites may have added
    // rows since. We just require ok=true and
    // brokenAt=null.
    expect(body.ok, `chain broken at ${JSON.stringify(body.brokenAt)}`).toBe(true)
    expect(body.brokenAt).toBeNull()
  })

  test("2. verify single returns verified=true on a row with a valid hash", async ({
    request,
  }) => {
    // Pick the most-recent row with a hash. The
    // exact id varies per run, but every such row
    // is a freshly-written, properly-hashed entry.
    // Tier 368: order by `seq`, not createdAt. createdAt is rounded to whole
    // seconds, so among same-second rows "most recent" was whatever the UUID
    // sort happened to return.
    const idOut = psql(
      `SELECT id FROM "AuditLog" WHERE "hash" IS NOT NULL ORDER BY seq DESC LIMIT 1;`,
    )
    const id = idOut.split("\n")[0].trim()
    expect(id.length, "expected a row with a hash to exist").toBeGreaterThan(0)
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/${id}/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.signed, "row should be signed").toBe(true)
    expect(
      body.verified,
      `verified should be true; stored=${body.storedHash?.slice(0, 16)} recomputed=${body.recomputedHash?.slice(0, 16)}`,
    ).toBe(true)
    expect(body.storedHash).toBe(body.recomputedHash)
    // Tier 366: rows written before the Decimal canonicalisation fix are
    // SHA-256-V1, new ones SHA-256-V2; the chain reports the newest signed
    // row's algorithm.
    expect(body.algorithm).toMatch(/^SHA-256-V[12]$/)
  })

  test("3. verify single detects tampering (newData mutated via raw SQL)", async ({
    request,
  }) => {
    // First: ensure chain is ok so we can prove
    // that the SQL mutation is what flipped it.
    const before = await request.get(
      `http://localhost:3001/api/v1/audit-logs/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const beforeBody = await before.json()
    // Tier 368: this used to `test.skip()` when the chain was already broken,
    // which turned a real regression into a green run. Since Tier 367 the
    // application writes a chain that verifies on its own, and this test now
    // restores the row it tampers with, so a broken chain here is a genuine
    // failure and must fail.
    expect(
      beforeBody.ok,
      `chain must be intact before tampering; brokenAt=${JSON.stringify(beforeBody.brokenAt)}`,
    ).toBe(true)
    // Pick the newest signed row by `seq` so the tampered row is the chain's
    // tail. Tier 368: this was `ORDER BY "createdAt" DESC` — and createdAt is
    // rounded to whole seconds, so among same-second rows it could return a
    // MIDDLE row, which is exactly what the old comment said it wanted to
    // avoid: tampering a middle row also breaks the following rows' pointers.
    const id = psql(
      `SELECT id FROM "AuditLog" WHERE "hash" IS NOT NULL ORDER BY seq DESC LIMIT 1;`,
    ).split("\n")[0].trim()
    // Sanity: single-row verify should pass
    // before tampering.
    const pre = await request.get(
      `http://localhost:3001/api/v1/audit-logs/${id}/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const preBody = await pre.json()
    // Tier 368: was a test.skip() — the same silent-green trap as the chain
    // check above. Since Tier 367 a freshly written row verifies on its own, so
    // a mismatch here is a real regression and has to fail.
    expect(
      preBody.verified,
      `the row must verify before we tamper with it; stored=${preBody.storedHash?.slice(0, 16)} recomputed=${preBody.recomputedHash?.slice(0, 16)}`,
    ).toBe(true)
    // Tamper: replace the newData JSONB value
    // with a DIFFERENT shape from the current
    // one (which may already be the tamper
    // value from a prior test run). We use
    // a unique discriminator so a re-run on
    // a chain that already had the row
    // tampered still flips the hash.
    // Tier 368: save the original payload so this test can put it back. It used
    // to leave the chain permanently broken and rely on the beforeAll rehash to
    // launder it — precisely what hid the Tier 367 ordering defect for ten tiers.
    const originalNewData = psql(
      `SELECT COALESCE("newData"::text, '') FROM "AuditLog" WHERE "id" = '${id}';`,
    )
    const tamperValue = `{"tampered_at_${Date.now()}": true}`
    psql(
      `UPDATE "AuditLog" SET "newData" = '${tamperValue}'::jsonb WHERE "id" = '${id}';`,
    )
    // The chain should now report brokenAt = this
    // row, reason = hash_mismatch.
    const after = await request.get(
      `http://localhost:3001/api/v1/audit-logs/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const afterBody = await after.json()
    expect(
      afterBody.ok,
      `chain should be broken after tampering; brokenAt=${JSON.stringify(afterBody.brokenAt)}`,
    ).toBe(false)
    expect(afterBody.brokenAt, "brokenAt should name the tampered row").not.toBeNull()
    expect(afterBody.brokenAt!.id).toBe(id)
    expect(afterBody.brokenAt!.reason).toBe("hash_mismatch")
    // And the single-row verify also reports
    // verified=false on the tampered row.
    const oneVerify = await request.get(
      `http://localhost:3001/api/v1/audit-logs/${id}/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const oneBody = await oneVerify.json()
    expect(oneBody.signed).toBe(true)
    expect(oneBody.verified).toBe(false)
    expect(oneBody.storedHash).not.toBe(oneBody.recomputedHash)
    // Tier 368: restore the row and prove the chain is whole again, so this
    // spec leaves no tampered row behind for the next run. (A SQL string
    // literal escapes a quote by doubling it; psql is invoked via execFileSync,
    // so no shell quoting is involved.)
    if (originalNewData === "") {
      psql(`UPDATE "AuditLog" SET "newData" = NULL WHERE "id" = '${id}';`)
    } else {
      psql(
        `UPDATE "AuditLog" SET "newData" = '${originalNewData.replace(/'/g, "''")}'::jsonb WHERE "id" = '${id}';`,
      )
    }
    const restored = await request.get(
      `http://localhost:3001/api/v1/audit-logs/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const restoredBody = await restored.json()
    expect(
      restoredBody.ok,
      `chain should be intact again after restoring; brokenAt=${JSON.stringify(restoredBody.brokenAt)}`,
    ).toBe(true)
  })

  test("4. frontend audit page renders the chain verify button + badge", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/audit")
    // The verify button + status row are the
    // Tier 196 additions. They sit between the
    // header and the stats cards. Wait for the
    // button to mount, then click it to fire
    // the verify request.
    const verifyBtn = page.getByTestId("audit-verify-chain")
    await expect(verifyBtn).toBeVisible({ timeout: 15000 })
    // The badge isn't present until the first
    // verify has fired (the page mounts with
    // chainVerify=null). Click and wait.
    await verifyBtn.click()
    // The badge text should land. We tolerate
    // either the green "Kette intakt" or the
    // red "Kette unterbrochen" — both are
    // legitimate depending on whether a prior
    // test left the chain in a tampered state.
    // The text includes a "(N/M)" suffix so we
    // check via substring, not exact match.
    const badge = page.getByTestId("audit-chain-badge")
    await expect(badge).toBeVisible({ timeout: 15000 })
    const text = (await badge.innerText()).trim()
    const matchesAny =
      text.includes("Kette intakt") ||
      text.includes("Kette unterbrochen") ||
      text.includes("Chain intact") ||
      text.includes("Chain broken") ||
      text.includes("链完整") ||
      text.includes("链已断开")
    expect(
      matchesAny,
      `unexpected badge text: ${text}`,
    ).toBe(true)
  })
})
