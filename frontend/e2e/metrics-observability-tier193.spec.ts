/**
 * Tier 193 — Prometheus /metrics + /health/summary + dashboard widget
 *
 * Covers the observability tier end-to-end:
 *   1. GET /metrics returns prom text format with all
 *      Tier 193 business gauges
 *   2. GET /api/v1/health/summary returns the JSON
 *      shape the dashboard widget reads
 *   3. The dashboard page renders the System Health
 *      widget with the expected data-testid hooks
 *   4. A DB outage (simulated by killing the docker
 *      container briefly) flips the status to "down"
 *      and the widget to "Nicht verfügbar" — but
 *      this 4th test is OUT OF SCOPE for the e2e
 *      (it would crash other concurrent tests by
 *      killing PG). The status-down path is
 *      verified by unit-style endpoint assertion
 *      on the /health/summary response when DB
 *      returns 0.
 *
 * Tier 193 deliberately tests through real HTTP
 * paths (not via service mock) — the prom text
 * format, the JSON shape, and the widget render
 * are all part of the contract.
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

test.describe("Tier 193 — Prometheus /metrics", () => {
  test("1. /metrics returns prom text format with all business gauges", async ({
    request,
  }) => {
    const res = await request.get("http://localhost:3001/metrics")
    expect(res.status()).toBe(200)
    const ct = res.headers()["content-type"] || ""
    // prom text format starts with `text/plain; version=0.0.4`
    expect(ct, `unexpected content-type: ${ct}`).toContain("text/plain")

    const body = await res.text()
    // System gauges
    expect(body, "missing uptime gauge").toMatch(/^de_invoice_uptime_seconds\s+\d+(\.\d+)?$/m)
    expect(body, "missing DB gauge").toMatch(/^de_invoice_db_connected\s+[01]$/m)
    expect(body, "missing storage gauge").toMatch(/^de_invoice_storage_writable\s+[01]$/m)
    expect(body, "missing build_info").toContain("de_invoice_build_info{")
    // Tier 193 business gauges
    expect(body, "missing business_companies").toMatch(/^de_invoice_business_companies\s+\d+$/m)
    expect(body, "missing business_users").toMatch(/^de_invoice_business_users\s+\d+$/m)
    expect(body, "missing business_invoices").toMatch(/^de_invoice_business_invoices\s+\d+$/m)
    expect(body, "missing business_customers").toMatch(/^de_invoice_business_customers\s+\d+$/m)
    // HTTP metrics
    expect(body, "missing http_requests_total counter").toMatch(
      /^de_invoice_http_requests_total\{/m,
    )
    // HELP / TYPE comments for the new gauges
    expect(body, "missing HELP for business_companies").toContain(
      "# HELP de_invoice_business_companies",
    )
    expect(body, "missing TYPE for business_companies").toContain(
      "# TYPE de_invoice_business_companies gauge",
    )
  })

  test("2. business counts are non-zero (DB has data)", async ({ request }) => {
    const res = await request.get("http://localhost:3001/metrics")
    const body = await res.text()
    const matchInvoices = body.match(/^de_invoice_business_invoices\s+(\d+)$/m)
    expect(matchInvoices, "business_invoices line missing").not.toBeNull()
    const n = Number(matchInvoices![1])
    expect(n, `expected invoices > 0, got ${n}`).toBeGreaterThan(0)
  })

  test("3. /metrics is flat path (no /api/v1 prefix)", async ({ request }) => {
    // Prometheus scrapers use a flat path. The main.ts
    // setGlobalPrefix excludes 'metrics'. Verifying
    // that /api/v1/metrics 404s proves the exclusion
    // is wired correctly.
    const noPrefix = await request.get("http://localhost:3001/metrics")
    expect(noPrefix.status()).toBe(200)
    const withPrefix = await request.get("http://localhost:3001/api/v1/metrics")
    expect(withPrefix.status(), "/api/v1/metrics should 404").toBe(404)
  })
})

test.describe("Tier 193 — /api/v1/health/summary", () => {
  test("4. returns the dashboard-friendly JSON shape", async ({ request }) => {
    const res = await request.get("http://localhost:3001/api/v1/health/summary")
    expect(res.status()).toBe(200)
    const body = await res.json()
    // Top-level keys
    expect(body).toHaveProperty("status")
    expect(body).toHaveProperty("version")
    expect(body).toHaveProperty("uptimeSec")
    expect(body).toHaveProperty("dbOk")
    expect(body).toHaveProperty("storageOk")
    expect(body).toHaveProperty("memory")
    expect(body).toHaveProperty("business")
    expect(body).toHaveProperty("timestamp")
    // status enum
    expect(["ok", "degraded", "down"]).toContain(body.status)
    // booleans
    expect(typeof body.dbOk).toBe("boolean")
    expect(typeof body.storageOk).toBe("boolean")
    // numeric
    expect(typeof body.uptimeSec).toBe("number")
    expect(body.uptimeSec).toBeGreaterThan(0)
    // memory sub-shape
    expect(typeof body.memory.rssMB).toBe("number")
    expect(typeof body.memory.heapMB).toBe("number")
    expect(body.memory.rssMB).toBeGreaterThan(0)
    // business sub-shape
    expect(typeof body.business.companies).toBe("number")
    expect(typeof body.business.users).toBe("number")
    expect(typeof body.business.invoices).toBe("number")
    expect(typeof body.business.customers).toBe("number")
  })

  test("5. healthy status with DB up + storage up", async ({ request }) => {
    const res = await request.get("http://localhost:3001/api/v1/health/summary")
    const body = await res.json()
    expect(body.status, "expected status=ok").toBe("ok")
    expect(body.dbOk, "expected dbOk=true").toBe(true)
    expect(body.storageOk, "expected storageOk=true").toBe(true)
  })

  test("6. does NOT require auth (public health probe)", async ({ request }) => {
    // Same endpoint, no cookies. The /health summary
    // is intentionally unauthenticated so monitoring
    // tools can poll it without Mandant context.
    const res = await request.get("http://localhost:3001/api/v1/health/summary")
    expect(res.status()).toBe(200)
  })
})

test.describe("Tier 193 — Dashboard System Health widget", () => {
  test("7. dashboard renders the System Health card with all 6 sub-widgets", async ({
    page,
  }) => {
    await page.goto("http://localhost:3100/dashboard")
    // Wait for the system health widget to mount and
    // for the /health/summary fetch to resolve. The
    // status badge starts as "—" (loading) and flips
    // to one of 3 states once the API returns. We
    // poll for the badge to leave the "—" state.
    const status = page.getByTestId("system-health-status")
    await expect(status).toBeVisible({ timeout: 15000 })
    await expect
      .poll(
        async () => (await status.innerText()).trim(),
        { timeout: 15000, intervals: [200, 400, 800, 1500] },
      )
      .not.toBe("—")
    const statusText = (await status.innerText()).trim()
    expect(["Alles OK", "Eingeschränkt", "Nicht verfügbar"]).toContain(statusText)

    // All 6 sub-widgets should be present
    await expect(page.getByTestId("dashboard-system-health")).toBeVisible()
    await expect(page.getByTestId("system-health-uptime")).toBeVisible()
    await expect(page.getByTestId("system-health-db")).toBeVisible()
    await expect(page.getByTestId("system-health-storage")).toBeVisible()
    await expect(page.getByTestId("system-health-memory")).toBeVisible()
    await expect(page.getByTestId("system-health-companies")).toBeVisible()
    await expect(page.getByTestId("system-health-users")).toBeVisible()
    await expect(page.getByTestId("system-health-invoices")).toBeVisible()
    await expect(page.getByTestId("system-health-customers")).toBeVisible()
  })

  test("8. uptime renders as D / H / M format", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard")
    const uptime = page.getByTestId("system-health-uptime")
    await expect(uptime).toBeVisible({ timeout: 15000 })
    const text = await uptime.innerText()
    // German format: "0 T 13 Std 4 Min"
    expect(text, `uptime text "${text}" missing 'T'`).toMatch(/\d+\s+T\s/)
    expect(text).toMatch(/Std/)
    expect(text).toMatch(/Min/)
  })

  test("9. business counts render with locale labels", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard")
    await expect(page.getByTestId("system-health-invoices")).toBeVisible({ timeout: 15000 })
    const invText = await page.getByTestId("system-health-invoices").innerText()
    // German label "Rechnungen" should appear next to the count
    expect(invText, `invoices text "${invText}" missing 'Rechnungen'`).toContain("Rechnungen")
  })

  test("10. status badge color is green when status=ok", async ({ page }) => {
    await page.goto("http://localhost:3100/dashboard")
    const status = page.getByTestId("system-health-status")
    await expect(status).toHaveText(/Alles OK/, { timeout: 15000 })
    // Status=ok renders the green pill (bg-green-100 class).
    // We assert the class is present so a regression that
    // drops the class on the ok branch would be caught.
    const cls = (await status.getAttribute("class")) || ""
    expect(cls, "expected green classes on status=ok").toMatch(/green-100/)
  })
})
