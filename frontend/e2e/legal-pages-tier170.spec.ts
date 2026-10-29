/**
 * Tier 170 — Impressum + Datenschutz + CookieBanner e2e
 *
 * Covers the DSGVO / TDDDG compliance surface for the
 * public-facing legal pages:
 *   1. /impressum  — renders German heading + provider
 *                    name field (TMG § 5 mandatory)
 *   2. /datenschutz — renders German heading + 9
 *                     mandatory sections (DSGVO Art. 13
 *                     mandatory disclosures)
 *   3. footer      — Impressum/Datenschutz/Cookie-
 *                    Settings links present on every
 *                    page (TMG § 5 reachability)
 *   4. notice      — appears on first visit,
 *                    "Verstanden" persists to
 *                    localStorage, reload doesn't
 *                    re-show (Tier 735: a notice of
 *                    the necessary cookies, no
 *                    consent request)
 *   5. reopen      — the footer's "Cookies" and the
 *                    Datenschutz page show it again
 *
 * Why no auth: these pages are public, no login needed.
 * The footer + banner mount on every page (root layout).
 */
import { test, expect } from '@playwright/test'

test.describe('Tier 170 — Impressum + Datenschutz + CookieBanner', () => {
  test.beforeEach(async ({ context }) => {
    // Each test starts with a clean consent state so
    // the banner appears (the banner only shows when
    // localStorage has no `cookie-consent` key).
    await context.clearCookies()
  })

  test('1. /impressum renders German heading + provider section', async ({
    page,
  }) => {
    await page.goto('/impressum')
    // The heading is a German H1 — verify the
    // translation actually loaded (not the raw
    // key "legal.impressum.heading" which would
    // be the symptom of a missing JSON key).
    const heading = page.getByTestId('impressum-heading')
    await expect(heading).toBeVisible()
    await expect(heading).toHaveText('Impressum')
    // The "Provider" section is the TMG § 5 disclosure
    await expect(
      page.getByRole('heading', { name: 'Anbieter' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Anschrift' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Kontakt' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Streitschlichtung' }),
    ).toBeVisible()
  })

  test('2. /datenschutz renders all 9 mandatory sections', async ({ page }) => {
    await page.goto('/datenschutz')
    const heading = page.getByTestId('datenschutz-heading')
    await expect(heading).toBeVisible()
    await expect(heading).toHaveText('Datenschutzerklärung')

    // DSGVO Art. 13 mandatory headings (de.json keys)
    const mandatory = [
      'Verantwortlicher',
      'Erhobene Daten',
      'Zweck der Verarbeitung',
      'Speicherdauer',
      'Hosting & Server-Standort',
      'Datenübertragung',
      'Cookies & lokale Speicherung',
      'Ihre Rechte',
      'Änderungen dieser Erklärung',
    ]
    for (const h of mandatory) {
      await expect(
        page.getByRole('heading', { name: h }),
        `datenschutz must contain section: ${h}`,
      ).toBeVisible()
    }

    // The Controller section must link back to /impressum
    // (DSGVO requires the controller identity disclosed)
    const link = page.getByRole('link', { name: /Impressumsangaben/ })
    await expect(link).toHaveAttribute('href', '/impressum')
  })

  test('3. footer shows on every page with all 3 legal links', async ({
    page,
  }) => {
    // Check footer on 3 different pages to make sure
    // the root layout really did wire it globally.
    for (const path of ['/login', '/impressum', '/datenschutz']) {
      await page.goto(path)
      const footer = page.getByTestId('site-footer')
      await expect(footer).toBeVisible()
      await expect(
        page.getByTestId('footer-link-impressum'),
      ).toHaveAttribute('href', '/impressum')
      await expect(
        page.getByTestId('footer-link-datenschutz'),
      ).toHaveAttribute('href', '/datenschutz')
      await expect(
        page.getByTestId('footer-link-cookie-settings'),
      ).toBeVisible()
    }
  })

  test('4. cookie notice shows on first visit, persists after "Verstanden"', async ({
    page,
  }) => {
    // Clear any pre-existing record so this is genuinely a "first visit". The
    // Tier 249 global-setup writes a cookie-consent entry to storageState so
    // the other tests don't see the notice.
    //
    // Tier 432: only on the tab's FIRST load. An init script runs on every
    // navigation, the reload below included — it wiped the record again, so
    // the "must not reappear" check passed only when it ran before the
    // notice's mount effect (flaky: Tier 423 and 432 runs).
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('t170-cleared')) {
          localStorage.removeItem('cookie-consent')
          sessionStorage.setItem('t170-cleared', '1')
        }
      } catch {}
    })
    await page.goto('/login')
    const banner = page.getByTestId('cookie-banner')
    await expect(banner).toBeVisible()
    // Tier 735: a notice of what is stored, not a consent request — the
    // application sets no analytics or marketing cookies, so there is
    // nothing to opt into (§ 25 Abs. 2 Nr. 2 TDDDG).
    await expect(page.getByTestId('cookie-banner-text')).toContainText('nur technisch notwendige Cookies')
    await expect(banner).toContainText('keine Analyse- oder Werbe-Cookies')
    await expect(banner.locator('input[type="checkbox"]')).toHaveCount(0)
    await expect(page.getByTestId('cookie-btn-accept')).toHaveCount(0)

    await page.getByTestId('cookie-btn-ok').click()
    await expect(banner).not.toBeVisible()
    const parsed = JSON.parse((await page.evaluate(() => localStorage.getItem('cookie-consent')))!)
    expect(parsed).toEqual({ necessary: true, savedAt: expect.any(String) })

    // Reload — the notice must NOT reappear. Wait until the page has settled
    // so its mount effect has run — a "not visible" checked before it proves
    // nothing.
    await page.reload()
    await page.waitForLoadState('networkidle')
    expect(await page.evaluate(() => localStorage.getItem('cookie-consent'))).not.toBeNull()
    await expect(page.getByTestId('cookie-banner')).not.toBeVisible()
  })

  test('5. the footer and the Datenschutz page open the notice again; an old consent record counts as seen', async ({
    page,
  }) => {
    // A record the old consent dialog wrote (before Tier 735): not asked again.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('cookie-consent', JSON.stringify({ necessary: true, analytics: true, marketing: false, savedAt: '2026-01-01T00:00:00.000Z' }))
      } catch {}
    })
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    const banner = page.getByTestId('cookie-banner')
    await expect(banner).not.toBeVisible()

    await page.getByTestId('footer-link-cookie-settings').click()
    await expect(banner).toBeVisible()
    await page.getByTestId('cookie-btn-ok').click()
    await expect(banner).not.toBeVisible()

    await page.goto('/datenschutz')
    await expect(page.getByText('Analyse- oder Werbe-Cookies und Tracking gibt es nicht')).toBeVisible()
    await page.getByTestId('datenschutz-open-cookie-settings').click()
    await expect(banner).toBeVisible()
  })

  test('6. mobile 375x667 — pages do not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/impressum')
    // scrollWidth must not exceed viewport (no horizontal
    // overflow on mobile — this is the same check the
    // other tier specs use).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth,
    )
    expect(overflow).toBeLessThanOrEqual(375)

    await page.goto('/datenschutz')
    const overflow2 = await page.evaluate(
      () => document.documentElement.scrollWidth,
    )
    expect(overflow2).toBeLessThanOrEqual(375)
  })
})
