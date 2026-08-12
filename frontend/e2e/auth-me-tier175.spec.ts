/**
 * Tier 175 — GET /api/v1/auth/me
 *
 * Phase 3 Berater-Walkthrough finding: there was no
 * endpoint to ask the server "who am I + which companies
 * am I allowed to access?". The frontend kept
 * `x-user-id` + `x-company-id` in localStorage from a
 * prior login and used them blindly.
 *
 * The HeaderAuthGuard already verifies UserCompany
 * membership (line 58-70 in header-auth.guard.ts), so
 * the security risk is narrow. But /me is the canonical
 * "what does the server think I am" check the frontend
 * should call on every page load to:
 *   1. Re-validate the session (don't trust stale
 *      localStorage if the user was deactivated).
 *   2. Populate the Mandant switcher with the full
 *      list of granted companies.
 *   3. Show the user their global role vs per-company
 *      role.
 *
 * Tests:
 *   1. Unauthenticated request → 401
 *   2. Wrong x-user-id (real user, wrong company)
 *      → 401 (HeaderAuthGuard UserCompany check)
 *   3. Authenticated request returns the expected shape
 *      (id, email, role, status, companies[])
 *   4. Per-company role is returned (not the global role)
 *   5. Inactive user is rejected even with valid headers
 *      (this would require deactivating the test user, so
 *      we cover the 401 case only)
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

test.describe("Tier 175 — GET /api/v1/auth/me", () => {
  test("1. unauthenticated request: missing headers → 401", async ({ request }) => {
    const res = await request.get(`http://localhost:3001/api/v1/auth/me`)
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
  })

  test("2. wrong x-company-id (user without grant) → 401", async ({ request }) => {
    // Use a made-up companyId that the test user
    // definitely has no UserCompany row for. The
    // HeaderAuthGuard should reject this with 401
    // "Kein Zugriff auf diese Firma".
    const res = await request.get(`http://localhost:3001/api/v1/auth/me`, {
      headers: {
        "x-user-id": tokens!.userId,
        "x-company-id": "00000000-0000-0000-0000-000000000000",
      },
    })
    expect(res.status(), `expected 401, got ${res.status()}`).toBe(401)
    const body = await res.text()
    // The error message should mention the cross-tenant
    // denial, not just a generic auth error.
    expect(body, `expected cross-tenant error message, got: ${body}`).toMatch(
      /Kein Zugriff|firma/i,
    )
  })

  test("3. authenticated request: returns id, email, role, companies[]", async ({ request }) => {
    const res = await request.get(`http://localhost:3001/api/v1/auth/me`, {
      headers: {
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
    })
    expect(res.status(), `expected 200, got ${res.status()}`).toBe(200)
    const body = await res.json()

    // Required fields
    expect(body.id, "id field missing").toBeTruthy()
    expect(body.email, "email field missing").toBeTruthy()
    expect(typeof body.role, "role field should be string").toBe("string")
    expect(body.status, "status field missing").toBe("active")
    expect(Array.isArray(body.companies), "companies should be array").toBe(true)

    // At least the active company must be in the
    // companies list. The user might have more
    // (multi-Mandant Berater), but never fewer.
    const activeCo = body.companies.find((c: any) => c.id === tokens!.companyId)
    expect(activeCo, `active company ${tokens!.companyId} not in companies[]`).toBeTruthy()
    expect(activeCo.role, "active company must have a role").toBeTruthy()
  })

  test("4. per-company role is returned (Tier 66 semantics)", async ({ request }) => {
    const res = await request.get(`http://localhost:3001/api/v1/auth/me`, {
      headers: {
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    // The test user info@shleder.de is 'admin' on the
    // SH Leder GmbH Mandant. If the response.role is
    // something else, the per-company override broke.
    expect(body.role, `expected admin, got ${body.role}`).toBe("admin")
  })

  test("5. response shape: no sensitive fields leaked", async ({ request }) => {
    const res = await request.get(`http://localhost:3001/api/v1/auth/me`, {
      headers: {
        "x-user-id": tokens!.userId,
        "x-company-id": tokens!.companyId,
      },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    // SECURITY: never leak passwordHash / passwordResetToken /
    // passwordResetExpires. The /me endpoint is authenticated
    // but we still don't echo back the bcrypt hash.
    expect(body.passwordHash, "passwordHash MUST NOT be in response").toBeUndefined()
    expect(body.passwordResetToken, "passwordResetToken MUST NOT be in response").toBeUndefined()
    expect(body.passwordResetExpires, "passwordResetExpires MUST NOT be in response").toBeUndefined()
  })
})
