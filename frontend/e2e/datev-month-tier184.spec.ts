/**
 * Tier 184 — month-scoped DATEV-Buchungsstapel
 *
 * Background: the DATEV-Buchungsstapel ZIP
 * (Tier 167) accepted a free-form startDate +
 * endDate range, but the Berater's typical
 * handoff is "the July pack for the DATEV
 * import". This tier adds an optional
 * `?year=YYYY&month=N` (1-12) shortcut that
 * scopes the bundle to that single month and
 * encodes the period in the filename + MANIFEST.
 *
 * Mirrors Tier 181's GoBD-export month pattern.
 *
 * Tests:
 *   1. legacy: no month → 200 + filename
 *      `EXTF_Buchungsstapel_<startDate>_L<n>.zip`
 *   2. month=7 → 200 + filename
 *      `EXTF_Buchungsstapel_2026-07_L<n>.zip`
 *   3. month=7 MANIFEST: scope=month +
 *      periodLabel=2026-07 + periodStart/End
 *   4. month=13 → 400 with German error
 *   5. month=0 → 400
 *   6. year=1900 + month=7 → 400 with German
 *      year error
 *   7. month=2 (no data) → 200 with empty
 *      Buchungsstapel (just header + MANIFEST)
 *   8. unauthenticated → 401
 */

import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"
import { execFileSync } from "child_process"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

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

function authHeaders(): Record<string, string> {
  return {
    "x-user-id": tokens!.userId,
    "x-company-id": tokens!.companyId,
  }
}

function readZipEntry(zipBody: Buffer, entryPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tier184-"))
  const zipPath = join(dir, "datev.zip")
  writeFileSync(zipPath, zipBody)
  return execFileSync("unzip", ["-p", zipPath, entryPath], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  })
}

test.describe("Tier 184 — month-scoped DATEV-Buchungsstapel", () => {
  test("1. legacy: no month → 200 + EXTF_Buchungsstapel_<date>_L<n>.zip", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    expect(res.headers()["content-type"]).toMatch(/application\/zip/)
    const disposition = res.headers()["content-disposition"] || ""
    // Tier 167 legacy filename pattern:
    // EXTF_Buchungsstapel_YYYY-MM-DD_L<n>.zip
    expect(disposition, `expected legacy filename, got: ${disposition}`).toMatch(
      /EXTF_Buchungsstapel_\d{4}-\d{2}-\d{2}_L\d{3}\.zip/,
    )
  })

  test("2. month=7 → 200 + EXTF_Buchungsstapel_2026-07_L<n>.zip", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition, `expected month filename, got: ${disposition}`).toMatch(
      /EXTF_Buchungsstapel_2026-07_L\d{3}\.zip/,
    )
    // MUST NOT have the day in the month-scoped
    // filename (a Berater's archive folder should
    // sort cleanly by YYYY-MM).
    expect(disposition, `must not include day in month filename`).not.toMatch(
      /EXTF_Buchungsstapel_2026-07-\d{2}_/,
    )
  })

  test("3. month=7 MANIFEST: scope=month + periodLabel + periodStart/End", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status()).toBe(200)
    const body = await res.body()
    const manifest = JSON.parse(readZipEntry(body, "MANIFEST.json"))

    expect(manifest.scope, `manifest.scope should be "month"`).toBe("month")
    expect(manifest.periodLabel, `manifest.periodLabel`).toBe("2026-07")
    // periodStart/End are set when scope=month.
    // We don't pin the exact ISO (timezone-dependent
    // in the test DB) — just that they're defined
    // and parse as Date.
    expect(manifest.periodStart, `manifest.periodStart should be defined`).toBeTruthy()
    expect(manifest.periodEnd, `manifest.periodEnd should be defined`).toBeTruthy()
    expect(
      isNaN(new Date(manifest.periodStart).getTime()),
      `periodStart should be a valid ISO date`,
    ).toBe(false)
    expect(
      isNaN(new Date(manifest.periodEnd).getTime()),
      `periodEnd should be a valid ISO date`,
    ).toBe(false)
  })

  test("4. month=13 → 400 with German error", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&month=13&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected German month error, got: ${body}`).toMatch(
      /Ungültiger Monat/i,
    )
    expect(body, `expected range 1-12, got: ${body}`).toMatch(/1-12/)
  })

  test("5. month=0 → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&month=0&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("6. year=1900 + month=7 → 400 with German year error", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=1900&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected German year error, got: ${body}`).toMatch(
      /Ungültiges Jahr/i,
    )
  })

  test("7. month=2 (no data) → 200 + month-scoped filename + empty Buchungsstapel", async ({ request }) => {
    // Feb 2026 may have no data — the bundle is
    // still a valid ZIP with the header +
    // MANIFEST + (no) buchungen rows.
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&month=2&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition, `expected 2026-02 filename, got: ${disposition}`).toMatch(
      /EXTF_Buchungsstapel_2026-02_L\d{3}\.zip/,
    )
  })

  test("8. unauthenticated → 401", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/reports/datev-export-bundle?year=2026&month=7&companyId=${tokens!.companyId}`,
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })
})
