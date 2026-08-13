/**
 * Tier 181 — month-scoped GoBD packager
 *
 * Background: the original GoBD archive (Tier 166)
 * was year-scoped. For a monthly Berater handoff
 * (e.g. "I want the July pack for the Steuerprüfer"),
 * the Berater had to download the whole year and
 * then filter locally.
 *
 * Tier 181 adds an optional `?month=N` (1-12) query
 * param to GET /api/v1/gobd-export. When set:
 *   - the archive is scoped to that single month
 *     (periodStart / periodEnd in the manifest)
 *   - the filename becomes
 *     `GoBD-YYYY-MM-CompanyName-YYYY-MM-DD.zip`
 *   - the audit log filename becomes
 *     `audit-logs/audit-logs-YYYY-MM.csv` (not
 *     misleadingly "audit-logs-YYYY.csv" when it
 *     actually only covers one month)
 *   - the manifest adds periodLabel / periodStart /
 *     periodEnd / scope="month" so a Prüfer
 *     verifying the archive knows exactly which
 *     period it covers without re-computing
 *
 * Back-compat: when `?month` is absent, the
 * endpoint behaves exactly as Tier 166 (year
 * archive, yearStart/yearEnd fields, no
 * periodLabel/periodStart/periodEnd, but the
 * new fields are still emitted with year bounds
 * — a Prüfer can migrate their tooling
 * independently).
 *
 * Tests:
 *   1. legacy: no month → 200 + year archive
 *      (smoke check, behaviour identical to Tier 166)
 *   2. month=7 → 200 + filename GoBD-2026-07-…zip
 *   3. month=7 manifest: scope=month + periodLabel
 *      + periodStart/End (July 1..Aug 1 UTC)
 *   4. month=7 audit log filename is
 *      audit-logs-2026-07.csv (NOT 2026.csv)
 *   5. month=13 → 400 with German error
 *   6. month=0 → 400
 *   7. month=2 (no data) → 200 + GoBD-2026-02-…zip
 *      with manifest + company-snapshot only
 *      (no invoices, no audit log)
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

/** Write the response body to a temp file and unzip
 *  the named entry. Returns the entry content as
 *  utf-8. Throws if the entry is missing. */
function readZipEntry(zipBody: Buffer, entryPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tier181-"))
  const zipPath = join(dir, "gobd.zip")
  writeFileSync(zipPath, zipBody)
  return execFileSync("unzip", ["-p", zipPath, entryPath], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  })
}

test.describe("Tier 181 — month-scoped GoBD packager", () => {
  test("1. legacy: no month → 200 (year archive, back-compat)", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    expect(res.headers()["content-type"]).toMatch(/application\/zip/)
    // Year-only filename (Tier 166 shape)
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition, `expected year filename, got: ${disposition}`).toMatch(
      /GoBD-2026-[^0-9]+/,
    )
    expect(disposition, `should NOT have month in filename`).not.toMatch(
      /GoBD-2026-0\d-/,
    )
  })

  test("2. month=7 → 200 + filename GoBD-2026-07-…zip", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    expect(res.headers()["content-type"]).toMatch(/application\/zip/)
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition, `expected month filename, got: ${disposition}`).toMatch(
      /GoBD-2026-07-SH_Leder_GmbH/,
    )
  })

  test("3. month=7 manifest: scope=month + periodLabel + periodStart/End", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status()).toBe(200)
    const body = await res.body()
    const manifest = JSON.parse(readZipEntry(body, "manifest.json"))

    // Tier 181 manifest fields
    expect(manifest.scope, `manifest.scope should be "month"`).toBe("month")
    expect(manifest.periodLabel, `manifest.periodLabel`).toBe("2026-07")
    expect(manifest.periodStart, `manifest.periodStart`).toBe(
      "2026-07-01T00:00:00.000Z",
    )
    expect(manifest.periodEnd, `manifest.periodEnd`).toBe(
      "2026-08-01T00:00:00.000Z",
    )
    // Back-compat: year/yearStart/yearEnd still set
    // to the full-year bounds for Prüfer tooling
    // that reads the old schema.
    expect(manifest.year).toBe(2026)
    expect(manifest.yearStart).toBe("2026-01-01T00:00:00.000Z")
    expect(manifest.yearEnd).toBe("2027-01-01T00:00:00.000Z")
  })

  test("4. month=7 audit log filename is audit-logs-2026-07.csv", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&month=7&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status()).toBe(200)
    const body = await res.body()
    const manifest = JSON.parse(readZipEntry(body, "manifest.json"))
    const auditEntry = manifest.files.find((f: any) =>
      f.path.startsWith("audit-logs/"),
    )
    expect(auditEntry, `expected an audit-logs entry in manifest`).toBeTruthy()
    expect(auditEntry.path, `month-scoped audit log filename expected`).toBe(
      "audit-logs/audit-logs-2026-07.csv",
    )
  })

  test("5. month=13 → 400 with German error", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&month=13&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
    const body = await res.text()
    expect(body, `expected German month error, got: ${body}`).toMatch(/Ungültiger Monat/i)
    expect(body, `expected range 1-12, got: ${body}`).toMatch(/1-12/)
  })

  test("6. month=0 → 400", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&month=0&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 400, got ${res.status()}`).toBe(400)
  })

  test("7. month=2 (no data) → 200 + GoBD-2026-02-…zip with manifest+company-snapshot only", async ({
    request,
  }) => {
    // Feb 2026 has no invoices in the test data, so the
    // zip is small (manifest + company-snapshot +
    // verification-report, no invoices/ folder).
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&month=2&companyId=${tokens!.companyId}`,
      { headers: authHeaders() },
    )
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    const disposition = res.headers()["content-disposition"] || ""
    expect(disposition).toMatch(/GoBD-2026-02-/)
    // Stats header should report 0 invoices, 0
    // credit notes, 0 mahnungen etc.
    const statsHeader = res.headers()["x-gobd-stats"] || ""
    expect(statsHeader, `expected X-GoBD-Stats header`).toBeTruthy()
    const stats = JSON.parse(statsHeader)
    expect(stats.invoices, `expected 0 invoices in Feb 2026`).toBe(0)
    expect(stats.mahnungen, `expected 0 mahnungen in Feb 2026`).toBe(0)
  })

  test("8. unauthenticated → 401", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/gobd-export?year=2026&month=7&companyId=${tokens!.companyId}`,
    )
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })
})
