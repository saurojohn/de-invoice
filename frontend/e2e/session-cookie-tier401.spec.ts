/**
 * Playwright spec — Tier 401: the browser signs in with a session cookie.
 *
 * Until Tier 400 the browser's credential was `x-user-id`, read from
 * localStorage and sent on every request (HANDOFF §9 item 10). Tier 400 gave
 * the backend sessions; this tier moves the browser onto them.
 *
 * Measured before the change, logging in through the real form:
 *   - the response carried no Set-Cookie and no session
 *   - every dashboard request carried `x-user-id: <uuid>`
 *   - deleting that id from localStorage logged the user out
 *   - "Abmelden" only cleared localStorage; nothing was revoked server-side
 *
 * These tests drive the actual login form — no injected auth — because the
 * point is what the browser does, not what curl can do.
 */
import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function seedCompanyId(): string {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const m = env.match(/^COMPANY_ID=(.*)$/m)
  return m ? m[1] : ""
}

/** Sign in the way a person does. Returns once the dashboard has rendered. */
async function signInThroughTheForm(page: any) {
  await page.goto("/login")
  await page.locator('input[type="email"]').fill("info@shleder.de")
  await page.locator('input[type="password"]').fill("Test1234!")
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 })
}

test.describe("Tier 401 — the browser's credential is the session cookie", () => {
  test("1. logging in sets an httpOnly session cookie the page cannot read", async ({
    page,
  }) => {
    await signInThroughTheForm(page)

    const cookies = await page.context().cookies()
    const session = cookies.find((c: any) => c.name === "de_session")
    expect(session, "login set no de_session cookie").toBeTruthy()
    expect(session!.httpOnly).toBe(true)
    expect(session!.value.length).toBe(64)

    // The whole point of httpOnly: script on the page cannot read it, so an
    // XSS cannot walk off with the credential the way it could with the id in
    // localStorage.
    const readable = await page.evaluate(() => document.cookie)
    expect(readable).not.toContain("de_session")

    // And the token is never mirrored into storage either.
    const stored = await page.evaluate(() =>
      JSON.stringify(Object.entries(localStorage)),
    )
    expect(stored).not.toContain(session!.value)
  })

  test("2. after login the browser stops sending x-user-id entirely", async ({
    page,
  }) => {
    await signInThroughTheForm(page)

    const seen: { url: string; userId: string | undefined }[] = []
    page.on("request", (req: any) => {
      if (req.url().includes("/api/v1/")) {
        seen.push({ url: req.url(), userId: req.headers()["x-user-id"] })
      }
    })
    await page.goto("/dashboard/customers")
    await page.waitForLoadState("networkidle")

    expect(seen.length, "no API calls observed").toBeGreaterThan(0)
    const withHeader = seen.filter((r) => r.userId)
    expect(
      withHeader.map((r) => r.url),
      "requests still carrying the forgeable id",
    ).toEqual([])
  })

  test("3. the dashboard works with the cookie alone (no id in localStorage)", async ({
    page,
  }) => {
    await signInThroughTheForm(page)

    // Drop the id the old credential came from. `companyId` stays — it is the
    // Mandant selector, not a credential, and the backend validates it against
    // UserCompany. If anything still authenticated by header, this page would
    // 401 and the api helper would bounce us to /login.
    await page.evaluate(() => localStorage.removeItem("userId"))
    await page.goto("/dashboard/customers")
    await page.waitForLoadState("networkidle")

    expect(page.url()).toContain("/dashboard/customers")
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 })
  })

  test("4. Abmelden revokes the session server-side", async ({ page }) => {
    await signInThroughTheForm(page)
    const before = (await page.context().cookies()).find(
      (c: any) => c.name === "de_session",
    )
    expect(before).toBeTruthy()
    const token = before!.value
    const companyId = seedCompanyId()

    // The token works right now…
    const ctx = page.request
    const okRes = await ctx.get(`${API}/api/v1/customers?companyId=${companyId}`, {
      headers: { cookie: `de_session=${token}`, "x-company-id": companyId },
    })
    expect(okRes.status()).toBe(200)

    await page.getByRole("button", { name: /Abmelden|Logout|退出/i }).first().click()
    await page.waitForURL(/\/login/, { timeout: 30_000 })

    // …and is dead afterwards. Before Tier 401 the button only cleared
    // localStorage, so this same token stayed valid for its full 30 days.
    const deadRes = await ctx.get(`${API}/api/v1/customers?companyId=${companyId}`, {
      headers: { cookie: `de_session=${token}`, "x-company-id": companyId },
    })
    expect(deadRes.status()).toBe(401)
  })
})
