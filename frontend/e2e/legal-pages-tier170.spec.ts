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
 *   4. banner      — appears on first visit, accept
 *                    all persists to localStorage,
 *                    reload doesn't re-show
 *   5. withdrawal  — "Cookie-Einstellungen" button
 *                    reopens the banner so the user
 *                    can revoke consent (DSGVO Art.
 *                    7 (3) — easy withdrawal)
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

  test('4. cookie banner shows on first visit, persists after accept', async ({
    page,
  }) => {
    // Clear any pre-existing cookie consent so this
    // is genuinely a "first visit". The Tier 249
    // global-setup writes a cookie-consent entry to
    // storageState so subsequent tests don't see
    // the banner — but this test specifically
    // verifies the banner's first-visit UX.
    await page.addInitScript(() => {
      try { localStorage.removeItem('cookie-consent') } catch {}
    })
    await page.goto('/login')
    // First visit — banner must appear.
    const banner = page.getByTestId('cookie-banner')
    await expect(banner).toBeVisible()
    // Necessary category is always on and disabled.
    const necessary = page.getByTestId('cookie-cat-necessary')
    await expect(necessary).toBeVisible()
    const necessaryCheckbox = necessary.locator('input[type="checkbox"]')
    await expect(necessaryCheckbox).toBeChecked()
    await expect(necessaryCheckbox).toBeDisabled()

    // Click "Alle akzeptieren" — banner should hide AND
    // localStorage should have the consent record.
    await page.getByTestId('cookie-btn-accept').click()
    await expect(banner).not.toBeVisible()
    const stored = await page.evaluate(() =>
      localStorage.getItem('cookie-consent'),
    )
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!)
    expect(parsed.necessary).toBe(true)
    expect(parsed.analytics).toBe(true)
    expect(parsed.marketing).toBe(true)
    expect(typeof parsed.savedAt).toBe('string')

    // Reload — banner must NOT reappear (consent is
    // already on record).
    await page.reload()
    await expect(page.getByTestId('cookie-banner')).not.toBeVisible()
  })

  test('5. cookie banner withdrawal — "Nur notwendige" works', async ({
    page,
  }) => {
    // Clear cookie-consent so this is a "first
    // visit" (the Tier 249 global-setup writes one
    // by default; see test 4 for the same fix).
    await page.addInitScript(() => {
      try { localStorage.removeItem('cookie-consent') } catch {}
    })
    await page.goto('/login')
    const banner = page.getByTestId('cookie-banner')
    await expect(banner).toBeVisible()

    // User accepts all first, then withdraws to "only
    // necessary" — this is the DSGVO Art. 7 (3)
    // withdrawal path: it's just as easy to revoke
    // as to grant.
    await page.getByTestId('cookie-btn-accept').click()
    await expect(banner).not.toBeVisible()

    // Reopen via the footer button (the withdrawal entry
    // point — every page exposes it).
    await page
      .getByTestId('footer-link-cookie-settings')
      .click()
    await expect(banner).toBeVisible()

    // Reject all — analytics + marketing off, necessary
    // stays on.
    await page.getByTestId('cookie-btn-reject').click()
    await expect(banner).not.toBeVisible()
    const stored = await page.evaluate(() =>
      localStorage.getItem('cookie-consent'),
    )
    const parsed = JSON.parse(stored!)
    expect(parsed.necessary).toBe(true)
    expect(parsed.analytics).toBe(false)
    expect(parsed.marketing).toBe(false)
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
