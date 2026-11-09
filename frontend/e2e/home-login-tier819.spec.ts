import { test, expect } from "@playwright/test"

/**
 * Tier 819 — signing in on the home page, without the extra /login page (the
 * owner asked for it). The form is the one of /login (components/LoginForm):
 * a wrong password says so, the right one opens the dashboard, and a signed-in
 * browser is offered the dashboard instead of the form.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the home page signs in", async ({ page, request }) => {
  const tag = `t819-${Date.now()}`
  const email = `${tag}@example.test`
  const password = "Tier819-e2e"
  const reg = await request.post(`${API}/api/v1/auth/register`, {
    data: { email, password, companyName: `${tag} GmbH` },
  })
  expect(reg.status()).toBe(201)
  await page.addInitScript(() => {
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  })

  await page.goto("/")
  const box = page.getByTestId("home-login")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await expect(box).toBeInViewport()

  // a wrong password: the message, and still the home page
  await box.getByLabel("E-Mail").fill(email)
  await box.getByLabel("Passwort").fill("falsch-falsch")
  await box.getByRole("button", { name: "Anmelden" }).click()
  await expect(box.getByRole("alert")).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  // the right one: the dashboard
  await box.getByLabel("Passwort").fill(password)
  await box.getByRole("button", { name: "Anmelden" }).click()
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 })

  // signed in: the home page offers the dashboard, not the form
  await page.goto("/")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await expect(box.getByLabel("Passwort")).toHaveCount(0)
  await expect(page.getByTestId("home-to-dashboard")).toBeVisible()
})

test("on a phone the form comes first", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/")
  const box = page.getByTestId("home-login")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await expect(box.getByLabel("E-Mail")).toBeInViewport()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, "no sideways scrolling").toBeLessThanOrEqual(0)
})
