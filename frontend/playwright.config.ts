import { defineConfig, devices } from "@playwright/test"

// Tier 12: Playwright end-to-end UI tests.
//
// The e2e suite (backend/e2e/*.sh) tests
// the API contract. This config + the
// tests under e2e/ exercise the React
// pages in a real headless Chromium —
// hydration, layout, JSX errors, 404s
// on /dashboard/* routes, all the things
// a HTTP test can't see.
//
// Why Chromium-only (no Firefox / Webkit)?
//   - The dev environment is darwin-arm64
//     and we only ship chromium for the
//     same arch. Adding the other engines
//     doubles the install size.
//   - For the auth + customer CRUD flows
//     we want to verify, Chromium is
//     sufficient. The layout differences
//     in Webkit / Gecko are exercised by
//     the manual test pass.
//
// The config assumes:
//   - Backend at http://localhost:3001
//   - Frontend at http://localhost:3000
//   - Postgres already running (the
//     backend wouldn't have started
//     otherwise).
//   - Test user "info@shleder.de" exists
//     and matches the seed password.

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // single-user fixture; running in parallel would race
  forbidOnly: !!process.env.CI,
  // Tier 70: 1 retry in BOTH CI and local.
  // Reason: the dev server cold-compiles routes
  // on first hit (~10-15s for heavy pages), and
  // the global 600/60s throttler can 429 a
  // background fetch on a tight test burst.
  // A single retry absorbs both without making
  // the suite "always pass" — real failures
  // still fail twice.
  retries: 1,
  workers: 1,
  reporter: process.env.CI ? "list" : "list",
  // Tier 70: per-test timeout bumped to 120s.
  // A cold compile of the OCR upload page can
  // take 60-90s the very first time a test hits
  // it; combined with the throttler 429 + retry
  // the worst-case test is ~100s.
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
    // Tier 70: action timeout 15s, navigation 30s.
    // A cold-compile of /dashboard/expenses takes
    // ~12s the first time. The old 10/20 was right
    // on the edge — adding 50% headroom drops the
    // flake count significantly without slowing
    // the happy path meaningfully.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Don't load images by default — the
    // dashboard uses inline SVGs.
    // setOffline to true would skip
    // every fetch. We want full network.
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Tier 70: globalSetup that warms up the dev
  // servers before any test runs. The first test
  // to hit /dashboard/expenses (or any heavy
  // page) triggers a 10-15s cold compile; if we
  // pre-warm those routes here, the first real
  // test doesn't pay the cost. Best-effort:
  // if any request fails we log and continue —
  // the per-test retry will absorb the cold
  // compile in the worst case.
  globalSetup: "./e2e/global-setup.ts",
  // Don't start the webServer — the dev
  // backend + frontend are expected to
  // already be running (matches the e2e
  // bash pattern). The runner script
  // scripts/run-playwright.sh does the
  // boot + cleanup.
})