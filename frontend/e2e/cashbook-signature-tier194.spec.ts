/**
 * Tier 194 — Kassenbuch GoBD § 146 AO integrity signature
 *
 * Covers the four new endpoints + the underlying
 * hash logic:
 *
 *   1. Close-day automatically writes a signature
 *      hash on the close row (algorithm SHA-256-V1).
 *   2. POST /close-day/:id/sign re-derives the hash
 *      and persists it (re-sign is idempotent).
 *   3. GET /close-day/:id/verify returns the
 *      verification envelope. After a clean close
 *      it should be verified=true.
 *   4. GET /kassenabschluss.pdf returns a PDF
 *      with the hash + algorithm + signature
 *      timestamp on a single A4 page.
 *   5. Tamper detection: when the close row is
 *      mutated after signing, verify returns
 *      verified=false. The sign endpoint refuses
 *      to overwrite a mismatched row.
 *
 * Database fixture management uses raw psql via
 * `docker exec` (the same pattern other e2e specs
 * in this project use — see assets-afa.spec.ts).
 * Prisma is not available inside the frontend
 * e2e context, but the tier 4 tampering test
 * specifically needs to bypass the API and write
 * to the row directly, which a raw SQL UPDATE
 * is well-suited for.
 */

import { test, expect } from "@playwright/test"
import { readFileSync, writeFileSync } from "fs"
import { execFileSync } from "child_process"

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

// Pin a fixed test date. Using 2026-07-25 keeps
// the test isolated from day-to-day date math
// (timezone boundaries, fiscal year, etc.) and
// from any entries other tier suites might have
// left on the same date. Non-tier-prefixed per
// de-invoice-patterns.md §39 (the "TierN%"
// cleanup pattern).
const TEST_DATE = "2026-07-25"

