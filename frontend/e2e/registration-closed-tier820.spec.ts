import { test, expect } from "@playwright/test"
import { getTestEnv } from "./fixtures/test-env"

/**
 * Tier 820 — after the first company, new people by invitation only. The
 * operator (the seed admin: the oldest company's) closes the registration;
 * the home page and the sign-in form no longer offer it, /register says how
 * one comes in, an invitation link still opens its own form, and the
 * operator opens it again on „Systembetrieb“ (the user page until Tier 822).
 * Reopened after the test, as the other specs register companies.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"
const { userId, companyId } = getTestEnv()
const H = { "x-user-id": userId, "x-company-id": companyId }

test.afterAll(async ({ request }) => {
  await request.put(`${API}/api/v1/auth/registration`, { headers: H, data: { open: true } })
})

test("closed: no offer to register, /register explains, an invitation link is no registration", async ({ page, request }) => {
  const closed = await request.put(`${API}/api/v1/auth/registration`, { headers: H, data: { open: false } })
  expect(closed.status()).toBe(200)
  await page.addInitScript(() => {
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  })

  // signed out: the home page signs in, but offers no registration
  await page.goto("/")
  const box = page.getByTestId("home-login")
  await expect(box).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("login-invite-only")).toBeVisible()
  await expect(page.getByRole("button", { name: "Registrieren" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Starten" })).toHaveCount(0)

  await page.goto("/register")
  await expect(page.getByTestId("registration-closed")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByLabel("Firmenname")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Konto erstellen" })).toHaveCount(0)

  // an invitation link is no registration: it opens its own form
  await page.goto("/register?invite=not-a-real-token")
  await expect(page.getByText("Registrierung geschlossen")).toHaveCount(0)
})

// Tier 821a: a test of its own, signed in before its first page — in one test
// after the signed-out pages, the user page made no request at all for 90 s on
// the first attempt in CI, twice (the retry passed in 11 s)
test("the operator's user page: closed, and the button opens it", async ({ page, request }) => {
  expect((await request.put(`${API}/api/v1/auth/registration`, { headers: H, data: { open: false } })).status()).toBe(200)
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId })
  // the card is the operator's: wait for /auth/me, so that a failure says what it answered
  const me = page.waitForResponse((r) => r.url().includes("/api/v1/auth/me") && r.request().method() === "GET", { timeout: 90_000 })
  await page.goto("/dashboard/operator")
  const meBody = await (await me).json()
  expect(meBody.operator, `GET /auth/me as the seed admin: ${JSON.stringify({ role: meBody.role, operator: meBody.operator, companyId: meBody.companyId })}`).toBe(true)
  const card = page.getByTestId("registration-card")
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("registration-state")).toContainText("Geschlossen")
  await page.getByTestId("registration-toggle").click()
  await expect(page.getByTestId("registration-state")).toContainText("Offen")
  const state = await (await request.get(`${API}/api/v1/auth/registration`)).json()
  expect(state.open).toBe(true)
})

test("the admin of another company sees no such card", async ({ page, request }) => {
  const tag = `t820-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier820-e2e", companyName: `${tag} GmbH` },
  })).json()
  const uid: string = reg.user.id
  const cid: string = reg.user.companyId || reg.company.id
  await page.context().addCookies([
    { name: "x-user-id", value: uid, domain: "localhost", path: "/" },
    { name: "x-company-id", value: cid, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ uid, cid }: { uid: string; cid: string }) => {
    localStorage.setItem("userId", uid)
    localStorage.setItem("companyId", cid)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { uid, cid })
  await page.goto("/dashboard/settings/users")
  await expect(page.getByText(/Benutzer einladen|Benutzerverwaltung/).first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("registration-card")).toHaveCount(0)
  await expect(page.getByTestId("operator-page-link")).toHaveCount(0)
})
