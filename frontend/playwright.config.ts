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
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
    // The Tier 12 EmptyState + ErrorBanner
    // animations take ~200ms. Wait a
    // bit longer than the default to
    // catch them mid-transition.
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
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
  // Don't start the webServer — the dev
  // backend + frontend are expected to
  // already be running (matches the e2e
  // bash pattern). The runner script
  // scripts/run-playwright.sh does the
  // boot + cleanup.
})