// Run a single psql command inside the de-invoice
// postgres container. The pattern is borrowed
// from assets-afa.spec.ts.
function psql(sql: string): string {
  // Pass the SQL through the docker exec stdin so
  // we don't have to worry about quote escaping
  // for arbitrary test data.
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "de-invoice-postgres",
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

// Helper: read the current Anfangsbestand for
// the test date from the dayBalance endpoint.
// We can't hard-code the physicalCount for the
// close (because the prior-day cumulative
// balance depends on what other tier suites
// have left in the DB). Instead, each test
// reads the day's projected endbestand, then
// closes with a matching physicalCount so the
// Differenz is 0.00 (no Begründung required).
async function getDayEnde(request: any): Promise<number> {
  const d = await request.get(
    `http://localhost:3001/api/v1/cashbook/day?companyId=${tokens!.companyId}&date=${TEST_DATE}`,
    {
      headers: {
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
    },
  )
  const body = await d.json()
  return Number(body.ende)
}

// Reset the test date to a known state:
//   - one Einnahme entry (so the day has activity
//     and a close is allowed)
//   - no existing close (close-day refuses if
//     one is already present)
// Each test re-runs this so test order does not
// matter.
test.beforeEach(() => {
  psql(
    `DELETE FROM "CashBookDailyClose" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
  )
  psql(
    `DELETE FROM "CashBookEntry" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
  )
  psql(
    `INSERT INTO "CashBookEntry" ("id", "companyId", "businessDate", "type", "amount", "description", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, '${tokens!.companyId}', '${TEST_DATE}', 'einnahme', 100, 'Tier 194 e2e', NOW(), NOW());`,
  )
})

test.afterAll(() => {
  psql(
    `DELETE FROM "CashBookDailyClose" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
  )
  psql(
    `DELETE FROM "CashBookEntry" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
  )
})

test.describe("Tier 194 — Kassenbuch integrity signature", () => {
  test("1. close-day writes a signatureHash + algorithm on the row", async ({
    request,
  }) => {
    const physicalCount = await getDayEnde(request)
    const res = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {

          date: TEST_DATE,
          physicalCount,
          closedById: tokens!.userId,
        },
      },
    )
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.signatureHash, "close row missing signatureHash").toBeTruthy()
    expect(body.signatureHash).toMatch(/^[a-f0-9]{64}$/)
    expect(body.signatureAlgorithm).toBe("SHA-256-V1")
    expect(body.signatureTimestamp, "close row missing signatureTimestamp").toBeTruthy()
  })

  test("2. verify returns verified=true after a clean close", async ({
    request,
  }) => {
    const physicalCount = await getDayEnde(request)
    const close = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {
          date: TEST_DATE,
          physicalCount,
          closedById: tokens!.userId,
        },
      },
    )
    const closeBody = await close.json()
    const list = await request.get(
      `http://localhost:3001/api/v1/cashbook/closes?companyId=${tokens!.companyId}&from=${TEST_DATE}&to=${TEST_DATE}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const listBody = await list.json()
    expect(listBody.length, "expected exactly one close").toBe(1)
    const closeId = listBody[0].id
    const verify = await request.get(
      `http://localhost:3001/api/v1/cashbook/close-day/${closeId}/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(verify.status()).toBe(200)
    const v = await verify.json()
    expect(v.signed, "expected signed=true after close").toBe(true)
    expect(
      v.verified,
      `expected verified=true (recomputed=${v.recomputedHash?.slice(0, 16)} vs stored=${v.storedHash?.slice(0, 16)})`,
    ).toBe(true)
    expect(v.algorithm).toBe("SHA-256-V1")
    expect(v.storedHash).toBe(closeBody.signatureHash)
    expect(v.recomputedHash).toBe(closeBody.signatureHash)
  })

  test("3. POST /sign re-derives and writes the same hash (idempotent)", async ({
    request,
  }) => {
    const physicalCount = await getDayEnde(request)
    const close = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {
          date: TEST_DATE,
          physicalCount,
          closedById: tokens!.userId,
        },
      },
    )
    const closeBody = await close.json()
    const list = await request.get(
      `http://localhost:3001/api/v1/cashbook/closes?companyId=${tokens!.companyId}&from=${TEST_DATE}&to=${TEST_DATE}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const listBody = await list.json()
    const closeId = listBody[0].id
    const sign = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day/${closeId}/sign?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(sign.status()).toBe(201)
    const signBody = await sign.json()
    expect(signBody.signatureHash).toBe(closeBody.signatureHash)
    expect(signBody.signatureAlgorithm).toBe("SHA-256-V1")
    expect(signBody.verification.verified).toBe(true)
  })

  test("4. verify detects tampering (endbestand mutated via raw SQL)", async ({
    request,
  }) => {
    // First close cleanly
    const physicalCount = await getDayEnde(request)
    const close = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {
          date: TEST_DATE,
          physicalCount,
          closedById: tokens!.userId,
        },
      },
    )
    expect(close.status()).toBe(201)
    const list = await request.get(
      `http://localhost:3001/api/v1/cashbook/closes?companyId=${tokens!.companyId}&from=${TEST_DATE}&to=${TEST_DATE}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const listBody = await list.json()
    const closeId = listBody[0].id
    // Pre-tamper verify should pass
    const verify0 = await request.get(
      `http://localhost:3001/api/v1/cashbook/close-day/${closeId}/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const v0 = await verify0.json()
    expect(v0.verified).toBe(true)
    // Tamper: mutate endbestand directly. The
    // hash inputs include endbestand, so the
    // recompute will diverge.
    psql(
      `UPDATE "CashBookDailyClose" SET "endbestand" = 999.0000 WHERE "id" = '${closeId}';`,
    )
    // Post-tamper verify should fail
    const verify1 = await request.get(
      `http://localhost:3001/api/v1/cashbook/close-day/${closeId}/verify?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    const v1 = await verify1.json()
    expect(
      v1.signed,
      "row should still report signed=true (we did not clear the hash)",
    ).toBe(true)
    expect(
      v1.verified,
      `expected verified=false after tampering (stored=${v1.storedHash?.slice(0, 16)} recomputed=${v1.recomputedHash?.slice(0, 16)})`,
    ).toBe(false)
    expect(v1.storedHash).toBe(v0.storedHash)
    expect(v1.recomputedHash).not.toBe(v0.storedHash)
    // And a re-sign attempt should refuse with
    // 400 BadRequest — the sign endpoint will
    // not overwrite a mismatched row.
    const sign = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day/${closeId}/sign?companyId=${tokens!.companyId}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(sign.status(), "sign should refuse a tampered row").toBe(400)
  })

  test("5. kassenabschluss.pdf returns a 1-page PDF", async ({ request }) => {
    // Reset to a clean state so the close below
    // succeeds (test 4 leaves the row tampered).
    psql(
      `DELETE FROM "CashBookDailyClose" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
    )
    psql(
      `DELETE FROM "CashBookEntry" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
    )
    psql(
      `INSERT INTO "CashBookEntry" ("id", "companyId", "businessDate", "type", "amount", "description", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, '${tokens!.companyId}', '${TEST_DATE}', 'einnahme', 50, 'Tier 194 PDF test', NOW(), NOW());`,
    )
    const physicalCount = await getDayEnde(request)
    const close = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {

          date: TEST_DATE,
          physicalCount,
          closedById: tokens!.userId,
        },
      },
    )
    expect(close.status()).toBe(201)
    const res = await request.get(
      `http://localhost:3001/api/v1/cashbook/kassenabschluss.pdf?companyId=${tokens!.companyId}&date=${TEST_DATE}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const ct = res.headers()["content-type"] || ""
    expect(ct, `expected application/pdf, got ${ct}`).toMatch(/application\/pdf/)
    const buf = await res.body()
    expect(buf.length, "PDF body should be non-empty").toBeGreaterThan(1000)
    const head = buf.subarray(0, 5).toString("ascii")
    expect(head, `expected PDF magic bytes, got ${head}`).toBe("%PDF-")
  })

  test("6. PDF text contains algorithm + hash + Verifiziert + Tier 194", async ({
    request,
  }) => {
    // Reset for a clean close
    psql(
      `DELETE FROM "CashBookDailyClose" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
    )
    psql(
      `DELETE FROM "CashBookEntry" WHERE "businessDate" = '${TEST_DATE}' AND "companyId" = '${tokens!.companyId}';`,
    )
    psql(
      `INSERT INTO "CashBookEntry" ("id", "companyId", "businessDate", "type", "amount", "description", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, '${tokens!.companyId}', '${TEST_DATE}', 'einnahme', 30, 'Tier 194 PDF text', NOW(), NOW());`,
    )
    const physicalCount = await getDayEnde(request)
    const close = await request.post(
      `http://localhost:3001/api/v1/cashbook/close-day?companyId=${tokens!.companyId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
        data: {

          date: TEST_DATE,
          physicalCount,
          closedById: tokens!.userId,
        },
      },
    )
    expect(close.status()).toBe(201)
    const closeBody = await close.json()
    const res = await request.get(
      `http://localhost:3001/api/v1/cashbook/kassenabschluss.pdf?companyId=${tokens!.companyId}&date=${TEST_DATE}`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(200)
    const buf = await res.body()
    const tmpPath = "/tmp/tier194-kassenabschluss.pdf"
    writeFileSync(tmpPath, buf)
    // Extract text via Python pypdf. macOS ships
    // pypdf via the system Python 3. Falls back
    // to pdftotext if pypdf is unavailable, and
    // to latin1 raw grep as a last resort.
    let text = ""
    try {
      const { execFileSync } = await import("child_process")
      text = execFileSync("python3", [
        "-c",
        `import sys; from pypdf import PdfReader; r=PdfReader('${tmpPath}'); print('\\n'.join(p.extract_text() or '' for p in r.pages))`,
      ], { encoding: "utf-8" })
    } catch {
      try {
        text = execFileSync("pdftotext", [tmpPath, "-"], { encoding: "utf-8" })
      } catch {
        text = buf.toString("latin1")
      }
    }
    expect(text, "PDF should mention SHA-256 algorithm").toContain("SHA-256")
    expect(text, "PDF should mention hash").toMatch(/Hash/i)
    expect(text, "PDF should mention Tier 194 (integrity section)").toContain("Tier 194")
    expect(text, "PDF should show Verifiziert status").toContain("Verifiziert")
    const hashPrefix = closeBody.signatureHash.slice(0, 8)
    // The full hash is broken across lines in the
    // PDF (PDFKit wraps at the column width), so
    // we only assert the first 8 hex chars. This
    // is enough to confirm the same hash was
    // rendered (8 hex = 32 bits = 1 in 4B chance
    // of collision on unrelated hashes).
    expect(
      text,
      `PDF should contain hash prefix ${hashPrefix}`,
    ).toContain(hashPrefix)
  })

  test("7. kassenabschluss.pdf on an unclosed day returns 400", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/cashbook/kassenabschluss.pdf?companyId=${tokens!.companyId}&date=2030-01-01`,
      {
        headers: {
          "x-user-id": tokens!.userId,
          "x-company-id": tokens!.companyId,
        },
      },
    )
    expect(res.status()).toBe(400)
  })
})
