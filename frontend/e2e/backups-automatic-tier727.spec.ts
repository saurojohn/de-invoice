/**
 * Tier 727 — the backup page shows what runs by itself: the database every
 * hour (its age, how many dumps are kept per tier), the files every hour
 * (age, count, earlier versions, „Dateien jetzt sichern“), and whether there
 * is a copy outside the server.
 *
 * The status itself is the backend's (spec 438, against throwaway
 * directories); this run's backend has none, so the page is given one.
 * (`E2E_API_URL` is not used here — the operator is the cached seed login.)
 */
import { test, expect } from "@playwright/test"
import { getTestEnv } from "./fixtures/test-env"

const API = process.env.E2E_API_URL || "http://localhost:3001"
void API

test("the automatic backups: database, files, off-site", async ({ context, page }) => {
  const { userId, companyId } = getTestEnv()
  await context.addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/", sameSite: "Lax" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/", sameSite: "Lax" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-21T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  const now = Date.now()
  await page.route("**/api/v1/admin/backups/status", (route) =>
    route.fulfill({
      json: {
        db: { configured: true, latestAt: new Date(now - 20 * 60_000).toISOString(), ageHours: 0.33, latestSizeBytes: 123456, counts: { hourly: 48, daily: 30, weekly: 12, monthly: 7 }, maxAgeHours: 3, ok: true },
        files: { configured: true, lastRunAt: new Date(now - 5 * 3_600_000).toISOString(), ageHours: 5, files: 1234, bytes: 52_428_800, versions: 3, maxAgeHours: 3, ok: false },
        offsite: { configured: false, remote: null },
      },
    }),
  )
  let mirrored = false
  await page.route("**/api/v1/admin/backups/files/run", (route) => {
    mirrored = true
    return route.fulfill({ json: { files: 1234, copied: 5, versioned: 0, bytes: 52_428_800, durationMs: 800 } })
  })
  await page.goto("/dashboard/backups")
  const card = page.getByTestId("backup-auto")
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("backup-auto-db")).toContainText("48 stündlich · 30 täglich · 12 wöchentlich · 7 monatlich")
  await expect(page.getByTestId("backup-auto-files")).toContainText("1234 Dateien")
  await expect(page.getByTestId("backup-auto-files")).toContainText("3 frühere Versionen")
  await expect(page.getByTestId("backup-auto-offsite")).toContainText("nicht eingerichtet")
  // the files 5 hours old: marked (red), the database fresh (green)
  const tones = await page.evaluate(() => [
    document.querySelector('[data-testid="backup-auto-db"] span')?.className ?? "",
    document.querySelector('[data-testid="backup-auto-files"] span')?.className ?? "",
  ])
  expect(tones[0]).toContain("emerald")
  expect(tones[1]).toContain("red")
  await page.getByTestId("backup-auto-files-run").click()
  await expect.poll(() => mirrored).toBe(true)
  await expect(page.locator("body")).toContainText("Dateien gesichert: 1234, davon 5 neu oder geändert")
})
