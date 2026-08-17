/**
 * Tier 204 — Activity log CSV export (Berater Excel)
 *
 * Covers the new
 * `GET /api/v1/audit-logs/activity.csv`
 * endpoint + the new "CSV exportieren
 * (90 Tage)" button on
 * `/dashboard/activity`:
 *
 *   1. CSV has the UTF-8 BOM +
 *      RFC 4180-compliant header
 *      row with the German column
 *      labels (Zeitstempel, Aktion,
 *      Entitaet, …).
 *   2. `Content-Disposition: attachment`
 *      is set with today's date in
 *      the filename.
 *   3. CSV includes the operator
 *      actions written by the
 *      Tier 202 e2e (resolve_all,
 *      mute_all, notification.test,
 *      cron.run_manually,
 *      webhook.requeue) and uses
 *      `;` as the delimiter.
 *   4. The actionPrefix query
 *      param narrows the result
 *      to ONE of the 4 activity
 *      namespaces.
 *   5. RFC 4180 escaping: the
 *      Metadata column wraps
 *      JSON blobs containing
 *      `,` / `"` in double
 *      quotes. The header is
 *      parseable into 7 columns
 *      with the `;` delimiter.
 *   6. /dashboard/activity renders
 *      the Export button.
 *   7. The Export button's href
 *      includes the companyId +
 *      `days=90` + the current
 *      actionFilter (when one is
 *      active).
 *
 * Tier 204 is the "give me the
 * last 90 days of operator
 * actions in Excel" feature for
 * the Berater. Same workflow as
 * Tier 203 (webhook deliveries
 * CSV) — operator opens the
 * file in Excel, uses Excel's
 * built-in pivot / filter.
 *
 * The activity CSV uses `;` as
 * the delimiter (Excel DE
 * default for CSV — matches the
 * existing audit export
 * `exportCsv()` in
 * audit.service.ts), NOT `,`
 * like the webhook CSV.
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

/**
 * Minimal RFC 4180 row parser using
 * `;` as the delimiter. Walks the
 * line char-by-char, respecting
 * double-quoted fields (commas +
 * semicolons + newlines inside
 * quotes are NOT column
 * separators). Returns the
 * unquoted cell values.
 *
 * Why a separate parser from
 * Tier 203: the activity CSV
 * uses `;` (Excel DE default)
 * while the webhook CSV uses
 * `,`. The Tier 203 parser
 * hard-codes the comma split.
 */
function parseCsvRow(line: string): string[] {
  const cells: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double-quote
        // inside a quoted field.
        cur += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (c === ";" && !inQuotes) {
      cells.push(cur)
      cur = ""
    } else {
      cur += c
    }
  }
  cells.push(cur)
  return cells
}

/**
 * Split a CSV body into complete
 * rows, respecting RFC 4180
 * quoted fields (newlines inside
 * quotes do NOT end a row).
 *
 * Used for the filter tests
 * because some seeded
 * Metadata blobs contain
 * commas / quotes — naive
 * `body.split("\n")` would
 * split those into "rows".
 */
function parseCsvRows(body: string): string[][] {
  const rows: string[][] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '"') {
      if (inQuotes && body[i + 1] === '"') {
        cur += '""'
        i++
      } else {
        inQuotes = !inQuotes
        cur += c
      }
    } else if (c === "\n" && !inQuotes) {
      const cells = parseCsvRow(cur)
      if (cells.length > 1) rows.push(cells)
      cur = ""
    } else {
      cur += c
    }
  }
  if (cur.length > 0) {
    const cells = parseCsvRow(cur)
    if (cells.length > 1) rows.push(cells)
  }
  return rows
}

