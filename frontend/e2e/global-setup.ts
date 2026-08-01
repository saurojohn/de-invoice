/**
 * Tier 70: Playwright globalSetup.
 *
 * Pre-warms the Next.js dev server so the first
 * test in a suite run doesn't trigger a 10-15s
 * cold compile of the heavy routes. The dev
 * server compiles routes on first hit, and the
 * suite has historically had its first 1-2 tests
 * fail with "Element not visible in 10s" because
 * the page took 12s to render.
 *
 * Strategy: hit a small set of routes the suite
 * is known to exercise. The first GET compiles
 * the route, subsequent ones are fast. We use
 * simple curl (no auth) — the goal is to warm
 * the dev compile, not to fetch data.
 *
 * If any request fails (server not up yet,
 * network blip) we log + continue. The per-test
 * retry in playwright.config.ts is the safety
 * net for the rare case where a cold compile
 * happens mid-suite anyway.
 */

import { request } from "@playwright/test"

const BASE = process.env.BASE_URL || "http://localhost:3100"
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"

const WARM_ROUTES = [
  "/dashboard",
  "/dashboard/invoices",
  "/dashboard/customers",
  "/dashboard/products",
  "/dashboard/reports",
  "/dashboard/accounting",
  "/dashboard/expenses",
  "/dashboard/recurring-invoices",
  "/dashboard/mahnungen",
  "/dashboard/audit",
  // Tier 126: warm the 2 detail pages so the
  // cold compile doesn't race with the h1 wait
  // in the mobile-responsive spec. The detail
  // pages are heavier (Card layout + tab tables
  // for customer) and were the source of 20s+
  // h1 waits when first hit in a cold test.
  "/dashboard/invoices/11deeb35-7147-4bdc-86d9-a302b4f80f3e",
  "/dashboard/customers/b3f7b274-7696-44b8-9345-8bfd460b3e47",
]

const WARM_API_ROUTES = [
  "/api/v1/users/me/companies",
  "/api/v1/customers?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111",
  "/api/v1/invoices?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111",
  "/api/v1/products?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111",
  "/api/v1/recurring-invoices/stats?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111",
  "/api/v1/audit-logs/stats?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111",
  "/api/v1/reports/dashboard?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111",
]

export default async function globalSetup() {
  console.log(`[global-setup] warming dev server at ${BASE}`)

  // Warm the Next.js frontend routes. These
  // hits trigger the dev server's on-demand
  // compile + bundle for the route. The
  // second hit (any later test) is fast.
  for (const path of WARM_ROUTES) {
    try {
      const r = await fetch(`${BASE}${path}`, { redirect: "manual" })
      // 200/307/404/500 are all "compiled";
      // 502/503 mean the server is still down.
      if (r.status >= 502) {
        console.warn(
          `[global-setup] warm ${path} -> ${r.status} (server may be down)`,
        )
      } else {
        console.log(`[global-setup] warm ${path} -> ${r.status}`)
      }
    } catch (e: any) {
      console.warn(`[global-setup] warm ${path} failed: ${e.message}`)
    }
  }

  // Warm the backend's most-hit endpoints.
  // The auth header is optional for warm —
  // we just want the route compiled.
  for (const path of WARM_API_ROUTES) {
    try {
      const r = await fetch(`${API}${path}`, {
        headers: {
          "x-user-id": "8c6a9669-0069-4137-a842-a66fd1d178d6",
          "x-company-id": "ad257ec3-d319-479b-b870-3fe76e8f3111",
        },
      })
      console.log(`[global-setup] warm api ${path} -> ${r.status}`)
    } catch (e: any) {
      console.warn(`[global-setup] warm api ${path} failed: ${e.message}`)
    }
  }

  // Give Next.js a moment to finish any
  // pending compiles before the first test
  // fires. Without this, the first test can
  // race with a still-compiling route.
  await new Promise((r) => setTimeout(r, 2000))
  console.log(`[global-setup] done`)
}