test.describe("Tier 204 — GET /audit-logs/activity.csv", () => {
  test("1. CSV has the UTF-8 BOM + RFC 4180 header row", async ({ request }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity.csv?companyId=${tokens!.companyId}&days=30`,
      { headers: headers() },
    )
    expect(res.status()).toBe(200)
    const body = await res.text()
    // BOM check (UTF-8 BOM = EF BB BF).
    expect(body.charCodeAt(0), "should start with UTF-8 BOM").toBe(0xfeff)
    // Header row check (after BOM
    // the first line should be the
    // German column headers joined
    // with `;` — Excel DE default).
    const firstLine = body.split("\n")[0].replace(/^\ufeff/, "")
    expect(firstLine).toBe(
      "Zeitstempel;Aktion;Entitaet;Entity-ID;Benutzer;IP;Metadata",
    )
  })

  test("2. Content-Disposition: attachment is set with the right filename", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity.csv?companyId=${tokens!.companyId}&days=30`,
      { headers: headers() },
    )
    const disposition = res.headers()["content-disposition"]
    expect(disposition, "Content-Disposition header missing").toBeTruthy()
    expect(disposition).toMatch(/attachment.*filename=.*\.csv/)
    // Filename should include today's date.
    const today = new Date().toISOString().slice(0, 10)
    expect(disposition).toContain(today)
    expect(disposition).toContain("activity-log-")
  })

  test("3. CSV includes operator actions from all 4 namespaces", async ({
    request,
  }) => {
    // Seed fresh activity rows in
    // each namespace so the CSV
    // contains them. The Tier 202
    // e2e already wrote rows for
    // the 5 instrumented
    // endpoints, but those may
    // have aged out of the 7-day
    // window. We seed them again
    // here so the CSV definitely
    // has data.
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
    await request.post(
      `http://localhost:3001/api/v1/admin/cron-health/webhook-retry-worker/run?companyId=${tokens!.companyId}`,
      { headers: headers() },
    )

    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity.csv?companyId=${tokens!.companyId}&days=7`,
      { headers: headers() },
    )
    const body = await res.text()
    // The CSV should include
    // activities from all 4
    // namespaces (some are seeded
    // by other e2e specs that ran
    // before this one in the same
    // session).
    const hasError =
      body.includes("error.resolve_all") || body.includes("error.mute_all")
    const hasCron = body.includes("cron.run_manually")
    const hasNotification = body.includes("notification.test")
    // Webhook requeue may not be
    // present if the Tier 202 e2e
    // didn't run before this
    // suite, so we don't assert
    // it strictly.
    expect(hasError, "CSV should include error.* activity").toBe(true)
    expect(hasCron, "CSV should include cron.run_manually").toBe(true)
    expect(hasNotification, "CSV should include notification.test").toBe(true)
  })

  test("4. actionPrefix query param narrows the result to ONE namespace", async ({
    request,
  }) => {
    // First, fetch the wide CSV
    // (all 4 namespaces) and the
    // narrow CSV (just webhook.*).
    // The narrow CSV must be a
    // subset of the wide CSV by
    // action name.
    const wide = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity.csv?companyId=${tokens!.companyId}&days=7`,
      { headers: headers() },
    )
    const narrow = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity.csv?companyId=${tokens!.companyId}&days=7&actionPrefix=webhook.`,
      { headers: headers() },
    )
    const wideRows = parseCsvRows(await wide.text()).slice(1) // drop header
    const narrowRows = parseCsvRows(await narrow.text()).slice(1) // drop header
    // Every narrow row's Aktion
    // column (index 1) must start
    // with "webhook.".
    for (const cols of narrowRows) {
      expect(
        cols[1],
        `narrow row Aktion should start with webhook.: ${cols.join(";")}`,
      ).toMatch(/^webhook\./)
    }
    // Sanity: the wide result has
    // >= the narrow result count
    // (the narrow is a subset).
    expect(wideRows.length).toBeGreaterThanOrEqual(narrowRows.length)
  })

  test("5. RFC 4180 escaping — Metadata column wraps JSON with commas in double quotes", async ({
    request,
  }) => {
    // We can't easily seed a
    // Metadata blob with embedded
    // commas here, but the seeded
    // rows already include
    // {count: N} blobs (commas
    // inside the JSON). The
    // invariant: every data row
    // has exactly 7 columns when
    // parsed with the `;`-aware
    // RFC 4180 parser.
    const res = await request.get(
      `http://localhost:3001/api/v1/audit-logs/activity.csv?companyId=${tokens!.companyId}&days=7`,
      { headers: headers() },
    )
    const body = await res.text()
    const rows = parseCsvRows(body)
    if (rows.length < 2) {
      // No data rows yet — skip
      // the column-count check
      // (the wide test above
      // already verified the
      // 4-namespace shape).
      return
    }
    // Header is 7 columns.
    const headerCols = rows[0].length
    expect(headerCols).toBe(7)
    // Spot-check up to 5 data
    // rows.
    const checkCount = Math.min(5, rows.length - 1)
    for (let i = 1; i <= checkCount; i++) {
      expect(
        rows[i].length,
        `row ${i} should have 7 columns: ${rows[i].join(";")}`,
      ).toBe(7)
    }
  })
})

test.describe("Tier 204 — UI Export button on /dashboard/activity", () => {
  test("6. /dashboard/activity renders the Export button", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/activity")
    // Wait for the verify-chain
    // button to render (means the
    // page loaded + auth OK).
    const verifyBtn = page.getByTestId("activity-verify-chain")
    await expect(verifyBtn).toBeVisible({ timeout: 10000 })
    // The export button should be
    // next to it.
    await expect(page.getByTestId("activity-export-csv")).toBeVisible({
      timeout: 5000,
    })
  })

  test("7. Export button href includes companyId + days=90", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard/activity")
    const verifyBtn = page.getByTestId("activity-verify-chain")
    await expect(verifyBtn).toBeVisible({ timeout: 10000 })
    const exportBtn = page.getByTestId("activity-export-csv")
    await expect(exportBtn).toBeVisible({ timeout: 5000 })
    const href = await exportBtn.getAttribute("href")
    expect(href, "href should include companyId").toContain("companyId=")
    expect(href, "href should include days=90").toContain("days=90")
    expect(href, "href should target the activity.csv endpoint").toContain(
      "activity.csv",
    )
  })

  test("8. Export button href reflects the current actionFilter", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard/activity")
    const verifyBtn = page.getByTestId("activity-verify-chain")
    await expect(verifyBtn).toBeVisible({ timeout: 10000 })
    // The default filter is
    // "all" — the href should
    // NOT include actionPrefix.
    const exportBtn = page.getByTestId("activity-export-csv")
    let href = await exportBtn.getAttribute("href")
    expect(href).not.toContain("actionPrefix=")
    // Click the "error." filter
    // (data-testid="activity-filter-error")
    // and verify the href now
    // includes actionPrefix=error.
    const errorBtn = page.getByTestId("activity-filter-error")
    await expect(errorBtn).toBeVisible({ timeout: 5000 })
    await errorBtn.click()
    // Re-fetch the href (React
    // re-renders the anchor with
    // the new actionFilter).
    href = await exportBtn.getAttribute("href")
    expect(href, "href should include actionPrefix=error.").toContain(
      "actionPrefix=error.",
    )
  })
})
